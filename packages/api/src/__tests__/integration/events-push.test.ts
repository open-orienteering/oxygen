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
import { randomUUID } from "node:crypto";
import {
  createTestEvent,
  disconnect,
  type TestEventContext,
} from "../helpers/test-db.js";
import { makeCaller } from "../helpers/caller.js";

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
