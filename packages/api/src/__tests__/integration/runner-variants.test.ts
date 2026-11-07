/**
 * Variants pre-set per runner (slice F, row F6b; user answer 3, 2026-11-07;
 * docs/course-controls-and-matching.md "Forked courses and variants"):
 *
 *   - runner.create / update { courseId } under the pool rule
 *     (VARIANT_NOT_IN_POOL), a class change clearing and re-dealing it
 *   - the invariant: every runner in a pooled class has a variant — on
 *     create, on a class change, on a class picking (or leaving) a root, on
 *     a vanished variant, on a station registration ingested by events.push
 *   - class.distributeVariants (start order, random seed, onlyUnassigned,
 *     raced runners skipped), its journal rows
 *   - the reads: runner.list / getById, startList.variantKey,
 *     course.variantList.runnerCount, class.detail.variants
 *   - the readout validates against the runner's own variant only
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import type { WireCourseStructure } from "@oxygen/shared";
import { RunnerStatus } from "@oxygen/shared";
import { createTestEvent, disconnect, type TestEventContext } from "../helpers/test-db.js";
import { makeCaller } from "../helpers/caller.js";
import { acquireLease } from "../../sync/lease.js";

let ctx: TestEventContext;
let caller: ReturnType<typeof makeCaller>;
let S: number;
let F: number;
const site: Record<number, number> = {};

type Items = WireCourseStructure["items"];
const ctl = (siteId: number): Items[number] => ({ siteId });
const group = (id: string, alts: number[][]): Items[number] => ({
  kind: "variation",
  id,
  alternatives: alts.map((ids, i) => ({ label: String.fromCharCode(65 + i), items: ids.map((siteId) => ({ siteId })) })),
});

/** A root `name` with variants A (32) / B (33), or A / B / C (32 / 33 / 35). */
async function forkedCourse(name: string, three = false) {
  const { id } = await caller.course.create({ name });
  const alts = three ? [[site[32]], [site[33]], [site[35]]] : [[site[32]], [site[33]]];
  await caller.course.setStructure({
    courseId: id,
    structure: {
      version: 1,
      id: "x",
      orderMode: "ordered",
      items: [ctl(S), ctl(site[31]), group("g", alts), ctl(site[34]), ctl(F)],
    },
  });
  const variants = await caller.course.variantList({ courseId: id });
  return { id, variants, key: (k: string) => variants.find((v) => v.variantKey === k)!.courseId };
}

async function courseSeqOfRunner(seq: number): Promise<number | null> {
  const r = await ctx.db.runner.findFirstOrThrow({
    where: { eventId: ctx.eventId, seq },
    select: { course: { select: { seq: true } } },
  });
  return r.course?.seq ?? null;
}

async function entriesDuring(fn: () => Promise<unknown>) {
  const head = await ctx.db.journalEntry.findFirst({
    where: { eventId: ctx.eventId },
    orderBy: { hlc: "desc" },
    select: { hlc: true },
  });
  await fn();
  return ctx.db.journalEntry.findMany({
    where: { eventId: ctx.eventId, hlc: { gt: head?.hlc ?? 0n } },
    orderBy: { hlc: "asc" },
  });
}
type Payload = { runnerId?: number; fields?: Record<string, unknown>; courseId?: number | null; id?: string };
const payloadOf = (e: { payload: unknown }) => e.payload as Payload;

let card = 700000;
const nextCard = () => ++card;

beforeAll(async () => {
  ctx = await createTestEvent("runner_variants");
  caller = makeCaller(ctx.event);
  S = (await caller.control.create({ status: 4, xpos: 10, ypos: 10 })).id;
  F = (await caller.control.create({ status: 5, xpos: 90, ypos: 10 })).id;
  for (const [code, x] of [[31, 20], [32, 30], [33, 40], [34, 50], [35, 60]] as const) {
    site[code] = (await caller.control.create({ codes: String(code), xpos: x, ypos: 20 })).id;
  }
});

