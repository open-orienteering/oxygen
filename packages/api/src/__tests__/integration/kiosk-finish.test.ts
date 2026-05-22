/**
 * Integration tests for the kiosk-finish flow.
 *
 * Walks a runner through the same sequence the kiosk station does in
 * production:
 *   1. operator adds the runner + assigns class/course (createRunner)
 *   2. SI card is inserted at the finish station —
 *      `cardReadout.storeReadout` writes the immutable readout log,
 *      materialises the `cards` row (with check/start/finish punches
 *      synthesised from the card header), and links the card to the
 *      registered runner via `runner.cardId`.
 *   3. the kiosk asks for the receipt payload via `race.finishReceipt`
 *      which runs the matcher on-demand and returns split times +
 *      status (1=OK, 3=MP, etc).
 *   4. operator confirms the result, which (in production) goes through
 *      `cardReadout.applyResult` — exercised separately.
 *
 * Each test sets up its own course/class/runner so they're independent.
 */

import { describe, it, expect, afterAll } from "vitest";
import { createTestEvent, disconnect } from "../helpers/test-db.js";
import { makeCaller } from "../helpers/caller.js";

afterAll(async () => {
  await disconnect();
});

interface Fixture {
  ctx: Awaited<ReturnType<typeof createTestEvent>>;
  caller: ReturnType<typeof makeCaller>;
  runnerSeq: number;
  cardNo: number;
}

async function buildFixture(label: string): Promise<Fixture> {
  const ctx = await createTestEvent(label);
  const caller = makeCaller(ctx.event);

  const controls = await Promise.all([
    ctx.db.control.create({
      data: { eventId: ctx.eventId, codes: "31", name: "" },
    }),
    ctx.db.control.create({
      data: { eventId: ctx.eventId, codes: "32", name: "" },
    }),
    ctx.db.control.create({
      data: { eventId: ctx.eventId, codes: "33", name: "" },
    }),
  ]);

  const course = await ctx.db.course.create({
    data: { eventId: ctx.eventId, name: "K1", lengthM: 2500 },
  });
  await ctx.db.courseControl.createMany({
    data: controls.map((c, i) => ({
      courseId: course.id,
      controlId: c.id,
      position: i + 1,
    })),
  });

  const cls = await ctx.db.class.create({
    data: { eventId: ctx.eventId, name: "K1", courseId: course.id },
  });

  const cardNo = 555_001;
  // All times in absolute *deciseconds* (10 ticks per second), the
  // wire contract used throughout the kiosk pipeline. ZeroTime
  // defaults to 09:00:00 = 324_000 ds.
  // 10:00:00 absolute = 360_000 ds.
  const runner = await caller.runner.create({
    name: "Kiosk Test Runner",
    classId: cls.seq,
    cardNo,
    startTime: 360_000,
  });

  return { ctx, caller, runnerSeq: runner.id as number, cardNo };
}

