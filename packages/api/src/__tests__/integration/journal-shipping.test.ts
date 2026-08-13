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
  type PeerTransport,
} from "../../sync/shipper.js";
import {
  ingestJournalEntries,
  listJournalEntriesSince,
} from "../../routers/events.js";
import type { EventRef } from "../../db.js";

const PEER_ID = "test-peer";

let ctx: TestEventContext; // node A
let caller: ReturnType<typeof makeCaller>;
let dbB: PrismaClient; // node B
let eventB: EventRef;
let classSeq: number;
let transport: PeerTransport;

/** Create (if needed) + migrate the node-B database in the test container. */
async function provisionNodeB(): Promise<string> {
  const aUrl = new URL(process.env.DATABASE_URL!);
  const bUrl = new URL(aUrl.toString());
  bUrl.pathname = "/oxygen_test_b";

  const admin = new Client({ connectionString: aUrl.toString() });
  await admin.connect();
  try {
    await admin.query("CREATE DATABASE oxygen_test_b");
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

  transport = {
    push: (nameId, entries) => ingestJournalEntries(dbB, eventB, entries),
    since: (nameId, cursor, limit) =>
      listJournalEntriesSince(dbB, eventB, cursor, limit),
  };
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

  it("echoing the pulled entry back to B is harmless (id dedupe)", async () => {
    const before = await dbB.journalEntry.count({
      where: { eventId: eventB.id },
    });
    // Next cycle pushes A's copy of the pulled entry back to B — B must
    // ack it as already-known without duplicating anything.
    const stats = await shipEventOnce(ctx.db, ctx.event, PEER_ID, transport);
    expect(stats.errors).toEqual([]);
    const after = await dbB.journalEntry.count({
      where: { eventId: eventB.id },
    });
    expect(after).toBe(before);
    const punchesB = await dbB.punch.count({
      where: { eventId: eventB.id, controlCode: 33 },
    });
    expect(punchesB).toBeLessThanOrEqual(1);
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

describe("watermark contiguity", () => {
  it("a failing entry blocks its stream; the watermark never skips it", async () => {
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

    // The push watermark stopped strictly before the poison entry.
    const state = await ctx.db.journalSyncState.findUnique({
      where: {
        peerId_eventId: { peerId: PEER_ID, eventId: ctx.eventId },
      },
    });
    expect(state).not.toBeNull();
    expect(state!.pushedHlc).toBeLessThan(poisonHlc);

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