afterAll(async () => {
  await ctx.cleanup();
  await disconnect();
});

describe("runner.create / update under the pool rule", () => {
  it("a create in a pooled class without courseId is dealt the least-populated variant, journaled as the seq", async () => {
    const root = await forkedCourse("Create");
    const { id: classId } = await caller.class.create({ name: "C1", courseId: root.id });
    const seqs: number[] = [];
    const entries = await entriesDuring(async () => {
      for (let i = 0; i < 3; i++) seqs.push((await caller.runner.create({ name: `C${i}`, classId })).id);
    });
    expect(await Promise.all(seqs.map(courseSeqOfRunner))).toEqual([root.key("A"), root.key("B"), root.key("A")]);
    const regs = entries.filter((e) => e.type === "runner.registered").map(payloadOf);
    expect(regs.map((p) => p.courseId)).toEqual([root.key("A"), root.key("B"), root.key("A")]);
  });

  it("a create with a pooled courseId keeps it; a course outside the pool is VARIANT_NOT_IN_POOL", async () => {
    const root = await forkedCourse("Pick");
    const other = await forkedCourse("Other");
    const { id: plain } = await caller.course.create({ name: "Plain" });
    const { id: classId } = await caller.class.create({ name: "C2", courseId: root.id });
    const { id } = await caller.runner.create({ name: "On B", classId, courseId: root.key("B") });
    expect(await courseSeqOfRunner(id)).toBe(root.key("B"));
    for (const courseId of [plain, other.key("A"), root.id]) {
      await expect(caller.runner.create({ name: "Bad", classId, courseId })).rejects.toThrow(/VARIANT_NOT_IN_POOL/);
    }
    // A class without a pool takes no course at all.
    const { id: plainClass } = await caller.class.create({ name: "C2p", courseId: plain });
    await expect(caller.runner.create({ name: "Bad", classId: plainClass, courseId: root.key("A") })).rejects.toThrow(
      /VARIANT_NOT_IN_POOL/,
    );
    const { id: plainRunner } = await caller.runner.create({ name: "Plain one", classId: plainClass });
    expect(await courseSeqOfRunner(plainRunner)).toBeNull();
  });

  it("update { courseId } moves within the pool, refuses outside it; null re-deals", async () => {
    const root = await forkedCourse("Upd");
    const { id: classId } = await caller.class.create({ name: "C3", courseId: root.id });
    const { id } = await caller.runner.create({ name: "U", classId });
    expect(await courseSeqOfRunner(id)).toBe(root.key("A"));
    const entries = await entriesDuring(() => caller.runner.update({ id, courseId: root.key("B") }));
    expect(await courseSeqOfRunner(id)).toBe(root.key("B"));
    expect(payloadOf(entries.find((e) => e.type === "runner.updated")!).fields).toEqual({ courseId: root.key("B") });
    const other = await forkedCourse("Upd other");
    await expect(caller.runner.update({ id, courseId: other.key("A") })).rejects.toThrow(/VARIANT_NOT_IN_POOL/);
    const nulled = await entriesDuring(() => caller.runner.update({ id, courseId: null }));
    expect(await courseSeqOfRunner(id)).toBe(root.key("A"));
    expect(payloadOf(nulled.find((e) => e.type === "runner.updated")!).fields).toEqual({ courseId: root.key("A") });
  });

  it("a class change clears the variant and deals one of the new class's pool (update and bulkUpdate)", async () => {
    const one = await forkedCourse("Move one");
    const two = await forkedCourse("Move two", true);
    const { id: plain } = await caller.course.create({ name: "Move plain" });
    const { id: c1 } = await caller.class.create({ name: "M1", courseId: one.id });
    const { id: c2 } = await caller.class.create({ name: "M2", courseId: two.id });
    const { id: c3 } = await caller.class.create({ name: "M3", courseId: plain });
    const { id } = await caller.runner.create({ name: "Mover", classId: c1, cardNo: nextCard() });
    const e1 = await entriesDuring(() => caller.runner.update({ id, classId: c2 }));
    expect(await courseSeqOfRunner(id)).toBe(two.key("A"));
    expect(payloadOf(e1.find((e) => e.type === "runner.updated")!).fields).toEqual({ classId: c2, courseId: two.key("A") });
    await caller.runner.update({ id, classId: c3 });
    expect(await courseSeqOfRunner(id)).toBeNull();
    // A courseId with the class change is checked against the new class's pool.
    await caller.runner.update({ id, classId: c2, courseId: two.key("C") });
    expect(await courseSeqOfRunner(id)).toBe(two.key("C"));
    await expect(caller.runner.update({ id, classId: c1, courseId: two.key("A") })).rejects.toThrow(/VARIANT_NOT_IN_POOL/);

    const { id: a } = await caller.runner.create({ name: "Bulk a", classId: c3 });
    const { id: b } = await caller.runner.create({ name: "Bulk b", classId: c3 });
    const e2 = await entriesDuring(() => caller.runner.bulkUpdate({ ids: [a, b], classId: c1 }));
    expect([await courseSeqOfRunner(a), await courseSeqOfRunner(b)].sort()).toEqual([one.key("A"), one.key("B")].sort());
    const fields = e2.filter((e) => e.type === "runner.updated").map((e) => payloadOf(e).fields!);
    expect(fields.every((f) => f.classId === c1 && typeof f.courseId === "number")).toBe(true);
  });
});

