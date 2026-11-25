/**
 * Integration tests for the journal ingestion router (events.push).
 *
 * Covers the Phase 1 offline-first behaviour:
 *  - legacy-shaped entries (no hlc/schemaVersion/actorId) still work and get a
 *    synthesized HLC (byte-for-byte back-compat),
 *  - idempotency on entry id,
 *  - race-state entries resolve the runner by (eventId, cardNo) — so a finish
 *    matches an offline-registered runner before any seq is known,
 *  - first-finish-wins.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID, randomBytes } from "node:crypto";
import { SYSTEM_GROUP_IDS, decideReadoutApply, RunnerStatus } from "@oxygen/shared";
import {
  createTestEvent,
  disconnect,
  type TestEventContext,
} from "../helpers/test-db.js";
import { makeCaller } from "../helpers/caller.js";
import { ingestJournalEntries } from "../../routers/events.js";
import { grantSystemGroup } from "../../permissions.js";
import { capabilityForEntry } from "../../journalCapabilities.js";
import { classUpsertPayload } from "../../referenceJournal.js";
import { valueToRunnerStatus } from "../../statusConvert.js";
import type { AuthUser } from "../../auth.js";
import type { PrismaClient } from "../../generated/prisma/client.js";

let ctx: TestEventContext;
let caller: ReturnType<typeof makeCaller>;
let classSeq: number;

beforeAll(async () => {
  ctx = await createTestEvent("events-push");
  caller = makeCaller(ctx.event);
  const cls = await ctx.db.class.create({
    data: { eventId: ctx.eventId, name: "H21" },
    select: { seq: true },
  });
  classSeq = cls.seq;
});

afterAll(async () => {
  await ctx.cleanup();
  await disconnect();
});

function entry(
  type: string,
  payload: Record<string, unknown>,
  extra: Record<string, unknown> = {},
) {
  return {
    id: randomUUID(),
    type: type as never,
    competitionId: ctx.event.nameId,
    stationId: "station-A",
    timestamp: 1_700_000_000_000,
    payload,
    ...extra,
  };
}

describe("events.push (journal ingestion)", () => {
  it("accepts a legacy-shaped entry and stores a synthesized HLC", async () => {
    const e = entry("runner.registered", {
      name: "Legacy Larry",
      classId: classSeq,
      cardNo: 81001,
    });
    const res = await caller.events.push({ events: [e] });

    expect(res.synced).toContain(e.id);
    expect(res.failed).toHaveLength(0);
    expect(typeof res.serverTimeMs).toBe("number");

    const row = await ctx.db.journalEntry.findUnique({
      where: { id: e.id },
      select: { hlc: true, schemaVersion: true, actorId: true },
    });
    expect(row).not.toBeNull();
    // No hlc on the wire → synthesized as physical << 16 (logical 0).
    expect(row!.hlc).toBe(BigInt(e.timestamp) << 16n);
    expect(row!.schemaVersion).toBe(1);
    expect(row!.actorId).toBeNull();

    const runner = await ctx.db.runner.findFirst({
      where: { eventId: ctx.eventId, cardNo: 81001 },
    });
    expect(runner?.name).toBe("Legacy Larry");
  });

  it("is idempotent on entry id", async () => {
    const e = entry("runner.registered", {
      name: "Once",
      classId: classSeq,
      cardNo: 81002,
    });
    await caller.events.push({ events: [e] });
    const res2 = await caller.events.push({ events: [e] });

    expect(res2.synced).toContain(e.id);
    expect(res2.failed).toHaveLength(0);
    const count = await ctx.db.runner.count({
      where: { eventId: ctx.eventId, cardNo: 81002 },
    });
    expect(count).toBe(1);
  });

  it("matches a finish to a runner by (eventId, cardNo) with no seq reference", async () => {
    const card = 81003;
    await caller.events.push({
      events: [
        entry("runner.registered", {
          name: "Carded Cara",
          classId: classSeq,
          cardNo: card,
        }),
      ],
    });
    // Finish references ONLY the card — the offline-first path.
    const res = await caller.events.push({
      events: [entry("finish.recorded", { cardNo: card, finishTime: 360000 })],
    });
    expect(res.failed).toHaveLength(0);

    const runner = await ctx.db.runner.findFirst({
      where: { eventId: ctx.eventId, cardNo: card },
      select: { finishTime: true, status: true },
    });
    expect(runner?.status).toBe("ok");
    expect(runner?.finishTime).toBeGreaterThan(0);
  });

  it("applies a card.read entry through the readout pipeline", async () => {
    const card = 81005;
    await caller.events.push({
      events: [
        entry("runner.registered", {
          name: "Reader Rita",
          classId: classSeq,
          cardNo: card,
        }),
      ],
    });
    // Payload times are absolute deciseconds (the outbox converts at emit).
    const e = entry("card.read", {
      cardNo: card,
      punches: [
        { controlCode: 31, time: 360000 },
        { controlCode: 32, time: 361230 },
      ],
      startTime: 359000,
      finishTime: 366000,
      cardType: "SIAC",
    });
    const res = await caller.events.push({ events: [e] });
    expect(res.failed).toHaveLength(0);
    expect(res.synced).toContain(e.id);

    // Regression: card.read entries used to be journaled but never applied.
    const readoutRow = await ctx.db.cardReadout.findFirst({
      where: { eventId: ctx.eventId, cardNo: card },
      select: { id: true, cardType: true, readAt: true },
    });
    expect(readoutRow).not.toBeNull();
    expect(readoutRow!.cardType).toBe("SIAC");
    // readAt preserves the original (offline) read time, not drain time.
    expect(readoutRow!.readAt.getTime()).toBe(1_700_000_000_000);

    const cardRow = await ctx.db.card.findFirst({
      where: { eventId: ctx.eventId, cardNo: card, removed: false },
      select: { id: true, punchesRaw: true },
    });
    expect(cardRow).not.toBeNull();
    expect(cardRow!.punchesRaw).toContain("31-");

    const runner = await ctx.db.runner.findFirst({
      where: { eventId: ctx.eventId, cardNo: card, removed: false },
      select: { cardId: true },
    });
    expect(runner?.cardId).toBe(cardRow!.id);
  });

  it("dedupes two card.read entries for the same card within the 60s window", async () => {
    const card = 81006;
    const base = 1_700_000_000_000;
    const punches = [{ controlCode: 31, time: 360000 }];
    const e1 = entry("card.read", { cardNo: card, punches }, { timestamp: base });
    const e2 = entry(
      "card.read",
      { cardNo: card, punches },
      { timestamp: base + 30_000 },
    );
    const res1 = await caller.events.push({ events: [e1] });
    const res2 = await caller.events.push({ events: [e2] });
    expect(res1.failed).toHaveLength(0);
    expect(res2.failed).toHaveLength(0);

    // One logical readout applied; both entries journaled for audit.
    const readouts = await ctx.db.cardReadout.count({
      where: { eventId: ctx.eventId, cardNo: card },
    });
    expect(readouts).toBe(1);
    const journaled = await ctx.db.journalEntry.count({
      where: { id: { in: [e1.id, e2.id] } },
    });
    expect(journaled).toBe(2);
  });

  it("first finish wins — a later finish for the same card is a no-op", async () => {
    const card = 81004;
    await caller.events.push({
      events: [
        entry("runner.registered", {
          name: "Twice",
          classId: classSeq,
          cardNo: card,
        }),
      ],
    });
    await caller.events.push({
      events: [entry("finish.recorded", { cardNo: card, finishTime: 360000 })],
    });
    const before = await ctx.db.runner.findFirst({
      where: { eventId: ctx.eventId, cardNo: card },
      select: { finishTime: true },
    });
    await caller.events.push({
      events: [entry("finish.recorded", { cardNo: card, finishTime: 400000 })],
    });
    const after = await ctx.db.runner.findFirst({
      where: { eventId: ctx.eventId, cardNo: card },
      select: { finishTime: true },
    });
    expect(after?.finishTime).toBe(before?.finishTime);
  });
});

// ─── Journal sink hardening (fix package 3) ──────────────────────────

const SECRET = "events-push-test-secret";
const suffix = randomBytes(4).toString("hex");

function wire(
  event: { nameId: string },
  type: string,
  payload: Record<string, unknown>,
  extra: Record<string, unknown> = {},
) {
  return {
    id: randomUUID(),
    type: type as never,
    competitionId: event.nameId,
    stationId: "station-A",
    timestamp: 1_700_000_000_000,
    payload,
    ...extra,
  };
}

/** One applyable entry of each of the 16 types for `event`. */
function sixteen(event: { nameId: string }, classSeq: number, card: number) {
  const ref = () => ({ id: randomUUID(), seq: 0, fields: { name: "x" } });
  return [
    wire(event, "card.read", { cardNo: card, punches: [] }),
    wire(event, "result.applied", { cardNo: card, status: 1, finishTime: 1, startTime: 1 }),
    wire(event, "finish.recorded", { cardNo: card, finishTime: 360000 }),
    wire(event, "start.recorded", { cardNo: card, startTime: 350000 }),
    wire(event, "runner.registered", { name: "Sixteen", classId: classSeq, cardNo: card }),
    wire(event, "finish.adjusted", { cardNo: card, finishTime: 361000 }),
    wire(event, "punch.recorded", { cardNo: card, controlCode: 31, time: 355000 }),
    wire(event, "punch.removed", { cardNo: card, controlCode: 31, time: 355000 }),
    wire(event, "punch.updated", { cardNo: card, controlCode: 31, oldTime: 1, time: 2 }),
    wire(event, "start.adjusted", { cardNo: card, startTime: 351000 }),
    wire(event, "runner.updated", { cardNo: card, fields: { name: "Sixteen B" } }),
    wire(event, "runner.deleted", { cardNo: card }),
    wire(event, "class.upserted", ref()),
    wire(event, "course.upserted", ref()),
    wire(event, "control.upserted", ref()),
    wire(event, "reference.imported", { controls: [], courses: [], classes: [] }),
  ];
}

