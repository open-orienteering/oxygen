/**
 * Per-event lease integration tests (pivot Step 4).
 *
 * Same two-node harness as journal-shipping.test.ts: node A is the Prisma
 * singleton (exercised through real tRPC callers), node B is a second
 * physical database. The lease peer + shipping transport are injected
 * in-process but call the same functions the HTTP endpoints use.
 *
 * Covers: the raceProcedure guard (typed rejection on a non-holder,
 * events.push unaffected), acquire/release/double-checkout, the full
 * checkout snapshot import (rows, seq counters, journal cursor), writes
 * during a lease shipping to the peer, the checkin barrier (blocked while
 * unshipped, releasing both sides when drained), and forceTakeover.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execSync } from "child_process";
import { Client } from "pg";
import { PrismaClient } from "@prisma/client";
import { randomUUID } from "crypto";
import {
  createTestEvent,
  disconnect,
  type TestEventContext,
} from "../helpers/test-db.js";
import { makeCaller } from "../helpers/caller.js";
import {
  acquireLease,
  releaseLease,
  getActiveLease,
  assertRaceWritable,
  exportEventSnapshot,
  importEventSnapshot,
  _setLeasePeerFactory,
  type LeasePeer,
} from "../../sync/lease.js";
import {
  _setPeerTransportFactory,
  type PeerTransport,
} from "../../sync/shipper.js";
import {
  ingestJournalEntries,
  listJournalEntriesSince,
} from "../../routers/events.js";
import type { EventRef } from "../../db.js";

const PEER_URL = "http://peer.test";

let ctx: TestEventContext; // node A (this process's node id: "cloud")
let caller: ReturnType<typeof makeCaller>;
let dbB: PrismaClient; // node B (the peer)
let eventB: EventRef; // the event that lives on B and gets checked out
const CHECKOUT_NAME = `oxygen_test_lease_co_${randomUUID().slice(0, 8)}`;

async function provisionNodeB(): Promise<string> {
  const aUrl = new URL(process.env.DATABASE_URL!);
  const bUrl = new URL(aUrl.toString());
  bUrl.pathname = "/oxygen_test_b";
  const admin = new Client({ connectionString: aUrl.toString() });
  await admin.connect();
  try {
    await admin.query("CREATE DATABASE oxygen_test_b");
  } catch (err) {
    if ((err as { code?: string }).code !== "42P04") throw err;
  } finally {
    await admin.end();
  }
  execSync("pnpm exec prisma migrate deploy", {
    stdio: "pipe",
    env: { ...process.env, DATABASE_URL: bUrl.toString() },
  });
  return bUrl.toString();
}

/** In-process peer: B's lease surface via the same functions the router uses. */
function leasePeerToB(): LeasePeer {
  return {
    acquire: async (_nameId, holder) => {
      await acquireLease(dbB, eventB.id, holder);
    },
    release: async (_nameId, holder) => {
      await releaseLease(dbB, eventB.id, { expectedHolder: holder });
    },
    exportSnapshot: async () => exportEventSnapshot(dbB, eventB),
  };
}

function transportToB(): PeerTransport {
  return {
    push: (_nameId, entries) => ingestJournalEntries(dbB, eventB, entries),
    since: (_nameId, cursor, limit) =>
      listJournalEntriesSince(dbB, eventB, cursor, limit),
  };
}