describe("the invariant at the pool seams", () => {
  it("class.update onto a root deals every runner, balanced, journaled after the class; off it clears them", async () => {
    const root = await forkedCourse("Seam");
    const { id: plain } = await caller.course.create({ name: "Seam plain" });
    const { id: classId } = await caller.class.create({ name: "S1", courseId: plain });
    const seqs: number[] = [];
    for (let i = 0; i < 4; i++) {
      seqs.push((await caller.runner.create({ name: `S${i}`, classId, startTime: 360000 + i * 1200 })).id);
    }
    const onto = await entriesDuring(() => caller.class.update({ id: classId, courseId: root.id }));
    expect(await Promise.all(seqs.map(courseSeqOfRunner))).toEqual([root.key("A"), root.key("B"), root.key("A"), root.key("B")]);
    expect(onto.map((e) => e.type)).toEqual(["class.upserted", ...seqs.map(() => "runner.updated")]);
    const detail = await caller.class.detail({ id: classId });
    expect(detail.variants).toEqual([
      { variantKey: "A", courseId: root.key("A"), runnerCount: 2 },
      { variantKey: "B", courseId: root.key("B"), runnerCount: 2 },
    ]);
    const off = await entriesDuring(() => caller.class.update({ id: classId, courseId: plain }));
    expect(await Promise.all(seqs.map(courseSeqOfRunner))).toEqual([null, null, null, null]);
    expect(off.filter((e) => e.type === "runner.updated").map((e) => payloadOf(e).fields)).toEqual(
      seqs.map(() => ({ courseId: null })),
    );
    expect((await caller.class.detail({ id: classId })).variants).toEqual([]);
  });

  it("a vanished variant's runners are dealt one of the remaining pool, the journal carrying the seq", async () => {
    const root = await forkedCourse("Vanish", true);
    const { id: classId } = await caller.class.create({ name: "V1", courseId: root.id });
    const { id } = await caller.runner.create({ name: "On C", classId, courseId: root.key("C") });
    const entries = await entriesDuring(() =>
      caller.course.setStructure({
        courseId: root.id,
        structure: {
          version: 1,
          id: "x",
          orderMode: "ordered",
          items: [ctl(S), ctl(site[31]), group("g", [[site[32]], [site[33]]]), ctl(site[34]), ctl(F)],
        },
      }),
    );
    expect(await courseSeqOfRunner(id)).toBe(root.key("A"));
    const mine = entries.filter((e) => e.type === "runner.updated" && payloadOf(e).runnerId === id);
    expect(mine.map((e) => payloadOf(e).fields)).toEqual([{ courseId: root.key("A") }]);
    // Course rows first, then the class, then the runner (§12.4).
    const types = entries.map((e) => e.type);
    expect(types.lastIndexOf("course.upserted")).toBeLessThan(types.indexOf("class.upserted"));
    expect(types.indexOf("class.upserted")).toBeLessThan(types.indexOf("runner.updated"));
  });

  it("a station registration (no courseId) is dealt on ingest and the pick journaled after it; a server entry's courseId is kept", async () => {
    const root = await forkedCourse("Push");
    const { id: classId } = await caller.class.create({ name: "P1", courseId: root.id });
    await caller.runner.create({ name: "First", classId }); // on A
    const station = {
      id: randomUUID(),
      type: "runner.registered" as never,
      competitionId: ctx.event.nameId,
      stationId: "station-A",
      timestamp: Date.now() + 60_000, // a station clock ahead of the server's
      payload: { tempId: randomUUID(), name: "Offline", classId, cardNo: nextCard() },
    };
    const entries = await entriesDuring(() => caller.events.push({ events: [station] }));
    const row = await ctx.db.runner.findUniqueOrThrow({
      where: { id: station.payload.tempId },
      select: { seq: true, course: { select: { seq: true } } },
    });
    expect(row.course?.seq).toBe(root.key("B"));
    expect(entries.map((e) => e.id === station.id ? "station" : e.type)).toEqual(["station", "runner.updated"]);
    expect(payloadOf(entries[1])).toMatchObject({ runnerId: row.seq, fields: { courseId: root.key("B") } });

    const server = {
      ...station,
      id: randomUUID(),
      timestamp: Date.now() + 120_000, // after the follow-up, so the window sees it
      payload: { tempId: randomUUID(), name: "Peer", classId, cardNo: nextCard(), courseId: root.key("A") },
    };
    const e2 = await entriesDuring(() => caller.events.push({ events: [server] }));
    expect(e2.map((e) => e.id)).toEqual([server.id]);
    const peer = await ctx.db.runner.findUniqueOrThrow({
      where: { id: server.payload.tempId },
      select: { course: { select: { seq: true } } },
    });
    expect(peer.course?.seq).toBe(root.key("A"));
  });

  it("a station class change is re-dealt on ingest; server-emitted ones replay their seq", async () => {
    const one = await forkedCourse("Push move one");
    const two = await forkedCourse("Push move two");
    const { id: c1 } = await caller.class.create({ name: "PM1", courseId: one.id });
    const { id: c2 } = await caller.class.create({ name: "PM2", courseId: two.id });
    const cardNo = nextCard();
    const { id } = await caller.runner.create({ name: "Moved offline", classId: c1, cardNo });
    const station = {
      id: randomUUID(),
      type: "runner.updated" as never,
      competitionId: ctx.event.nameId,
      stationId: "station-A",
      timestamp: Date.now(),
      payload: { cardNo, runnerId: id, fields: { classId: c2 } },
    };
    const entries = await entriesDuring(() => caller.events.push({ events: [station] }));
    expect(await courseSeqOfRunner(id)).toBe(two.key("A"));
    expect(entries.at(-1)!.type).toBe("runner.updated");
    expect(payloadOf(entries.at(-1)!).fields).toEqual({ courseId: two.key("A") });
    const replay = { ...station, id: randomUUID(), payload: { cardNo, runnerId: id, fields: { classId: c1, courseId: one.key("B") } } };
    await caller.events.push({ events: [replay] });
    expect(await courseSeqOfRunner(id)).toBe(one.key("B"));
  });
});