describe("kiosk finish flow", () => {
  it("receipt carries per-leg distances when the course has legs populated", async () => {
    const f = await buildFixture("kf-legs");
    try {
      // Populate the legs string the importer writes: 4 entries
      // (3 controls + finish). Receipt splits should mirror legs[0..2]
      // for the three controls; the finish leg is the last one and is
      // consumed by the receipt printer separately.
      await f.ctx.db.course.updateMany({
        where: { eventId: f.ctx.eventId, name: "K1" },
        data: { legs: "420;310;180;240;" },
      });

      await f.caller.cardReadout.storeReadout({
        cardNo: f.cardNo,
        cardType: "SI11",
        punches: [
          { controlCode: 31, time: 366_000 },
          { controlCode: 32, time: 372_000 },
          { controlCode: 33, time: 378_000 },
        ],
        startTime: 360_000,
        finishTime: 384_000,
      });

      const receipt = await f.caller.race.finishReceipt({
        runnerId: f.runnerSeq,
      });
      expect(receipt).not.toBeNull();
      // `controls` is the legacy nested split list used by the kiosk
      // receipt printer; each entry carries the leg-length leading
      // into that control.
      expect(receipt!.controls.map((s) => s.legLength)).toEqual([420, 310, 180]);
    } finally {
      await f.ctx.cleanup();
    }
  });

  it("complete clean run → OK status + finishTime + matching splits", async () => {
    const f = await buildFixture("kf-ok");
    try {
      // Times in absolute deciseconds: 10:00 start → 31 at 10:01 →
      // 32 at 10:02 → 33 at 10:03 → finish at 10:04.
      const res = await f.caller.cardReadout.storeReadout({
        cardNo: f.cardNo,
        cardType: "SI11",
        punches: [
          { controlCode: 31, time: 366_000 },
          { controlCode: 32, time: 372_000 },
          { controlCode: 33, time: 378_000 },
        ],
        startTime: 360_000,
        finishTime: 384_000,
      });
      expect(res.cardId).toBeDefined();
      expect(res.linkedRunnerId).toBe(f.runnerSeq);
      expect(res.punchesRelevant).toBe(true);

      const linked = await f.ctx.db.runner.findFirst({
        where: { eventId: f.ctx.eventId, cardNo: f.cardNo },
      });
      expect(linked?.cardId).not.toBeNull();

      const receipt = await f.caller.race.finishReceipt({
        runnerId: f.runnerSeq,
      });
      expect(receipt).not.toBeNull();
      // status 1 = OK (matcher's wire-level numeric encoding).
      expect(receipt!.status).toBe(1);
      expect(receipt!.runningTime).toBeGreaterThan(0);
      expect(receipt!.splits.length).toBe(3);
      expect(receipt!.splits.map((s) => s.code)).toEqual([31, 32, 33]);
      for (const s of receipt!.splits) {
        expect(s.time).toBeGreaterThanOrEqual(360_000);
      }
      expect(receipt!.course?.name).toBe("K1");
    } finally {
      await f.ctx.cleanup();
    }
  });

  it("missing punch → MissingPunch in receipt; matcher flags the skipped control", async () => {
    const f = await buildFixture("kf-mp");
    try {
      // Skip control 32 — the matcher should report MP (status=3)
      // and flag control 32 as missing in the controls array.
      await f.caller.cardReadout.storeReadout({
        cardNo: f.cardNo,
        cardType: "SI11",
        punches: [
          { controlCode: 31, time: 366_000 },
          { controlCode: 33, time: 378_000 },
        ],
        startTime: 360_000,
        finishTime: 384_000,
      });

      const receipt = await f.caller.race.finishReceipt({
        runnerId: f.runnerSeq,
      });
      expect(receipt).not.toBeNull();
      expect(receipt!.status).toBe(3);
      const missed = receipt!.controls.find((s) => s.controlCode === 32);
      expect(missed?.status).toBe("missing");
    } finally {
      await f.ctx.cleanup();
    }
  });

  it("applyResult writes the matcher's verdict back to the runner row", async () => {
    const f = await buildFixture("kf-apply");
    try {
      await f.caller.cardReadout.storeReadout({
        cardNo: f.cardNo,
        cardType: "SI11",
        punches: [
          { controlCode: 31, time: 366_000 },
          { controlCode: 32, time: 372_000 },
          { controlCode: 33, time: 378_000 },
        ],
        startTime: 360_000,
        finishTime: 384_000,
      });

      // Receipt → operator confirms → applyResult persists.
      const receipt = await f.caller.race.finishReceipt({
        runnerId: f.runnerSeq,
      });
      expect(receipt).not.toBeNull();
      await f.caller.cardReadout.applyResult({
        runnerId: f.runnerSeq,
        status: receipt!.status,
        startTime: receipt!.startTime,
        finishTime: receipt!.finishTime,
      });

      const runner = await f.ctx.db.runner.findFirst({
        where: { eventId: f.ctx.eventId, cardNo: f.cardNo },
      });
      expect(runner?.status).toBe("ok");
      // ZeroTime-relative finish: 384_000 - 324_000 = 60_000.
      expect(runner?.finishTime).toBe(60_000);
    } finally {
      await f.ctx.cleanup();
    }
  });

  it("unregistered card → readout stored but no runner mutation", async () => {
    const f = await buildFixture("kf-stray");
    try {
      // Different card number — no runner is linked.
      const res = await f.caller.cardReadout.storeReadout({
        cardNo: 9_999_999,
        cardType: "SI11",
        punches: [{ controlCode: 31, time: 366_000 }],
        startTime: 360_000,
        finishTime: 370_000,
      });
      expect(res.cardId).toBeDefined();

      // Registered runner untouched.
      const registered = await f.ctx.db.runner.findFirst({
        where: { eventId: f.ctx.eventId, cardNo: f.cardNo },
      });
      expect(registered?.status).toBe("unknown");
      expect(registered?.finishTime).toBe(0);

      // Card row still gets created (matcher writes it for "stray"
      // cards too so the operator can manually link it later).
      const strayCard = await f.ctx.db.card.findFirst({
        where: { eventId: f.ctx.eventId, cardNo: 9_999_999 },
      });
      expect(strayCard).not.toBeNull();
    } finally {
      await f.ctx.cleanup();
    }
  });

  it("repeated readouts overwrite the card row (no duplicate inserts)", async () => {
    const f = await buildFixture("kf-replay");
    try {
      // First — partial readout (no finish punch in card → still
      // running).
      await f.caller.cardReadout.storeReadout({
        cardNo: f.cardNo,
        cardType: "SI11",
        punches: [{ controlCode: 31, time: 366_000 }],
        startTime: 360_000,
      });
      // Second — full readout. The card row should be updated, not
      // duplicated.
      await f.caller.cardReadout.storeReadout({
        cardNo: f.cardNo,
        cardType: "SI11",
        punches: [
          { controlCode: 31, time: 366_000 },
          { controlCode: 32, time: 372_000 },
          { controlCode: 33, time: 378_000 },
        ],
        startTime: 360_000,
        finishTime: 384_000,
      });

      // Card row should be updated in-place, not duplicated.
      const cards = await f.ctx.db.card.count({
        where: { eventId: f.ctx.eventId, cardNo: f.cardNo },
      });
      expect(cards).toBe(1);

      // Read counter bumped to 2.
      const card = await f.ctx.db.card.findFirst({
        where: { eventId: f.ctx.eventId, cardNo: f.cardNo },
      });
      expect(card?.readCount).toBe(2);

      // Receipt now reflects the complete run.
      const receipt = await f.caller.race.finishReceipt({
        runnerId: f.runnerSeq,
      });
      expect(receipt!.status).toBe(1);
    } finally {
      await f.ctx.cleanup();
    }
  });
});