beforeAll(async () => {
  process.env.SYNC_PEER_URL = PEER_URL;
  process.env.SYNC_SHARED_SECRET = "test-sync-secret";

  ctx = await createTestEvent("lease");
  caller = makeCaller(ctx.event);
  const cls = await caller.class.create({ name: "H21" });
  await caller.runner.create({
    name: "Guarded Greta",
    classId: cls.id,
    cardNo: 800100,
    clubName: "OK Lease",
  });

  const bUrl = await provisionNodeB();
  dbB = new PrismaClient({ datasourceUrl: bUrl });
  await dbB.event.deleteMany({
    where: { nameId: { startsWith: "oxygen_test_lease" } },
  });

  // The checkout-source event lives on node B with reference + race data.
  const rowB = await dbB.event.create({
    data: {
      nameId: CHECKOUT_NAME,
      name: "Checkout Source",
      date: new Date("2026-01-01T00:00:00Z"),
      kind: "competition",
    },
    select: { id: true, nameId: true, zeroTime: true },
  });
  eventB = { id: rowB.id, nameId: rowB.nameId, zeroTime: rowB.zeroTime };
  const clsB = await dbB.class.create({
    data: { eventId: eventB.id, name: "D21" },
    select: { id: true, seq: true },
  });
  await dbB.runner.create({
    data: {
      eventId: eventB.id,
      name: "Snapshot Stina",
      classId: clsB.id,
      cardNo: 800200,
      clubName: "OK Source",
    },
  });
  await dbB.punch.create({
    data: {
      eventId: eventB.id,
      cardNo: 800200,
      controlCode: 31,
      time: 36000,
      source: "online_input",
    },
  });

  _setLeasePeerFactory(() => leasePeerToB());
  _setPeerTransportFactory(() => transportToB());
}, 60_000);

afterAll(async () => {
  _setLeasePeerFactory(null);
  _setPeerTransportFactory(null);
  delete process.env.SYNC_PEER_URL;
  delete process.env.SYNC_SHARED_SECRET;
  await ctx.db.event.deleteMany({ where: { nameId: CHECKOUT_NAME } });
  await dbB.event.delete({ where: { id: eventB.id } }).catch(() => {});
  await dbB.$disconnect();
  await ctx.cleanup();
  await disconnect();
});