describe("class.distributeVariants", () => {
  async function fixture(name: string, n: number, three = false) {
    const root = await forkedCourse(name, three);
    const { id: classId } = await caller.class.create({ name, courseId: root.id });
    const seqs: number[] = [];
    // Created in reverse start order, so the creation-time pick is not the dealing.
    for (let i = n - 1; i >= 0; i--) {
      seqs.unshift((await caller.runner.create({ name: `${name} ${i}`, classId, startTime: 360000 + i * 1200 })).id);
    }
    return { root, classId, seqs };
  }

  it("deals round-robin in start order, one runner.updated per changed runner and no class.upserted", async () => {
    const { root, classId, seqs } = await fixture("Deal", 5, true);
    const entries = await entriesDuring(() =>
      caller.class.distributeVariants({ classId, mode: "startOrder", onlyUnassigned: false }),
    );
    const keys = ["A", "B", "C", "A", "B"].map(root.key);
    expect(await Promise.all(seqs.map(courseSeqOfRunner))).toEqual(keys);
    expect(entries.every((e) => e.type === "runner.updated")).toBe(true);
    const changed = entries.map((e) => payloadOf(e).runnerId);
    expect(new Set(changed).size).toBe(changed.length);
    for (const e of entries) {
      const p = payloadOf(e);
      expect(p.fields).toEqual({ courseId: keys[seqs.indexOf(p.runnerId!)] });
    }
    // A second deal changes nothing.
    const again = await caller.class.distributeVariants({ classId, mode: "startOrder", onlyUnassigned: false });
    expect(again).toMatchObject({ changed: 0, skipped: 0 });
    expect(again.counts.map((c) => c.runnerCount)).toEqual([2, 2, 1]);
    expect(await caller.course.variantList({ courseId: root.id })).toEqual(
      root.variants.map((v, i) => ({ ...v, runnerCount: [2, 2, 1][i] })),
    );
  });

  it("random is reproducible from its seed and balanced", async () => {
    const { classId, seqs } = await fixture("Rand", 6);
    await caller.class.distributeVariants({ classId, mode: "random", onlyUnassigned: false, seed: 9 });
    const first = await Promise.all(seqs.map(courseSeqOfRunner));
    await caller.class.distributeVariants({ classId, mode: "startOrder", onlyUnassigned: false });
    await caller.class.distributeVariants({ classId, mode: "random", onlyUnassigned: false, seed: 9 });
    expect(await Promise.all(seqs.map(courseSeqOfRunner))).toEqual(first);
    const counts = new Map<number | null, number>();
    for (const c of first) counts.set(c, (counts.get(c) ?? 0) + 1);
    expect([...counts.values()]).toEqual([3, 3]);
  });

  it("onlyUnassigned keeps the assigned; raced runners are skipped", async () => {
    const { root, classId, seqs } = await fixture("Keep", 4);
    await caller.runner.update({ id: seqs[0], courseId: root.key("B") });
    await ctx.db.runner.updateMany({ where: { eventId: ctx.eventId, seq: seqs[3] }, data: { courseId: null } });
    const kept = await caller.class.distributeVariants({ classId, mode: "startOrder", onlyUnassigned: true });
    expect(kept.changed).toBe(1);
    expect(await courseSeqOfRunner(seqs[0])).toBe(root.key("B"));
    expect(await courseSeqOfRunner(seqs[3])).not.toBeNull();
    // seqs[0] has finished: a full re-deal leaves her on B.
    await ctx.db.runner.updateMany({ where: { eventId: ctx.eventId, seq: seqs[0] }, data: { status: "ok", finishTime: 50000 } });
    const res = await caller.class.distributeVariants({ classId, mode: "startOrder", onlyUnassigned: false });
    expect(res.skipped).toBe(1);
    expect(await courseSeqOfRunner(seqs[0])).toBe(root.key("B"));
    expect(await Promise.all(seqs.slice(1).map(courseSeqOfRunner))).toEqual([root.key("A"), root.key("B"), root.key("A")]);
  });

  it("a class without a pool is CLASS_NOT_POOLED", async () => {
    const { id: plain } = await caller.course.create({ name: "No pool" });
    const { id: classId } = await caller.class.create({ name: "NP", courseId: plain });
    await expect(caller.class.distributeVariants({ classId, mode: "startOrder", onlyUnassigned: true })).rejects.toThrow(
      /CLASS_NOT_POOLED/,
    );
  });
});

