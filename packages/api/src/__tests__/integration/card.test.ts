/**
 * Integration tests for the cardReadout tRPC router.
 *
 * Covers storeReadout (the main write path during a real race),
 * the card→runner linking that happens automatically when the card
 * number matches a registered runner, manual link/unlink via
 * linkCardToRunner, and the addPunch / removePunch / updatePunchTime
 * trio that backs the runner-detail editor.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
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
  ctx = await createTestEvent("card");
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

describe("cardReadout.storeReadout", () => {
  it("creates a CardReadout + Card row and returns the new ids", async () => {
    const res = await caller.cardReadout.storeReadout({
      cardNo: 100001,
      cardType: "SI Card 9",
      punches: [
        { controlCode: 31, time: 100_000 },
        { controlCode: 32, time: 100_300 },
      ],
      startTime: 100_000,
      finishTime: 100_600,
    });
    expect(res.cardId).toBeGreaterThan(0);
    expect(res.linkedRunnerId).toBeNull();
    expect(typeof res.readoutId).toBe("string");

    const card = await ctx.db.card.findFirst({
      where: { eventId: ctx.eventId, cardNo: 100001 },
    });
    expect(card?.readCount).toBe(1);
  });

  it("auto-links the card to a runner registered with the same cardNo", async () => {
    await caller.runner.create({
      name: "Linked Runner",
      classId: classSeq,
      cardNo: 200001,
    });
    const res = await caller.cardReadout.storeReadout({
      cardNo: 200001,
      cardType: "SI Card 9",
      punches: [{ controlCode: 41, time: 200_100 }],
    });
    expect(res.linkedRunnerId).not.toBeNull();
  });

  it("upserts on subsequent readouts of the same card (no duplicate rows)", async () => {
    await caller.cardReadout.storeReadout({
      cardNo: 300001,
      cardType: "SI Card 9",
      punches: [{ controlCode: 51, time: 300_100 }],
    });
    await caller.cardReadout.storeReadout({
      cardNo: 300001,
      cardType: "SI Card 9",
      punches: [
        { controlCode: 51, time: 300_100 },
        { controlCode: 52, time: 300_200 },
      ],
    });
    const cards = await ctx.db.card.findMany({
      where: { eventId: ctx.eventId, cardNo: 300001 },
    });
    expect(cards.length).toBe(1);
    expect(cards[0].readCount).toBe(2);
  });
});

describe("cardReadout.linkCardToRunner", () => {
  it("links a previously-unlinked card by cardNo", async () => {
    await caller.cardReadout.storeReadout({
      cardNo: 400001,
      cardType: "SI Card 9",
      punches: [],
    });
    const runner = await caller.runner.create({
      name: "Manual Link",
      classId: classSeq,
      cardNo: 0,
    });
    await caller.cardReadout.linkCardToRunner({
      cardNo: 400001,
      runnerId: runner.id,
    });
    const detail = await caller.runner.getById({ id: runner.id });
    expect(detail.cardNo).toBe(400001);
  });

  it("unlinks the card by clearing the runner's cardNo", async () => {
    const runner = await caller.runner.create({
      name: "Unlinkable",
      classId: classSeq,
      cardNo: 500001,
    });
    await caller.cardReadout.storeReadout({
      cardNo: 500001,
      cardType: "SI Card 9",
      punches: [],
    });
    await caller.cardReadout.linkCardToRunner({
      cardNo: 500001,
      runnerId: null,
    });
    const detail = await caller.runner.getById({ id: runner.id });
    expect(detail.cardNo).toBe(0);
  });

  it("rejects calls with neither cardNo nor cardId", async () => {
    await expect(
      caller.cardReadout.linkCardToRunner({ runnerId: null }),
    ).rejects.toThrow(/cardNo or cardId/i);
  });
});

describe("cardReadout.readoutHistory", () => {
  it("returns the stored punches, battery, owner and metadata fields", async () => {
    const cardNo = 700001;
    await caller.cardReadout.storeReadout({
      cardNo,
      cardType: "SI Card 10",
      punches: [
        { controlCode: 31, time: 700_100 },
        { controlCode: 32, time: 700_400 },
      ],
      voltageMv: 2870,
      ownerData: { firstName: "Karin", lastName: "Karta", club: "OK Skogen" },
      metadata: { batteryDate: "2024-03-01", clearCount: 42 },
    });

    const history = await caller.cardReadout.readoutHistory({ cardNo });
    expect(history.length).toBe(1);
    const h = history[0];
    expect(h.cardNo).toBe(cardNo);
    expect(h.cardType).toBe("SI Card 10");
    // Punch times stay in absolute deciseconds (the API contract).
    expect(h.punches).toEqual([
      { controlCode: 31, time: 700_100 },
      { controlCode: 32, time: 700_400 },
    ]);
    // Stored as integer millivolts, returned as volts.
    expect(h.batteryVoltage).toBeCloseTo(2.87);
    expect(h.ownerData).toMatchObject({
      firstName: "Karin",
      lastName: "Karta",
      club: "OK Skogen",
    });
    expect(h.metadata).toMatchObject({
      batteryDate: "2024-03-01",
      clearCount: 42,
    });
    expect(typeof h.readAt).toBe("string");
  });

  it("returns null battery voltage when the station reported none", async () => {
    const cardNo = 700002;
    await caller.cardReadout.storeReadout({
      cardNo,
      cardType: "SI Card 9",
      punches: [],
    });
    const [h] = await caller.cardReadout.readoutHistory({ cardNo });
    expect(h.batteryVoltage).toBeNull();
    expect(h.ownerData).toBeNull();
    expect(h.metadata).toBeNull();
  });

  it("returns readouts newest-first, one row per readout", async () => {
    const cardNo = 700003;
    await caller.cardReadout.storeReadout({
      cardNo,
      cardType: "SI Card 9",
      punches: [{ controlCode: 61, time: 700_100 }],
      readAt: new Date("2026-08-01T10:00:00Z").toISOString(),
    });
    await caller.cardReadout.storeReadout({
      cardNo,
      cardType: "SI Card 9",
      punches: [
        { controlCode: 61, time: 700_100 },
        { controlCode: 62, time: 700_200 },
      ],
      readAt: new Date("2026-08-01T11:00:00Z").toISOString(),
    });
    const history = await caller.cardReadout.readoutHistory({ cardNo });
    expect(history.length).toBe(2);
    expect(history[0].punches.length).toBe(2);
    expect(history[1].punches.length).toBe(1);
  });
});

describe("cardReadout.addPunch / removePunch / updatePunchTime", () => {
  it("appends, removes, and adjusts punches around an existing card", async () => {
    const cardNo = 600001;
    await caller.cardReadout.storeReadout({
      cardNo,
      cardType: "SI Card 9",
      punches: [],
    });
    await caller.cardReadout.addPunch({
      cardNo,
      controlCode: 71,
      time: 600_100,
    });
    const punches = await ctx.db.punch.findMany({
      where: { eventId: ctx.eventId, cardNo, removed: false },
    });
    expect(punches.length).toBe(1);

    const punchId = punches[0].id;
    await caller.cardReadout.updatePunchTime({ punchId, time: 600_500 });
    const updated = await ctx.db.punch.findUnique({ where: { id: punchId } });
    // Stored as ZeroTime-relative — confirm it changed.
    expect(updated?.time).not.toBe(punches[0].time);

    await caller.cardReadout.removePunch({ punchId });
    const after = await ctx.db.punch.findUnique({ where: { id: punchId } });
    expect(after?.removed).toBe(true);
  });
});