describe("raceProcedure guard", () => {
  it("rejects race-critical mutations when another node holds the lease", async () => {
    await acquireLease(ctx.db, ctx.eventId, "venue-99");
    try {
      await expect(
        caller.race.recordFinish({ id: 1, finishTimeAbsolute: 366000 }),
      ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
      await expect(
        caller.runner.create({
          name: "Blocked Bo",
          classId: 1,
          clubName: "X",
        }),
      ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
      await expect(
        caller.class.create({ name: "Blocked class" }),
      ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });

      // The journal ingestion sink stays open — shipped/drained entries
      // must land on every node regardless of the lease.
      const res = await caller.events.push({
        events: [
          {
            id: randomUUID(),
            type: "punch.recorded",
            competitionId: ctx.nameId,
            stationId: "station-x",
            timestamp: Date.now(),
            payload: { cardNo: 800100, controlCode: 55, time: 361000 },
          },
        ],
      });
      expect(res.failed).toEqual([]);
      expect(res.synced.length).toBe(1);
    } finally {
      await releaseLease(ctx.db, ctx.eventId, { forced: true });
    }
  });

  it("writes resume after release; double-acquire conflicts", async () => {
    const r = await caller.runner.create({
      name: "Resumed Rune",
      classId: 1,
      clubName: "OK Igen",
    });
    expect(r.id).toBeGreaterThan(0);

    await acquireLease(ctx.db, ctx.eventId, "venue-99");
    try {
      await expect(
        acquireLease(ctx.db, ctx.eventId, "venue-100"),
      ).rejects.toMatchObject({ code: "CONFLICT" });
    } finally {
      await releaseLease(ctx.db, ctx.eventId, { forced: true });
    }
  });
});

describe("checkout → write → checkin lifecycle", () => {
  it("checkout imports the snapshot verbatim and takes the lease on both nodes", async () => {
    const res = await caller.lease.checkout({ nameId: CHECKOUT_NAME });
    expect(res.ok).toBe(true);
    expect(res.imported.runner).toBe(1);
    expect(res.imported.punch).toBe(1);

    // Local copy: same UUIDs, same seqs, seq counters carried over.
    const localEvent = await ctx.db.event.findUnique({
      where: { nameId: CHECKOUT_NAME },
      select: { id: true },
    });
    expect(localEvent).not.toBeNull();
    const runnerA = await ctx.db.runner.findFirst({
      where: { eventId: localEvent!.id, cardNo: 800200 },
    });
    const runnerB = await dbB.runner.findFirst({
      where: { eventId: eventB.id, cardNo: 800200 },
    });
    expect(runnerA!.id).toBe(runnerB!.id);
    expect(runnerA!.seq).toBe(runnerB!.seq);
    const seqRows = await ctx.db.eventSeq.findMany({
      where: { eventId: localEvent!.id },
    });
    expect(seqRows.length).toBeGreaterThan(0);

    // Lease held here (holder = this process's node id), mirrored on B.
    const leaseA = await getActiveLease(ctx.db, localEvent!.id);
    expect(leaseA?.holderNodeId).toBe("cloud");
    const leaseB = await getActiveLease(dbB, eventB.id);
    expect(leaseB?.holderNodeId).toBe("cloud");

    // On B (whose real node id differs), race writes are now rejected.
    const prevNodeId = process.env.NODE_ID;
    process.env.NODE_ID = "the-real-cloud";
    try {
      await expect(assertRaceWritable(dbB, eventB.id)).rejects.toMatchObject({
        code: "PRECONDITION_FAILED",
      });
    } finally {
      if (prevNodeId === undefined) delete process.env.NODE_ID;
      else process.env.NODE_ID = prevNodeId;
    }
  });

  it("checkin is blocked while entries are unshipped, then releases both sides", async () => {
    const localEvent = await ctx.db.event.findUniqueOrThrow({
      where: { nameId: CHECKOUT_NAME },
      select: { id: true, nameId: true, zeroTime: true },
    });
    const leaseCaller = makeCaller({
      id: localEvent.id,
      nameId: localEvent.nameId,
      zeroTime: localEvent.zeroTime,
    });

    // A race-critical write on the holder — journaled locally.
    const runner = await ctx.db.runner.findFirstOrThrow({
      where: { eventId: localEvent.id, cardNo: 800200 },
      select: { seq: true },
    });
    await leaseCaller.race.recordFinish({
      id: runner.seq,
      finishTimeAbsolute: 370000,
      status: 1,
    });

    // Barrier: with a dead transport, checkin must refuse.
    _setPeerTransportFactory(() => ({
      push: async () => ({ synced: [], failed: [{ id: "x", error: "offline" }] }),
      since: async () => ({
        entries: [],
        nextCursor: { hlc: "0", id: "" },
        hasMore: false,
      }),
    }));
    await expect(leaseCaller.lease.checkin()).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
    });

    // Healthy link: ships, then releases on both nodes.
    _setPeerTransportFactory(() => transportToB());
    const res = await leaseCaller.lease.checkin();
    expect(res.ok).toBe(true);
    expect(res.pushed).toBeGreaterThanOrEqual(1);

    // The finish arrived on B (366000+4000 abs − 324000 zero = 46000 rel).
    const runnerB = await dbB.runner.findFirstOrThrow({
      where: { eventId: eventB.id, cardNo: 800200 },
    });
    expect(runnerB.finishTime).toBe(370000 - 324000);
    expect(runnerB.status).toBe("ok");

    expect(await getActiveLease(ctx.db, localEvent.id)).toBeNull();
    expect(await getActiveLease(dbB, eventB.id)).toBeNull();
  });
});

describe("forceTakeover", () => {
  it("releases a foreign lease with forced=true after explicit confirm", async () => {
    await acquireLease(ctx.db, ctx.eventId, "venue-dead");
    const res = await caller.lease.forceTakeover({ confirm: true });
    expect(res.ok).toBe(true);
    expect(res.takenFrom).toBe("venue-dead");
    expect(await getActiveLease(ctx.db, ctx.eventId)).toBeNull();
    const last = await ctx.db.eventLease.findFirst({
      where: { eventId: ctx.eventId },
      orderBy: { id: "desc" },
    });
    expect(last?.forced).toBe(true);
  });

  it("refuses when no lease is active", async () => {
    await expect(
      caller.lease.forceTakeover({ confirm: true }),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  });
});