describe("reads", () => {
  it("runner.list / getById expose the variant, the start list its key", async () => {
    const root = await forkedCourse("Reads");
    const { id: classId } = await caller.class.create({ name: "H21R", courseId: root.id });
    const { id } = await caller.runner.create({ name: "Reader", classId, courseId: root.key("B") });
    const listed = (await caller.runner.list({ classId })).find((r) => r.id === id)!;
    expect(listed.courseId).toBe(root.key("B"));
    expect(await caller.runner.getById({ id })).toMatchObject({ courseId: root.key("B"), variantKey: "B" });
    const start = (await caller.lists.startList({ classId })).find((r) => r.id === id)!;
    expect(start).toMatchObject({ className: "H21R", variantKey: "B" });
    const { id: plainClass } = await caller.class.create({ name: "Plain R" });
    const { id: plainRunner } = await caller.runner.create({ name: "Plain reader", classId: plainClass });
    expect(await caller.runner.getById({ id: plainRunner })).toMatchObject({ courseId: 0, variantKey: null });
    expect((await caller.lists.startList({ classId: plainClass }))[0].variantKey).toBeUndefined();
  });
});

describe("readout: the runner's own variant only", () => {
  const bPunches = (cardNo: number) => ({
    cardNo,
    cardType: "SI Card 9",
    startTime: 360000,
    finishTime: 396000,
    punches: [
      { controlCode: 31, time: 366000 },
      { controlCode: 33, time: 372000 },
      { controlCode: 34, time: 378000 },
    ],
  });

  it("a runner on A with B's punches is MP; a runner on B with them is OK, and her punches relevant", async () => {
    const root = await forkedCourse("Readout");
    const { id: classId } = await caller.class.create({ name: "RO", courseId: root.id });
    const onA = nextCard();
    const onB = nextCard();
    const a = (await caller.runner.create({ name: "On A", classId, cardNo: onA, courseId: root.key("A") })).id;
    const b = (await caller.runner.create({ name: "On B", classId, cardNo: onB, courseId: root.key("B") })).id;
    await caller.cardReadout.storeReadout(bPunches(onA));
    const stored = await caller.cardReadout.storeReadout(bPunches(onB));
    expect(stored.punchesRelevant).toBe(true);
    const ra = await caller.cardReadout.readoutByRunner({ runnerId: a });
    const rb = await caller.cardReadout.readoutByRunner({ runnerId: b });
    expect(ra?.timing.status).toBe(RunnerStatus.MissingPunch);
    expect(rb?.timing.status).toBe(RunnerStatus.OK);
    expect(rb?.course?.name).toBe("Readout B");
    expect(await courseSeqOfRunner(a)).toBe(root.key("A"));
  });
});

describe("a follower deals nothing", () => {
  it("events.push on a node that does not hold the lease leaves the station registration without a variant", async () => {
    const root = await forkedCourse("Follower");
    const { id: classId } = await caller.class.create({ name: "FW", courseId: root.id });
    await acquireLease(ctx.db, ctx.eventId, "venue-elsewhere");
    try {
      const tempId = randomUUID();
      const entries = await entriesDuring(() =>
        caller.events.push({
          events: [
            {
              id: randomUUID(),
              type: "runner.registered" as never,
              competitionId: ctx.event.nameId,
              stationId: "station-B",
              timestamp: Date.now() + 600_000, // ahead of every earlier entry
              payload: { tempId, name: "Follower", classId, cardNo: nextCard() },
            },
          ],
        }),
      );
      expect(entries).toHaveLength(1);
      const row = await ctx.db.runner.findUniqueOrThrow({ where: { id: tempId }, select: { courseId: true } });
      expect(row.courseId).toBeNull();
    } finally {
      await ctx.db.eventLease.updateMany({ where: { eventId: ctx.eventId, releasedAt: null }, data: { releasedAt: new Date() } });
    }
  });
});