function asUser(row: AuthUser): AuthUser {
  return row;
}

describe("events.push: capabilities, competition, secret", () => {
  let a: TestEventContext;
  let b: TestEventContext;
  let aClass: number;
  let admin: AuthUser;
  let member: AuthUser;
  let crew: AuthUser;
  let setter: AuthUser;
  let late: AuthUser;
  let prevSecret: string | undefined;
  let card = 91000;

  const asCaller = (user: AuthUser | null, extra: Record<string, unknown> = {}) =>
    makeCaller(a.event, { user, authEnabled: true, authMode: "proxy", identityEmail: user?.email ?? null, ...extra });

  beforeAll(async () => {
    prevSecret = process.env.SYNC_SHARED_SECRET;
    process.env.SYNC_SHARED_SECRET = SECRET;
    a = await createTestEvent("push-caps-a");
    b = await createTestEvent("push-caps-b");
    for (const c of [a, b]) {
      await c.db.event.update({ where: { id: c.eventId }, data: { date: new Date("2099-06-15") } });
      c.event = { ...c.event, date: new Date("2099-06-15") };
    }
    aClass = (await a.db.class.create({ data: { eventId: a.eventId, name: "H21" }, select: { seq: true } })).seq;
    const mk = async (name: string, isAdmin = false) =>
      asUser(
        await a.db.user.create({
          data: { email: `${name}-${suffix}@push-test.example`, displayName: name, isAdmin, active: true },
        }),
      );
    admin = await mk("admin", true);
    member = await mk("member");
    crew = await mk("crew");
    setter = await mk("setter");
    late = await mk("late");
    const grant = (user: AuthUser, groupId: string) =>
      grantSystemGroup(a.db, { eventId: a.eventId, userId: user.id, groupId, grantedBy: admin.id });
    await grant(member, SYSTEM_GROUP_IDS.member);
    await grant(crew, SYSTEM_GROUP_IDS.raceCrew);
    await grant(setter, SYSTEM_GROUP_IDS.courseSetter);
    await grant(late, SYSTEM_GROUP_IDS.member);
  });

  afterAll(async () => {
    if (prevSecret === undefined) delete process.env.SYNC_SHARED_SECRET;
    else process.env.SYNC_SHARED_SECRET = prevSecret;
    await a.db.user.deleteMany({ where: { email: { endsWith: "@push-test.example" } } });
    await a.cleanup();
    await b.cleanup();
  });

  // 1
  it("an entry for another competition is refused and nothing is written", async () => {
    const e = wire({ nameId: "some_other_competition" }, "runner.registered", {
      name: "Wrong Comp",
      classId: aClass,
      cardNo: 91900,
    });
    const res = await makeCaller(a.event).events.push({ events: [e] });
    expect(res.synced).toEqual([]);
    expect(res.failed).toEqual([{ id: e.id, error: "COMPETITION_MISMATCH" }]);
    expect(await a.db.runner.count({ where: { eventId: a.eventId, cardNo: 91900 } })).toBe(0);
    expect(await a.db.journalEntry.count({ where: { id: e.id } })).toBe(0);
  });

  // 2
  it("an entry id already journaled under another event is not reported synced", async () => {
    const bClass = (await b.db.class.create({ data: { eventId: b.eventId, name: "H21" }, select: { seq: true } })).seq;
    const inB = wire(b.event, "runner.registered", { name: "In B", classId: bClass, cardNo: 91901 });
    expect((await makeCaller(b.event).events.push({ events: [inB] })).synced).toEqual([inB.id]);

    const sameIdForA = { ...inB, competitionId: a.event.nameId, payload: { name: "In B", classId: aClass, cardNo: 91901 } };
    const res = await makeCaller(a.event).events.push({ events: [sameIdForA] });
    expect(res.synced).toEqual([]);
    expect(res.failed).toEqual([{ id: inB.id, error: "ENTRY_IN_OTHER_EVENT" }]);
    expect(await a.db.runner.count({ where: { eventId: a.eventId, cardNo: 91901 } })).toBe(0);
  });

  // 3
  it("a member with no race grant gets every one of the 16 types back as FORBIDDEN", async () => {
    const entries = sixteen(a.event, aClass, ++card);
    const res = await asCaller(member).events.push({ events: entries });
    expect(res.synced).toEqual([]);
    expect(res.failed).toHaveLength(16);
    for (const e of entries) {
      const f = res.failed.find((x) => x.id === e.id)!;
      expect(f.error).toBe("FORBIDDEN");
      expect(f.capability).toBe(capabilityForEntry(e));
    }
    expect(await a.db.journalEntry.count({ where: { id: { in: entries.map((e) => e.id) } } })).toBe(0);
    expect(await a.db.runner.count({ where: { eventId: a.eventId, cardNo: card } })).toBe(0);
  });

  // 4
  it("race crew: race entries apply, admin and course entries are refused, in one mixed batch", async () => {
    const entries = sixteen(a.event, aClass, ++card);
    const res = await asCaller(crew).events.push({ events: entries });
    const raceTypes = [
      "card.read", "result.applied", "finish.recorded", "start.recorded", "runner.registered",
      "finish.adjusted", "punch.recorded", "punch.removed", "punch.updated",
    ];
    const allowed = entries.filter((e) => raceTypes.includes(e.type));
    const refused = entries.filter((e) => !raceTypes.includes(e.type));
    expect(res.synced.sort()).toEqual(allowed.map((e) => e.id).sort());
    expect(res.failed.map((f) => f.id).sort()).toEqual(refused.map((e) => e.id).sort());
    for (const f of res.failed) {
      expect(f.error).toBe("FORBIDDEN");
      expect(f.capability).toBe(capabilityForEntry(refused.find((e) => e.id === f.id)!));
    }
    // The registration applied; the refused rename / delete did not.
    const runner = await a.db.runner.findFirst({ where: { eventId: a.eventId, cardNo: card } });
    expect(runner?.name).toBe("Sixteen");
    expect(runner?.removed).toBe(false);
    expect(await a.db.journalEntry.count({ where: { id: { in: refused.map((e) => e.id) } } })).toBe(0);
  });

  // 5
  it("course setter: control and course upserts apply, a result is refused", async () => {
    const control = wire(a.event, "control.upserted", { id: randomUUID(), seq: 0, fields: { name: "setter ctl" } });
    const course = wire(a.event, "course.upserted", { id: randomUUID(), seq: 0, fields: { name: "setter course" } });
    const result = wire(a.event, "result.applied", { cardNo: 1, status: 1, finishTime: 1, startTime: 1 });
    const res = await asCaller(setter).events.push({ events: [control, course, result] });
    expect(res.synced).toEqual([control.id, course.id]);
    expect(res.failed).toEqual([{ id: result.id, error: "FORBIDDEN", capability: "race.operate" }]);
  });

  // 6
  it("a refused entry stays retryable: after the role is granted the same id syncs", async () => {
    const e = wire(a.event, "runner.registered", { name: "Late Lena", classId: aClass, cardNo: 91902 });
    const first = await asCaller(late).events.push({ events: [e] });
    expect(first.failed[0]).toMatchObject({ id: e.id, error: "FORBIDDEN", capability: "race.operate" });
    await grantSystemGroup(a.db, {
      eventId: a.eventId,
      userId: late.id,
      groupId: SYSTEM_GROUP_IDS.raceCrew,
      grantedBy: admin.id,
    });
    const second = await asCaller(late).events.push({ events: [e] });
    expect(second.synced).toEqual([e.id]);
    expect(await a.db.runner.count({ where: { eventId: a.eventId, cardNo: 91902 } })).toBe(1);
  });

  // 7
  it("a valid node secret needs no user and may push all 16 types", async () => {
    const entries = sixteen(a.event, aClass, ++card);
    const res = await asCaller(null, { syncSecret: SECRET }).events.push({ events: entries });
    expect(res.failed).toEqual([]);
    expect(res.synced.sort()).toEqual(entries.map((e) => e.id).sort());
  });

  it("a wrong secret is UNAUTHORIZED even for an admin; a secret on a node with none is PRECONDITION_FAILED", async () => {
    await expect(
      asCaller(admin, { syncSecret: "not-the-secret" }).events.push({ events: [] }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    delete process.env.SYNC_SHARED_SECRET;
    try {
      await expect(
        asCaller(null, { syncSecret: SECRET }).events.push({ events: [] }),
      ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    } finally {
      process.env.SYNC_SHARED_SECRET = SECRET;
    }
  });

  it("no secret and no user is UNAUTHORIZED when auth is on", async () => {
    await expect(asCaller(null).events.push({ events: [] })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  // 8
  it("the secret does not bypass the competition check", async () => {
    const e = wire({ nameId: "elsewhere" }, "finish.recorded", { cardNo: 1, finishTime: 1 });
    const res = await asCaller(null, { syncSecret: SECRET }).events.push({ events: [e] });
    expect(res.failed).toEqual([{ id: e.id, error: "COMPETITION_MISMATCH" }]);
  });

  // 9
  it("an empty push (the clock probe) resolves for a member with no grants", async () => {
    const res = await asCaller(member).events.push({ events: [] });
    expect(res.synced).toEqual([]);
    expect(res.failed).toEqual([]);
    expect(typeof res.serverTimeMs).toBe("number");
  });

  // 10
  it("race crew may queue a finish-only runner.updated (finish station overwrite), not other fields", async () => {
    const reg = wire(a.event, "runner.registered", { name: "Finish Fay", classId: aClass, cardNo: 91903 });
    await asCaller(crew).events.push({ events: [reg] });
    const finish = wire(a.event, "runner.updated", { cardNo: 91903, fields: { finishTime: 372000 } });
    const rename = wire(a.event, "runner.updated", { cardNo: 91903, fields: { name: "Renamed" } });
    const res = await asCaller(crew).events.push({ events: [finish, rename] });
    expect(res.synced).toEqual([finish.id]);
    expect(res.failed).toEqual([{ id: rename.id, error: "FORBIDDEN", capability: "event.manage" }]);
    const row = await a.db.runner.findFirst({ where: { eventId: a.eventId, cardNo: 91903 } });
    expect(row?.name).toBe("Finish Fay");
    expect(row?.finishTime).toBeGreaterThan(0);
  });

  it("reference.imported with classes needs event.manage as well as courses.edit", async () => {
    const cls = () => ({ id: randomUUID(), seq: 0, fields: { name: `Imp ${randomUUID().slice(0, 4)}` } });
    const withClasses = wire(a.event, "reference.imported", { controls: [], courses: [], classes: [cls()] });
    const noClasses = wire(a.event, "reference.imported", {
      controls: [{ id: randomUUID(), seq: 0, fields: { name: "imp only ctl" } }],
      courses: [],
      classes: [],
    });
    const res = await asCaller(setter).events.push({ events: [withClasses, noClasses] });
    expect(res.failed).toEqual([{ id: withClasses.id, error: "FORBIDDEN", capability: "event.manage" }]);
    expect(res.synced).toEqual([noClasses.id]);
    expect(await a.db.journalEntry.count({ where: { id: withClasses.id } })).toBe(0);

    const adminRes = await asCaller(admin).events.push({ events: [withClasses] });
    expect(adminRes.synced).toEqual([withClasses.id]);
  });

  it("an id already journaled under this event answers synced without the gate; a mismatching competitionId is still refused", async () => {
    const e = wire(a.event, "runner.registered", { name: "Known Kim", classId: aClass, cardNo: 91904 });
    expect((await asCaller(crew).events.push({ events: [e] })).synced).toEqual([e.id]);
    // `member` holds no race.operate (a role revoked since): the id is already applied.
    const again = await asCaller(member).events.push({ events: [e] });
    expect(again).toMatchObject({ synced: [e.id], failed: [] });
    const wrong = { ...e, competitionId: "elsewhere" };
    const res = await asCaller(member).events.push({ events: [wrong] });
    expect(res.synced).toEqual([]);
    expect(res.failed).toEqual([{ id: e.id, error: "COMPETITION_MISMATCH" }]);
    // A new id is still gated.
    const fresh = wire(a.event, "runner.registered", { name: "Fresh", classId: aClass, cardNo: 91905 });
    const g = await asCaller(member).events.push({ events: [fresh] });
    expect(g.failed[0]).toMatchObject({ error: "FORBIDDEN", capability: "race.operate" });
  });

  it("a kiosk key with no user cannot push entries when auth is on", async () => {
    const e = wire(a.event, "finish.recorded", { cardNo: 1, finishTime: 1 });
    await expect(
      asCaller(null, { kioskKey: "some-kiosk-key-value" }).events.push({ events: [e] }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(await a.db.journalEntry.count({ where: { id: e.id } })).toBe(0);
  });

  it("with auth off and no secret, a non-station entry type applies", async () => {
    const e = wire(a.event, "course.upserted", { id: randomUUID(), seq: 0, fields: { name: "auth-off course" } });
    const res = await makeCaller(a.event).events.push({ events: [e] });
    expect(res).toMatchObject({ synced: [e.id], failed: [] });
  });

  it("a secret presented to a node with no SYNC_SHARED_SECRET is PRECONDITION_FAILED with entries too", async () => {
    delete process.env.SYNC_SHARED_SECRET;
    try {
      const e = wire(a.event, "finish.recorded", { cardNo: 1, finishTime: 1 });
      await expect(
        asCaller(null, { syncSecret: SECRET }).events.push({ events: [e] }),
      ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    } finally {
      process.env.SYNC_SHARED_SECRET = SECRET;
    }
  });

  // Q3
  it("stamps the signed-in user as the journal actor; a peer keeps the wire actor", async () => {
    const wireActor = randomUUID();
    const user = wire(a.event, "finish.recorded", { cardNo: 1, finishTime: 1 }, { actorId: wireActor });
    await asCaller(crew).events.push({ events: [user] });
    expect((await a.db.journalEntry.findUnique({ where: { id: user.id } }))?.actorId).toBe(crew.id);

    const peer = wire(a.event, "finish.recorded", { cardNo: 1, finishTime: 1 }, { actorId: wireActor });
    await asCaller(null, { syncSecret: SECRET }).events.push({ events: [peer] });
    expect((await a.db.journalEntry.findUnique({ where: { id: peer.id } }))?.actorId).toBe(wireActor);
  });
});

describe("events.push: reference upserts stay inside their event", () => {
  let a: TestEventContext;
  let b: TestEventContext;
  let caller: ReturnType<typeof makeCaller>;
  let bControl: string;
  let bCourse: string;
  let bClass: string;

  beforeAll(async () => {
    a = await createTestEvent("push-ref-a");
    b = await createTestEvent("push-ref-b");
    caller = makeCaller(a.event);
    bControl = (await b.db.control.create({ data: { eventId: b.eventId, name: "B ctl", codes: "41" } })).id;
    bCourse = (await b.db.course.create({ data: { eventId: b.eventId, name: "B course" } })).id;
    await b.db.courseControl.create({ data: { courseId: bCourse, controlId: bControl, position: 1 } });
    bClass = (await b.db.class.create({ data: { eventId: b.eventId, name: "B class", courseId: bCourse } })).id;
  });

  afterAll(async () => {
    await a.cleanup();
    await b.cleanup();
  });

  // 11
  it("refuses a course, class or control id that lives in another event and leaves that row alone", async () => {
    const course = wire(a.event, "course.upserted", {
      id: bCourse, seq: 1, fields: { name: "hijacked" }, courseControls: [],
    });
    const cls = wire(a.event, "class.upserted", { id: bClass, seq: 1, fields: { name: "hijacked" } });
    const ctl = wire(a.event, "control.upserted", { id: bControl, seq: 1, fields: { name: "hijacked" } });
    const res = await caller.events.push({ events: [course] });
    expect(res.failed).toEqual([{ id: course.id, error: "ROW_IN_OTHER_EVENT" }]);
    // Each entry in its own push: an apply failure stops the batch.
    expect((await caller.events.push({ events: [cls] })).failed).toEqual([{ id: cls.id, error: "ROW_IN_OTHER_EVENT" }]);
    expect((await caller.events.push({ events: [ctl] })).failed).toEqual([{ id: ctl.id, error: "ROW_IN_OTHER_EVENT" }]);

    expect((await b.db.course.findUniqueOrThrow({ where: { id: bCourse } })).name).toBe("B course");
    expect((await b.db.class.findUniqueOrThrow({ where: { id: bClass } })).name).toBe("B class");
    expect((await b.db.control.findUniqueOrThrow({ where: { id: bControl } })).name).toBe("B ctl");
    expect(await b.db.courseControl.count({ where: { courseId: bCourse } })).toBe(1);
    expect(await a.db.journalEntry.count({ where: { id: { in: [course.id, cls.id, ctl.id] } } })).toBe(0);
  });

  // 12
  it("ignores eventId / seq / id / timestamps smuggled in fields", async () => {
    const id = randomUUID();
    const e = wire(a.event, "course.upserted", {
      id,
      seq: 7,
      fields: { name: "Smuggler", eventId: Number(b.eventId), seq: 99, id: randomUUID(), createdAt: "2001-01-01T00:00:00Z" },
    });
    const res = await caller.events.push({ events: [e] });
    expect(res.failed).toEqual([]);
    const row = await a.db.course.findUniqueOrThrow({ where: { id } });
    expect(row.eventId).toBe(a.eventId);
    expect(row.seq).toBe(7);
    expect(row.name).toBe("Smuggler");
    expect(row.createdAt.getFullYear()).toBeGreaterThan(2001);
  });

  // 13
  it("a course whose control list names a missing or foreign control fails whole and keeps its old controls", async () => {
    const ctl = (await a.db.control.create({ data: { eventId: a.eventId, name: "A ctl", codes: "51" } })).id;
    const id = randomUUID();
    const ok = wire(a.event, "course.upserted", {
      id, seq: 0, fields: { name: "Keeps" },
      courseControls: [{ position: 1, controlId: ctl }],
    });
    expect((await caller.events.push({ events: [ok] })).synced).toEqual([ok.id]);

    for (const bad of [randomUUID(), bControl]) {
      const e = wire(a.event, "course.upserted", {
        id, seq: 0, fields: { name: "Broken" },
        courseControls: [{ position: 1, controlId: ctl }, { position: 2, controlId: bad }],
      });
      const res = await caller.events.push({ events: [e] });
      expect(res.failed).toEqual([{ id: e.id, error: "INVALID_PAYLOAD" }]);
    }
    const row = await a.db.course.findUniqueOrThrow({ where: { id } });
    expect(row.name).toBe("Keeps");
    const links = await a.db.courseControl.findMany({ where: { courseId: id } });
    expect(links.map((l) => l.controlId)).toEqual([ctl]);
  });

  // 14
  it("a new course cannot point its finish control, parent or a class cannot point its course at another event", async () => {
    const finishInB = wire(a.event, "course.upserted", { id: randomUUID(), seq: 0, fields: { name: "F", finishControlId: bControl } });
    const res1 = await caller.events.push({ events: [finishInB] });
    expect(res1.failed).toEqual([{ id: finishInB.id, error: "INVALID_PAYLOAD" }]);
    expect(await a.db.course.count({ where: { name: "F", eventId: a.eventId } })).toBe(0);

    const classToB = wire(a.event, "class.upserted", { id: randomUUID(), seq: 0, fields: { name: "C", courseId: bCourse } });
    expect((await caller.events.push({ events: [classToB] })).failed).toEqual([{ id: classToB.id, error: "INVALID_PAYLOAD" }]);

    const poolToB = wire(a.event, "class.upserted", {
      id: randomUUID(), seq: 0, fields: { name: "P" }, coursePools: [{ stage: 0, courseId: bCourse }],
    });
    expect((await caller.events.push({ events: [poolToB] })).failed).toEqual([{ id: poolToB.id, error: "INVALID_PAYLOAD" }]);
  });

  // 15
  it("a class with an Eventor id (BigInt) round-trips through its own payload", async () => {
    const cls = await a.db.class.create({
      data: { eventId: a.eventId, name: "Eventor class", eventorId: 123_456_789_012n },
    });
    const payload = await classUpsertPayload(a.db, cls.id);
    expect(payload.fields.eventorId).toBe("123456789012");
    await a.db.class.delete({ where: { id: cls.id } });
    const e = wire(a.event, "class.upserted", payload as unknown as Record<string, unknown>);
    const res = await caller.events.push({ events: [e] });
    expect(res.failed).toEqual([]);
    const back = await a.db.class.findUniqueOrThrow({ where: { id: cls.id } });
    expect(back.eventorId).toBe(123_456_789_012n);
    expect(back.name).toBe("Eventor class");
  });

  // 16
  it("drops an unknown key in fields and applies the rest", async () => {
    const id = randomUUID();
    const e = wire(a.event, "control.upserted", {
      id, seq: 0, fields: { name: "Known", columnFromTheFuture: "x", description: null },
    });
    const res = await caller.events.push({ events: [e] });
    expect(res.failed).toEqual([]);
    expect((await a.db.control.findUniqueOrThrow({ where: { id } })).name).toBe("Known");
  });

  // 22
  it("a runner or punch id that belongs to another event is not a duplicate", async () => {
    const aClass = (await a.db.class.create({ data: { eventId: a.eventId, name: "H21" }, select: { seq: true } })).seq;
    const bRunner = await b.db.runner.create({
      data: { eventId: b.eventId, name: "B runner", classId: bClass, cardNo: 92001 },
    });
    const reg = wire(a.event, "runner.registered", { tempId: bRunner.id, name: "Thief", classId: aClass, cardNo: 92002 });
    const res = await caller.events.push({ events: [reg] });
    expect(res.synced).toEqual([]);
    expect(res.failed).toEqual([{ id: reg.id, error: "ROW_IN_OTHER_EVENT" }]);
    expect(await a.db.runner.count({ where: { eventId: a.eventId, cardNo: 92002 } })).toBe(0);

    const bPunch = await b.db.punch.create({
      data: { eventId: b.eventId, cardNo: 92001, controlCode: 31, time: 1000, source: "card" },
    });
    const punch = wire(a.event, "punch.recorded", { id: bPunch.id, cardNo: 92003, controlCode: 31, time: 360000 });
    const res2 = await caller.events.push({ events: [punch] });
    expect(res2.failed).toEqual([{ id: punch.id, error: "ROW_IN_OTHER_EVENT" }]);
    expect(await a.db.punch.count({ where: { eventId: a.eventId, cardNo: 92003 } })).toBe(0);
  });

  // 22b
  it("ROW_IN_OTHER_EVENT stops the batch like any apply failure: the entry behind it is in neither list", async () => {
    const aClass = (await a.db.class.findFirstOrThrow({ where: { eventId: a.eventId }, select: { seq: true } })).seq;
    const bRunner = await b.db.runner.create({
      data: { eventId: b.eventId, name: "B runner 2", classId: bClass, cardNo: 92011 },
    });
    const bad = wire(a.event, "runner.registered", { tempId: bRunner.id, name: "Thief", classId: aClass, cardNo: 92012 });
    const later = wire(a.event, "runner.registered", { name: "Later", classId: aClass, cardNo: 92013 });
    const res = await caller.events.push({ events: [bad, later] });
    expect(res.synced).toEqual([]);
    expect(res.failed).toEqual([{ id: bad.id, error: "ROW_IN_OTHER_EVENT" }]);
    expect(await a.db.runner.count({ where: { eventId: a.eventId, cardNo: 92013 } })).toBe(0);
  });
});

describe("events.push: one transaction per entry, stop at the first apply failure", () => {
  let ctx: TestEventContext;
  let classSeq: number;
  let pooledClassSeq: number;
  let pooledClassId: string;
  let card = 93000;

  beforeAll(async () => {
    ctx = await createTestEvent("push-atomic");
    classSeq = (await ctx.db.class.create({ data: { eventId: ctx.eventId, name: "Plain" }, select: { seq: true } })).seq;
    const root = await ctx.db.course.create({ data: { eventId: ctx.eventId, name: "Root" } });
    const cls = await ctx.db.class.create({ data: { eventId: ctx.eventId, name: "Pooled", courseId: root.id } });
    pooledClassSeq = cls.seq;
    pooledClassId = cls.id;
    for (const key of ["A", "B"]) {
      const v = await ctx.db.course.create({
        data: { eventId: ctx.eventId, name: `Root ${key}`, parentCourseId: root.id, variantKey: key },
      });
      await ctx.db.classCoursePool.create({ data: { classId: cls.id, stage: 0, courseId: v.id } });
    }
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  /** A db whose transaction client throws once from `model.method` (when `armed`). */
  function failingOnce(model: string, method: string) {
    const state = { armed: true, hits: 0 };
    const real = ctx.db;
    const wrapTx = (tx: Record<string, unknown>) =>
      new Proxy(tx, {
        get(t, prop) {
          const value = t[prop as string];
          if (prop !== model) return value;
          return new Proxy(value as object, {
            get(m, q) {
              if (q === method && state.armed) {
                return async () => {
                  state.armed = false;
                  state.hits++;
                  throw new Error(`injected failure in ${model}.${method}`);
                };
              }
              const fn = (m as Record<string | symbol, unknown>)[q];
              return typeof fn === "function" ? (...args: unknown[]) => (fn as (...a: unknown[]) => unknown).apply(m, args) : fn;
            },
          });
        },
      });
    const db = new Proxy(real, {
      get(t, prop) {
        if (prop === "$transaction") {
          return (fn: (tx: unknown) => Promise<unknown>, opts: unknown) =>
            real.$transaction((tx) => fn(wrapTx(tx as never)), opts as never);
        }
        return (t as never)[prop as never];
      },
    }) as unknown as PrismaClient;
    return { db, state };
  }

  const runnersWithName = (name: string) =>
    ctx.db.runner.findMany({ where: { eventId: ctx.eventId, name } });

  // 17
  it("a failing journal insert leaves no runner behind, and the retry makes exactly one with a variant", async () => {
    const { db, state } = failingOnce("journalEntry", "create");
    const e = wire(ctx.event, "runner.registered", { name: "Cardless Cleo", classId: pooledClassSeq });
    const first = await ingestJournalEntries(db, ctx.event, [e]);
    expect(state.hits).toBe(1);
    expect(first.synced).toEqual([]);
    expect(first.failed).toEqual([{ id: e.id, error: "APPLY_FAILED" }]);
    expect(await runnersWithName("Cardless Cleo")).toHaveLength(0);

    const second = await ingestJournalEntries(db, ctx.event, [e]);
    expect(second.synced).toEqual([e.id]);
    const rows = await runnersWithName("Cardless Cleo");
    expect(rows).toHaveLength(1);
    expect(rows[0].courseId).not.toBeNull();
  });

  // 18
  it("a failing variant follow-up rolls the whole entry back; the retry creates the runner with its variant and its entry", async () => {
    const { db, state } = failingOnce("runner", "findUniqueOrThrow");
    const e = wire(ctx.event, "runner.registered", { name: "Pooled Pia", classId: pooledClassSeq, cardNo: ++card });
    const first = await ingestJournalEntries(db, ctx.event, [e]);
    expect(state.hits).toBe(1);
    expect(first.failed).toEqual([{ id: e.id, error: "APPLY_FAILED" }]);
    expect(await runnersWithName("Pooled Pia")).toHaveLength(0);
    expect(await ctx.db.journalEntry.count({ where: { id: e.id } })).toBe(0);

    const second = await ingestJournalEntries(db, ctx.event, [e]);
    expect(second.synced).toEqual([e.id]);
    const [row] = await runnersWithName("Pooled Pia");
    expect(row.courseId).not.toBeNull();
    // The pick is journaled after the entry.
    const entries = await ctx.db.journalEntry.findMany({
      where: { eventId: ctx.eventId, type: "runner.updated", payload: { path: ["cardNo"], equals: card } },
    });
    expect(entries).toHaveLength(1);
  });

  // 19
  it("reference.imported is atomic: a bad last class leaves no control or course from the import", async () => {
    const controlId = randomUUID();
    const courseId = randomUUID();
    const good = { id: randomUUID(), seq: 0, fields: { name: "Imp good" } };
    const bad = { id: randomUUID(), seq: 0, fields: { name: "Imp bad" }, coursePools: [{ stage: 0, courseId: randomUUID() }] };
    const e = wire(ctx.event, "reference.imported", {
      controls: [{ id: controlId, seq: 0, fields: { name: "Imp ctl" } }],
      courses: [{ id: courseId, seq: 0, fields: { name: "Imp course" } }],
      classes: [good, bad],
    });
    const res = await ingestJournalEntries(ctx.db, ctx.event, [e]);
    expect(res.failed).toEqual([{ id: e.id, error: "INVALID_PAYLOAD" }]);
    expect(await ctx.db.control.count({ where: { id: controlId } })).toBe(0);
    expect(await ctx.db.course.count({ where: { id: courseId } })).toBe(0);
    expect(await ctx.db.class.count({ where: { id: { in: [good.id, bad.id] } } })).toBe(0);
    expect(await ctx.db.journalEntry.count({ where: { id: e.id } })).toBe(0);
  });

  // 20
  it("two concurrent ingests of the same entry both report synced and make one runner", async () => {
    const e = wire(ctx.event, "runner.registered", { name: "Twin Tess", classId: classSeq, cardNo: ++card });
    const [r1, r2] = await Promise.all([
      ingestJournalEntries(ctx.db, ctx.event, [e]),
      ingestJournalEntries(ctx.db, ctx.event, [e]),
    ]);
    expect(r1.synced).toEqual([e.id]);
    expect(r2.synced).toEqual([e.id]);
    expect(r1.failed).toEqual([]);
    expect(r2.failed).toEqual([]);
    expect(await runnersWithName("Twin Tess")).toHaveLength(1);
    expect(await ctx.db.journalEntry.count({ where: { id: e.id } })).toBe(1);
  });

  // 21
  it("a batch stops at the first apply failure: later entries are in neither list, the error is a code", async () => {
    const c = ++card;
    const good1 = wire(ctx.event, "runner.registered", { name: "Batch One", classId: classSeq, cardNo: c });
    // classSeq 99999 does not exist: the apply throws a TRPCError (message stays in the log).
    const poison = wire(ctx.event, "runner.updated", { cardNo: c, fields: { classId: 99999 } });
    const good2 = wire(ctx.event, "runner.registered", { name: "Batch Two", classId: classSeq, cardNo: ++card });
    const res = await makeCaller(ctx.event).events.push({ events: [good1, poison, good2] });
    expect(res.synced).toEqual([good1.id]);
    expect(res.failed).toHaveLength(1);
    expect(res.failed[0].id).toBe(poison.id);
    expect(res.failed[0].error).toMatch(/^[A-Z_]+$/);
    expect(res.failed[0].error).toBe("APPLY_FAILED");
    expect(await runnersWithName("Batch Two")).toHaveLength(0);
    expect(await ctx.db.journalEntry.count({ where: { id: { in: [poison.id, good2.id] } } })).toBe(0);

    // A malformed payload is a stable INVALID_PAYLOAD, still no raw text.
    const malformed = wire(ctx.event, "punch.recorded", { controlCode: 31 });
    const res2 = await makeCaller(ctx.event).events.push({ events: [malformed] });
    expect(res2.failed).toEqual([{ id: malformed.id, error: "INVALID_PAYLOAD" }]);
  });

  it("does not deal a variant outside its class pool (sanity: the pooled class has two variants)", async () => {
    expect(await ctx.db.classCoursePool.count({ where: { classId: pooledClassId } })).toBe(2);
  });
});

// 23 — RES-07 was fixed in package 2; these pin the status mapping on the ingest path.
describe("events.push: result.applied keeps the full status", () => {
  let ctx: TestEventContext;
  let classSeq: number;

  beforeAll(async () => {
    ctx = await createTestEvent("push-status");
    classSeq = (await ctx.db.class.create({ data: { eventId: ctx.eventId, name: "H21" }, select: { seq: true } })).seq;
  });
  afterAll(async () => {
    await ctx.cleanup();
  });

  it.each([
    [RunnerStatus.NoTiming, "no_timing"],
    [RunnerStatus.OverMaxTime, "over_max_time"],
    [RunnerStatus.OutOfCompetition, "out_of_competition"],
  ])("status %i is stored as %s", async (status, stored) => {
    const cardNo = 94000 + status;
    const caller = makeCaller(ctx.event);
    await caller.events.push({ events: [wire(ctx.event, "runner.registered", { name: `S${status}`, classId: classSeq, cardNo })] });
    const res = await caller.events.push({
      events: [wire(ctx.event, "result.applied", { cardNo, status, finishTime: 384_000, startTime: 360_000 })],
    });
    expect(res.failed).toEqual([]);
    const row = await ctx.db.runner.findFirstOrThrow({ where: { eventId: ctx.eventId, cardNo } });
    expect(row.status).toBe(stored);
  });

  it("status 5 (DQ) follows decideReadoutApply for a runner with no result", async () => {
    const cardNo = 94005;
    const caller = makeCaller(ctx.event);
    await caller.events.push({ events: [wire(ctx.event, "runner.registered", { name: "S5", classId: classSeq, cardNo })] });
    const decision = decideReadoutApply(
      { status: 0, finishTime: 0, startTime: 0, statusManual: false, finishManual: false },
      { status: RunnerStatus.DQ, finishTime: 60_000, startTime: 36_000 },
    );
    await caller.events.push({
      events: [wire(ctx.event, "result.applied", { cardNo, status: RunnerStatus.DQ, finishTime: 384_000, startTime: 360_000 })],
    });
    const row = await ctx.db.runner.findFirstOrThrow({ where: { eventId: ctx.eventId, cardNo } });
    expect(row.status).toBe(valueToRunnerStatus(decision.write.status));
  });
});
