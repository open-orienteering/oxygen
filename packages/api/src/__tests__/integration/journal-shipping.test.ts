/**
 * Two-node journal-shipping integration tests (pivot Step 3).
 *
 * Node A is the standard test database (the Prisma singleton, exercised
 * through the real tRPC callers). Node B is a **second physical database**
 * (`oxygen_test_b` in the same test container) with its own PrismaClient.
 * The transport between them is in-process but calls the exact functions the
 * HTTP endpoints use (`ingestJournalEntries` / `listJournalEntriesSince`),
 * so everything except the thin @trpc/client HTTP wrapper is production
 * code: journal emit on A, shipping, idempotent ingest + apply on B,
 * watermark advancement, and the pull direction back into A.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execSync } from "child_process";
import { Client } from "pg";
import { PrismaClient } from "../../generated/prisma/client.js";
import { PrismaPg } from "@prisma/adapter-pg";
import { randomUUID } from "crypto";
import {
  createTestEvent,
  disconnect,
  type TestEventContext,
} from "../helpers/test-db.js";
import { makeCaller } from "../helpers/caller.js";
import { encodeHlc } from "@oxygen/shared";
import {
  shipEventOnce,
  shipAllOnce,
  type PeerTransport,
} from "../../sync/shipper.js";
import {
  ingestJournalEntries,
  listJournalEntriesSince,
  listUnshippedJournalEntries,
  markJournalShipped,
} from "../../routers/events.js";
import { shippingStatus } from "../../sync/lease.js";
import type { EventRef } from "../../db.js";

const PEER_ID = "test-peer";

let ctx: TestEventContext; // node A
let caller: ReturnType<typeof makeCaller>;
let dbB: PrismaClient; // node B
let eventB: EventRef;
let classSeq: number;
let transport: PeerTransport;

/** In-process transport to node B, calling what the HTTP endpoints call. */
function makeTransport(): PeerTransport {
  return {
    push: (_nameId, entries) => ingestJournalEntries(dbB, eventB, entries, { fromPeer: true }),
    unshipped: (_nameId, limit) => listUnshippedJournalEntries(dbB, eventB, limit),
    ack: async (_nameId, ids) => {
      await markJournalShipped(dbB, eventB.id, ids);
    },
    since: (_nameId, cursor, limit) => listJournalEntriesSince(dbB, eventB, cursor, limit),
  };
}

