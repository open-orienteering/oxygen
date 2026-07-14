/**
 * Integration tests for server-originated journal entries (pivot Step 2).
 *
 * `appendJournal` writes the journal row in the same transaction as the table
 * write; `race.recordFinish` is the first journaled mutation (the 2a pattern
 * proof — the rest of the race-critical set follows in 2b). See
 * docs/future-architecture.md § "Planned" Step 2.
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
    await caller.race.recordFinish({ id: runnerSeq, finishTimeAbsolute: 371000 });
    await caller.race.recordFinish({ id: runnerSeq, finishTimeAbsolute: 372000 });
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
