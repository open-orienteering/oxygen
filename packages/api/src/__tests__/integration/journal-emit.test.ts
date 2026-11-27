/**
 * Integration tests for server-originated journal entries (pivot Step 2).
 *
 * `appendJournal` writes the journal row in the same transaction as the table
 * write; `race.recordFinish` is the first journaled mutation (the 2a pattern
 * proof — the rest of the race-critical set follows in 2b). See
 * docs/history/future-architecture.md § "Planned" Step 2.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  createTestEvent,
  disconnect,
  type TestEventContext,
} from "../helpers/test-db.js";
import { makeCaller } from "../helpers/caller.js";
import { decodeHlc } from "@oxygen/shared";

let ctx: TestEventContext;
let caller: ReturnType<typeof makeCaller>;
let runnerSeq: number;
let cardedRunnerSeq: number;

const CARD = 82001;

beforeAll(async () => {
  ctx = await createTestEvent("journal-emit");
  caller = makeCaller(ctx.event);
  const cls = await ctx.db.class.create({
    data: { eventId: ctx.eventId, name: "H21" },
    select: { id: true },
  });
  const cardless = await ctx.db.runner.create({
    data: {
      eventId: ctx.eventId,
      name: "Cardless Carl",
      classId: cls.id,
      clubName: "OK Test",
    },
    select: { seq: true },
  });
  runnerSeq = cardless.seq;
  const carded = await ctx.db.runner.create({
    data: {
      eventId: ctx.eventId,
      name: "Carded Cara",
      classId: cls.id,
      clubName: "OK Test",
      cardNo: CARD,
    },
    select: { seq: true },
  });
  cardedRunnerSeq = carded.seq;
});

afterAll(async () => {
  await ctx.cleanup();
  await disconnect();
});

describe("recordFinish and applyResult input validation (RES-24)", () => {
  const bad = (code: string) => ({ code });
  it("recordFinish refuses an unknown status and an out-of-day time, writing nothing", async () => {
    const before = await ctx.db.journalEntry.count({ where: { eventId: ctx.eventId } });
    await expect(
      caller.race.recordFinish({ id: runnerSeq, finishTimeAbsolute: 366000, status: 999 }),
    ).rejects.toMatchObject(bad("BAD_REQUEST"));
    await expect(
      caller.race.recordFinish({ id: runnerSeq, finishTimeAbsolute: 999_999_999 }),
    ).rejects.toMatchObject(bad("BAD_REQUEST"));
    await expect(
      caller.race.recordFinish({ id: runnerSeq, finishTime: 864_000 }),
    ).rejects.toMatchObject(bad("BAD_REQUEST"));
    expect(await ctx.db.journalEntry.count({ where: { eventId: ctx.eventId } })).toBe(before);
  });

  it("applyResult refuses status 999 and finish/start 999999999 with BAD_REQUEST", async () => {
    await expect(
      caller.cardReadout.applyResult({ runnerId: runnerSeq, status: 999, finishTime: 366000, startTime: 360000 }),
    ).rejects.toMatchObject(bad("BAD_REQUEST"));
    await expect(
      caller.cardReadout.applyResult({ runnerId: runnerSeq, status: 1, finishTime: 999_999_999, startTime: 360000 }),
    ).rejects.toMatchObject(bad("BAD_REQUEST"));
    await expect(
      caller.cardReadout.applyResult({ runnerId: runnerSeq, status: 1, finishTime: 366000, startTime: 999_999_999 }),
    ).rejects.toMatchObject(bad("BAD_REQUEST"));
  });

  it("runner.update, create and bulkUpdate refuse out-of-day times; 0 still clears", async () => {
    await expect(
      caller.runner.update({ id: runnerSeq, finishTime: 999_999_999 } as never),
    ).rejects.toMatchObject(bad("BAD_REQUEST"));
    await expect(
      caller.runner.update({ id: runnerSeq, startTime: 864_000 } as never),
    ).rejects.toMatchObject(bad("BAD_REQUEST"));
    await expect(
      caller.runner.bulkUpdate({ ids: [runnerSeq], startTime: 999_999_999 }),
    ).rejects.toMatchObject(bad("BAD_REQUEST"));
    await expect(
      caller.runner.create({ name: "Late", classId: 1, startTime: 999_999_999 } as never),
    ).rejects.toMatchObject(bad("BAD_REQUEST"));
    await expect(caller.runner.update({ id: runnerSeq, finishTime: 0 } as never)).resolves.toBeDefined();
  });

  it("runner.update refuses an unknown status", async () => {
    await expect(
      caller.runner.update({ id: runnerSeq, status: 999 } as never),
    ).rejects.toMatchObject(bad("BAD_REQUEST"));
  });
});

describe("recordFinish journaling (Step 2a)", () => {
  it("emits a finish.adjusted entry in the same call as the runner update", async () => {
    const finishAbs = 366000; // absolute deciseconds
    await caller.race.recordFinish({ id: cardedRunnerSeq, finishTimeAbsolute: finishAbs });

    const entry = await ctx.db.journalEntry.findFirst({
      where: { eventId: ctx.eventId, type: "finish.adjusted" },
      orderBy: { hlc: "desc" },
    });
    expect(entry).not.toBeNull();
    // Server-originated: node station id, no actor yet, schema v1.
    expect(entry!.stationId).toBe("cloud");
    expect(entry!.actorId).toBeNull();
    expect(entry!.schemaVersion).toBe(1);
    // Payload references the runner by card AND seq, times in absolute ds.
    expect(entry!.payload).toMatchObject({
      cardNo: CARD,
      runnerId: cardedRunnerSeq,
      finishTime: finishAbs,
    });
    // Stamped by the server clock, not synthesised from zero.
    const hlc = decodeHlc(entry!.hlc);
    expect(hlc.physical).toBeGreaterThan(1_700_000_000_000);
  });

  it("journals a cardless finish with cardNo null and the seq reference", async () => {
    await caller.race.recordFinish({
      id: runnerSeq,
      finishTimeAbsolute: 370000,
      status: 1,
    });
    const entry = await ctx.db.journalEntry.findFirst({
      where: { eventId: ctx.eventId, type: "finish.adjusted" },
      orderBy: { hlc: "desc" },
    });
    expect(entry!.payload).toMatchObject({
      cardNo: null,
      runnerId: runnerSeq,
      finishTime: 370000,
      status: 1,
    });
  });

  it("mints strictly increasing HLCs across consecutive mutations", async () => {
    await caller.race.recordFinish({ id: runnerSeq, finishTimeAbsolute: 371000, allowOverwrite: true });
    await caller.race.recordFinish({ id: runnerSeq, finishTimeAbsolute: 372000, allowOverwrite: true });
    const entries = await ctx.db.journalEntry.findMany({
      where: { eventId: ctx.eventId, type: "finish.adjusted" },
      orderBy: { hlc: "asc" },
      select: { hlc: true },
    });
    expect(entries.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < entries.length; i++) {
      expect(entries[i].hlc).toBeGreaterThan(entries[i - 1].hlc);
    }
  });

  it("does not journal when the table write fails (same transaction)", async () => {
    const before = await ctx.db.journalEntry.count({
      where: { eventId: ctx.eventId, type: "finish.adjusted" },
    });
    await expect(
      caller.race.recordFinish({ id: 999999, finishTimeAbsolute: 366000 }),
    ).rejects.toThrow();
    const after = await ctx.db.journalEntry.count({
      where: { eventId: ctx.eventId, type: "finish.adjusted" },
    });
    expect(after).toBe(before);
  });
});