/** Create (if needed) + migrate the node-B database in the test container. */
async function provisionNodeB(): Promise<string> {
  const aUrl = new URL(process.env.DATABASE_URL!);
  const bUrl = new URL(aUrl.toString());
  // Beside node A's database, so a run against another test database
  // (INTEGRATION_DATABASE_URL) has its own node B.
  const bName = `${aUrl.pathname.replace(/^\//, "")}_b`;
  bUrl.pathname = `/${bName}`;

  const admin = new Client({ connectionString: aUrl.toString() });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE "${bName}"`);
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code !== "42P04") throw err; // 42P04 = already exists
  } finally {
    await admin.end();
  }

  execSync("pnpm exec prisma migrate deploy", {
    stdio: "pipe",
    env: { ...process.env, DATABASE_URL: bUrl.toString() },
  });
  return bUrl.toString();
}

beforeAll(async () => {
  process.env.SYNC_SHARED_SECRET = "test-sync-secret";

  ctx = await createTestEvent("shipping");
  caller = makeCaller(ctx.event);

  const bUrl = await provisionNodeB();
  dbB = new PrismaClient({ adapter: new PrismaPg({ connectionString: bUrl }) });
  // Wipe stale rows from interrupted runs — scoped to THIS suite's prefix,
  // because other two-node suites (lease.test.ts) share the node-B database
  // in a parallel worker and their live rows must not be clobbered.
  await dbB.event.deleteMany({
    where: { nameId: { startsWith: "oxygen_test_shipping" } },
  });
  const rowB = await dbB.event.create({
    data: {
      nameId: ctx.nameId,
      name: "Node B replica",
      date: new Date("2026-01-01T00:00:00Z"),
      kind: "competition",
    },
    select: { id: true, nameId: true, zeroTime: true },
  });
  eventB = { id: rowB.id, nameId: rowB.nameId, zeroTime: rowB.zeroTime };

  // Reference data journals as class.upserted (full-row LWW keyed by UUID),
  // so node B receives the class through the first ship cycle — no manual
  // mirror needed.
  const clsA = await caller.class.create({ name: "H21" });
  classSeq = clsA.id;

  transport = makeTransport();
}, 60_000);

afterAll(async () => {
  delete process.env.SYNC_SHARED_SECRET;
  await dbB.event.delete({ where: { id: eventB.id } }).catch(() => {});
  await dbB.$disconnect();
  await ctx.cleanup();
  await disconnect();
});

describe("push direction: venue writes converge on the peer", () => {
  it("ships runner.registered + finish.adjusted and applies them on node B", async () => {
    const created = await caller.runner.create({
      name: "Ship Sven",
      classId: classSeq,
      cardNo: 700100,
      clubName: "OK Ship",
    });
    await caller.race.recordFinish({
      id: created.id,
      finishTimeAbsolute: 366000,
      status: 1,
    });

    const stats = await shipEventOnce(ctx.db, ctx.event, PEER_ID, transport);
    expect(stats.errors).toEqual([]);
    expect(stats.pushed).toBeGreaterThanOrEqual(2);

    // Node B applied the entries — runner row exists with the finish.
    const runnerB = await dbB.runner.findFirst({
      where: { eventId: eventB.id, cardNo: 700100, removed: false },
    });
    expect(runnerB).not.toBeNull();
    expect(runnerB!.name).toBe("Ship Sven");
    // 366000 absolute − 324000 zero time = 42000 relative.
    expect(runnerB!.finishTime).toBe(42000);
    expect(runnerB!.status).toBe("ok");

    // And journaled them verbatim (same entry ids).
    const idsA = (
      await ctx.db.journalEntry.findMany({
        where: { eventId: ctx.eventId },
        select: { id: true },
      })
    ).map((r) => r.id);
    const idsB = (
      await dbB.journalEntry.findMany({
        where: { eventId: eventB.id },
        select: { id: true },
      })
    ).map((r) => r.id);
    for (const id of idsA) expect(idsB).toContain(id);
  });

  it("replays runner.updated field patches on node B", async () => {
    const runnerA = await ctx.db.runner.findFirst({
      where: { eventId: ctx.eventId, cardNo: 700100 },
      select: { seq: true },
    });
    await caller.runner.update({
      id: runnerA!.seq,
      name: "Ship Sven II",
      status: 4, // DNF
    });

    const stats = await shipEventOnce(ctx.db, ctx.event, PEER_ID, transport);
    expect(stats.errors).toEqual([]);

    const runnerB = await dbB.runner.findFirst({
      where: { eventId: eventB.id, cardNo: 700100 },
    });
    expect(runnerB!.name).toBe("Ship Sven II");
    expect(runnerB!.status).toBe("dnf");
  });

  it("converges reference edits and punch corrections on node B", async () => {
    // A class rename (full-row LWW upsert) …
    await caller.class.update({ id: classSeq, name: "H21 Elite" });
    // … and a manual punch that then gets a time correction. The punch id
    // travels with punch.recorded, so the correction addresses the same
    // row on the peer.
    await caller.cardReadout.addPunch({
      cardNo: 700100,
      controlCode: 66,
      time: 362000,
    });
    const punchA = await ctx.db.punch.findFirst({
      where: { eventId: ctx.eventId, cardNo: 700100, controlCode: 66 },
    });
    await caller.cardReadout.updatePunchTime({
      punchId: punchA!.id,
      time: 362500,
    });

    const stats = await shipEventOnce(ctx.db, ctx.event, PEER_ID, transport);
    expect(stats.errors).toEqual([]);

    const clsB = await dbB.class.findFirst({
      where: { eventId: eventB.id, seq: classSeq },
    });
    expect(clsB!.name).toBe("H21 Elite");

    // Same row UUID on B, with the corrected (relative) time applied.
    const punchB = await dbB.punch.findUnique({ where: { id: punchA!.id } });
    expect(punchB).not.toBeNull();
    expect(punchB!.time).toBe(362500 - 324000);
    expect(punchB!.isOriginal).toBe(false);
  });

  it("ships a course's structure and both version tokens unchanged (course-layer.md §6–7)", async () => {
    // A control without a description or circle gaps (JSON nulls) and a
    // course with a stored structure: node B must hold the same structure
    // and the same tokens, so a client may send B's token to A.
    const control = await caller.control.create({ codes: "88", xpos: 12, ypos: 34 });
    await caller.control.update({ id: control.id, notes: "south side" });
    const course = await caller.course.create({ name: "Shipped", controlIds: [control.id] });
    await caller.course.setStructure({
      courseId: course.id,
      structure: { version: 1, id: "x", orderMode: "ordered", items: [{ siteId: control.id, numberHidden: true }] },
    });

    const stats = await shipEventOnce(ctx.db, ctx.event, PEER_ID, transport);
    expect(stats.errors).toEqual([]);

    const courseA = await ctx.db.course.findFirstOrThrow({ where: { eventId: ctx.eventId, seq: course.id } });
    const courseB = await dbB.course.findUniqueOrThrow({ where: { id: courseA.id } });
    expect(courseB.structure).toEqual(courseA.structure);
    expect(courseB.version).toBe(courseA.version);
    const ccB = await dbB.courseControl.findMany({ where: { courseId: courseA.id } });
    expect(ccB.map((cc) => cc.numberHidden)).toEqual([true]);
    const controlA = await ctx.db.control.findFirstOrThrow({ where: { eventId: ctx.eventId, codes: "88" } });
    const controlB = await dbB.control.findUniqueOrThrow({ where: { id: controlA.id } });
    expect(controlB.version).toBe(controlA.version);
    expect(controlB.notes).toBe("south side");
    expect(controlB.kind).toBe("control");
  });

  it("is idempotent: a second cycle ships nothing and changes nothing", async () => {
    const before = await dbB.journalEntry.count({
      where: { eventId: eventB.id },
    });
    const stats = await shipEventOnce(ctx.db, ctx.event, PEER_ID, transport);
    expect(stats.pushed).toBe(0);
    const after = await dbB.journalEntry.count({
      where: { eventId: eventB.id },
    });
    expect(after).toBe(before);
  });
});

describe("pull direction: peer-originated entries converge locally", () => {
  it("pulls a punch.recorded from node B and applies it on node A", async () => {
    // Simulate a ROC punch ingested at the peer (cloud) during a lease.
    const entryId = randomUUID();
    await dbB.journalEntry.create({
      data: {
        id: entryId,
        eventId: eventB.id,
        type: "punch.recorded",
        stationId: "roc-99999",
        hlc: encodeHlc({ physical: Date.now(), logical: 0 }),
        schemaVersion: 1,
        clientTimestamp: new Date(),
        payload: {
          cardNo: 700100,
          controlCode: 33,
          time: 363000,
          origin: "online_input",
        },
      },
    });

    const stats = await shipEventOnce(ctx.db, ctx.event, PEER_ID, transport);
    expect(stats.errors).toEqual([]);
    expect(stats.pulled).toBeGreaterThanOrEqual(1);

    // Applied on A: relational punch row + journal entry, times relative.
    const punchA = await ctx.db.punch.findFirst({
      where: { eventId: ctx.eventId, cardNo: 700100, controlCode: 33 },
    });
    expect(punchA).not.toBeNull();
    expect(punchA!.time).toBe(363000 - 324000);
    const entryA = await ctx.db.journalEntry.findUnique({
      where: { id: entryId },
    });
    expect(entryA).not.toBeNull();
  });

  it("a pulled entry is not pushed back to its sender", async () => {
    const pushed: string[] = [];
    const counting: PeerTransport = {
      ...transport,
      push: async (n, entries) => {
        pushed.push(...entries.map((e) => e.id));
        return transport.push(n, entries);
      },
    };
    const stats = await shipEventOnce(ctx.db, ctx.event, PEER_ID, counting);
    expect(stats.errors).toEqual([]);
    expect(pushed).toEqual([]);
    const punchesB = await dbB.punch.count({
      where: { eventId: eventB.id, controlCode: 33 },
    });
    expect(punchesB).toBeLessThanOrEqual(1);
    expect((await shippingStatus(ctx.db, ctx.eventId, PEER_ID)).pendingPush).toBe(0);
  });

  it("dedupes the same physical punch arriving under two entry ids", async () => {
    // Same (cardNo, controlCode, time) as the previous test, new entry id —
    // the grow-only-set dedupe key must keep the punch table at one row.
    await dbB.journalEntry.create({
      data: {
        id: randomUUID(),
        eventId: eventB.id,
        type: "punch.recorded",
        stationId: "roc-88888",
        hlc: encodeHlc({ physical: Date.now(), logical: 1 }),
        schemaVersion: 1,
        clientTimestamp: new Date(),
        payload: {
          cardNo: 700100,
          controlCode: 33,
          time: 363000,
          origin: "online_input",
        },
      },
    });
    const stats = await shipEventOnce(ctx.db, ctx.event, PEER_ID, transport);
    expect(stats.errors).toEqual([]);
    const punchesA = await ctx.db.punch.count({
      where: {
        eventId: ctx.eventId,
        cardNo: 700100,
        controlCode: 33,
        removed: false,
      },
    });
    expect(punchesA).toBe(1);
  });
});

describe("delivery-mark contiguity", () => {
  it("a failing entry blocks its stream; the mark never skips it", async () => {
    // Drain everything so the poison entry is the head of the stream.
    await shipEventOnce(ctx.db, ctx.event, PEER_ID, transport);

    // Poison: punch.recorded with a payload Prisma cannot insert.
    const poisonId = randomUUID();
    const poisonHlc = encodeHlc({ physical: Date.now() + 1000, logical: 0 });
    await ctx.db.journalEntry.create({
      data: {
        id: poisonId,
        eventId: ctx.eventId,
        type: "punch.recorded",
        stationId: "poison",
        hlc: poisonHlc,
        schemaVersion: 1,
        clientTimestamp: new Date(),
        payload: {}, // no cardNo/controlCode/time → insert throws on B
      },
    });
    // A good entry strictly after the poison one.
    const goodId = randomUUID();
    await ctx.db.journalEntry.create({
      data: {
        id: goodId,
        eventId: ctx.eventId,
        type: "punch.recorded",
        stationId: "poison-suite",
        hlc: encodeHlc({ physical: Date.now() + 2000, logical: 0 }),
        schemaVersion: 1,
        clientTimestamp: new Date(),
        payload: { cardNo: 700100, controlCode: 44, time: 364000 },
      },
    });

    const stats = await shipEventOnce(ctx.db, ctx.event, PEER_ID, transport);
    expect(stats.errors.length).toBeGreaterThan(0);

    // The poison entry and the good one behind it stay undelivered.
    const goodMarked = await ctx.db.journalEntry.findUniqueOrThrow({ where: { id: goodId } });
    expect(goodMarked.pushedAt).toBeNull();
    expect(
      (await ctx.db.journalEntry.findUniqueOrThrow({ where: { id: poisonId } })).pushedAt,
    ).toBeNull();

    // Clean the poison entry up; the stream resumes on the next cycle.
    await ctx.db.journalEntry.delete({ where: { id: poisonId } });
    const resumed = await shipEventOnce(ctx.db, ctx.event, PEER_ID, transport);
    expect(resumed.errors).toEqual([]);
    const goodOnB = await dbB.journalEntry.findUnique({
      where: { id: goodId },
    });
    expect(goodOnB).not.toBeNull();
  });
});

describe("shipping by delivery mark (review MC-02, MC-23)", () => {
  /** A punch entry stamped `ageMs` before now, created directly on a node. */
  async function lateEntry(db: PrismaClient, eventId: bigint, ageMs: number, code: number) {
    const id = randomUUID();
    await db.journalEntry.create({
      data: {
        id,
        eventId,
        type: "punch.recorded",
        stationId: "late-station",
        hlc: encodeHlc({ physical: Date.now() - ageMs, logical: 0 }),
        schemaVersion: 1,
        clientTimestamp: new Date(Date.now() - ageMs),
        payload: { cardNo: 700100, controlCode: code, time: 365000 + code, origin: "online_input" },
      },
    });
    return id;
  }

  it("an entry arriving late with an HLC below the newest shipped one still ships", async () => {
    await shipEventOnce(ctx.db, ctx.event, PEER_ID, transport);
    expect((await shippingStatus(ctx.db, ctx.eventId, PEER_ID)).pendingPush).toBe(0);

    const id = await lateEntry(ctx.db, ctx.eventId, 60_000, 71);
    expect((await shippingStatus(ctx.db, ctx.eventId, PEER_ID)).pendingPush).toBe(1);

    const stats = await shipEventOnce(ctx.db, ctx.event, PEER_ID, transport);
    expect(stats.errors).toEqual([]);
    expect(stats.pushed).toBe(1);
    expect(await dbB.journalEntry.findUnique({ where: { id } })).not.toBeNull();
    expect((await shippingStatus(ctx.db, ctx.eventId, PEER_ID)).pendingPush).toBe(0);
  });

  it("the same in the pull direction: a late entry on B reaches A", async () => {
    await shipEventOnce(ctx.db, ctx.event, PEER_ID, transport);
    const id = await lateEntry(dbB, eventB.id, 60_000, 72);
    const stats = await shipEventOnce(ctx.db, ctx.event, PEER_ID, transport);
    expect(stats.errors).toEqual([]);
    expect(stats.pulled).toBe(1);
    expect(await ctx.db.journalEntry.findUnique({ where: { id } })).not.toBeNull();
    expect(
      (await dbB.journalEntry.findUniqueOrThrow({ where: { id } })).pushedAt,
    ).not.toBeNull();
  });

  it("an entry received from the peer is created marked delivered", async () => {
    const id = await lateEntry(dbB, eventB.id, 1_000, 73);
    await shipEventOnce(ctx.db, ctx.event, PEER_ID, transport);
    const row = await ctx.db.journalEntry.findUniqueOrThrow({ where: { id } });
    expect(row.pushedAt).not.toBeNull();
  });

  it("legacy peer: a transport whose unshipped answers NOT_FOUND pulls through since", async () => {
    await shipEventOnce(ctx.db, ctx.event, PEER_ID, transport);
    const id = await lateEntry(dbB, eventB.id, 0, 74);
    const legacy: PeerTransport = {
      ...transport,
      unshipped: async () => {
        throw Object.assign(new Error("No procedure found"), { code: "NOT_FOUND" });
      },
    };
    const stats = await shipEventOnce(ctx.db, ctx.event, PEER_ID, legacy);
    expect(stats.errors).toEqual([]);
    expect(stats.pulled).toBeGreaterThanOrEqual(1);
    expect(await ctx.db.journalEntry.findUnique({ where: { id } })).not.toBeNull();
  });

  it("a failed ack is not an error: the entry is offered again and applies once", async () => {
    const id = await lateEntry(dbB, eventB.id, 0, 75);
    const failing: PeerTransport = { ...transport, ack: async () => { throw new Error("link lost"); } };
    await expect(shipEventOnce(ctx.db, ctx.event, PEER_ID, failing)).rejects.toThrow("link lost");
    expect(await ctx.db.journalEntry.count({ where: { id } })).toBe(1);
    const stats = await shipEventOnce(ctx.db, ctx.event, PEER_ID, transport);
    expect(stats.errors).toEqual([]);
    expect(
      await ctx.db.punch.count({ where: { eventId: ctx.eventId, cardNo: 700100, controlCode: 75 } }),
    ).toBe(1);
    expect((await dbB.journalEntry.findUniqueOrThrow({ where: { id } })).pushedAt).not.toBeNull();
  });

  it("events.unshipped and events.ackShipped sit behind the shared secret and mark delivery", async () => {
    await expect(caller.events.unshipped({ limit: 5 })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    const peer = makeCaller(ctx.event, { syncSecret: "test-sync-secret" });
    const id = await lateEntry(ctx.db, ctx.eventId, 0, 76);
    const page = await peer.events.unshipped({ limit: 500 });
    expect(page.entries.map((e) => e.id)).toContain(id);
    expect((await peer.events.ackShipped({ ids: [id] })).marked).toBe(1);
    const after = await peer.events.unshipped({ limit: 500 });
    expect(after.entries.map((e) => e.id)).not.toContain(id);
  });
});

describe("shipAllOnce scope (review MC-23)", () => {
  it("ships only events with a sync-state row for the peer", async () => {
    const seen: string[] = [];
    const spy: PeerTransport = {
      ...transport,
      push: async (nameId, entries) => {
        seen.push(nameId);
        return { synced: entries.map((e) => e.id), failed: [] };
      },
      unshipped: async (nameId) => {
        seen.push(nameId);
        return { entries: [], hasMore: false };
      },
    };
    await lateEntry2();
    const peer = "scope-peer";
    await shipAllOnce(ctx.db, peer, spy);
    expect(seen).not.toContain(ctx.nameId); // no sync-state row for this peer yet
    await ctx.db.journalSyncState.create({ data: { peerId: peer, eventId: ctx.eventId } });
    await shipAllOnce(ctx.db, peer, spy);
    expect(seen).toContain(ctx.nameId);
  });
});

async function lateEntry2() {
  await ctx.db.journalEntry.create({
    data: {
      id: randomUUID(),
      eventId: ctx.eventId,
      type: "punch.recorded",
      stationId: "scope",
      hlc: encodeHlc({ physical: Date.now(), logical: 0 }),
      schemaVersion: 1,
      clientTimestamp: new Date(),
      payload: { cardNo: 700100, controlCode: 77, time: 366000, origin: "online_input" },
    },
  });
}

describe("events.since endpoint guard", () => {
  it("rejects calls without the shared secret", async () => {
    await expect(
      caller.events.since({ afterHlc: "0", afterId: "", limit: 10 }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("rejects calls with a wrong secret", async () => {
    const bad = makeCaller(ctx.event, { syncSecret: "wrong" });
    await expect(
      bad.events.since({ afterHlc: "0", afterId: "", limit: 10 }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("serves pages in (hlc, id) order with a working cursor", async () => {
    const peer = makeCaller(ctx.event, { syncSecret: "test-sync-secret" });
    const first = await peer.events.since({
      afterHlc: "0",
      afterId: "",
      limit: 2,
    });
    expect(first.entries.length).toBe(2);
    expect(first.hasMore).toBe(true);

    const second = await peer.events.since({
      afterHlc: first.nextCursor.hlc,
      afterId: first.nextCursor.id,
      limit: 500,
    });
    // No overlap between pages, and ordering is monotonic.
    const firstIds = new Set(first.entries.map((e) => e.id));
    for (const e of second.entries) expect(firstIds.has(e.id)).toBe(false);
    const all = [...first.entries, ...second.entries];
    for (let i = 1; i < all.length; i++) {
      const prev = encodeHlc(all[i - 1].hlc);
      const cur = encodeHlc(all[i].hlc);
      expect(cur >= prev).toBe(true);
    }
  });
});
