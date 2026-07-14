/**
 * Integration tests for journal completeness across the race-critical set
 * (pivot Step 2b). Every race-critical mutation must emit its journal entry
 * in the same call as the table write, with a node-portable payload
 * (absolute deciseconds, class/runner `seq`, numeric statuses, battery in
 * volts). `recordFinish` (Step 2a) is covered by `journal-emit.test.ts`;
 * this suite covers the rest: card readouts, results, manual punches, runner
 * CRUD + bulk edits, card linking, and the draw. See
 * docs/future-architecture.md § "Planned" Step 2.
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
let courseSeq: number;

async function latestEntry(type: string) {
  return ctx.db.journalEntry.findFirst({
    where: { eventId: ctx.eventId, type },
    orderBy: { hlc: "desc" },
  });
}

beforeAll(async () => {
  ctx = await createTestEvent("journal-completeness");
  caller = makeCaller(ctx.event);
  const course = await caller.course.create({ name: "Blue", length: 4200 });
  courseSeq = course.id;
  const cls = await caller.class.create({ name: "H21", courseId: courseSeq });
  classSeq = cls.id;
});

afterAll(async () => {
  await ctx.cleanup();
  await disconnect();
});

describe("cardReadout.storeReadout → card.read", () => {
  it("journals the readout with absolute-ds punches and volts battery", async () => {
    await caller.cardReadout.storeReadout({
      cardNo: 500123,
      cardType: "SI11",
      punches: [
        { controlCode: 31, time: 361000 },
        { controlCode: 32, time: 362000 },
      ],
      startTime: 360000,
      finishTime: 363000,
      voltageMv: 3000, // mV in — payload must be volts out
      stationId: "readout-1",
    });

    const entry = await latestEntry("card.read");
    expect(entry).not.toBeNull();
    expect(entry!.stationId).toBe("readout-1");
    const p = entry!.payload as {
      cardNo: number;
      punches: Array<{ controlCode: number; time: number }>;
      startTime: number;
      finishTime: number;
      batteryVoltage: number;
    };
    expect(p.cardNo).toBe(500123);
    expect(p.punches).toEqual([
      { controlCode: 31, time: 361000 },
      { controlCode: 32, time: 362000 },
    ]);
    expect(p.startTime).toBe(360000);
    expect(p.finishTime).toBe(363000);
    // 3000 mV → 3.0 V (offline-emit payload contract is volts).
    expect(p.batteryVoltage).toBeCloseTo(3.0, 5);
  });
});

describe("cardReadout.applyResult → result.applied", () => {
  it("journals status + absolute start/finish with the card reference", async () => {
    const runner = await caller.runner.create({
      name: "Result Rita",
      classId: classSeq,
      cardNo: 500200,
      clubName: "OK Test",
    });
    await caller.cardReadout.applyResult({
      runnerId: runner.id,
      status: 1,
      finishTime: 366000,
      startTime: 360000,
    });

    const entry = await latestEntry("result.applied");
    expect(entry).not.toBeNull();
    expect(entry!.payload).toMatchObject({
      cardNo: 500200,
      runnerId: runner.id,
      status: 1,
      finishTime: 366000,
      startTime: 360000,
    });
  });
});

describe("cardReadout.addPunch → punch.recorded", () => {
  it("journals the manual punch with the absolute time and origin", async () => {
    await caller.cardReadout.addPunch({
      cardNo: 500300,
      controlCode: 45,
      time: 364500,
    });
    const entry = await latestEntry("punch.recorded");
    expect(entry).not.toBeNull();
    expect(entry!.payload).toMatchObject({
      cardNo: 500300,
      controlCode: 45,
      time: 364500,
      origin: "manual",
    });
  });
});

describe("runner CRUD journaling", () => {
  it("create → runner.registered (seq class ref, absolute start)", async () => {
    const created = await caller.runner.create({
      name: "New Nils",
      classId: classSeq,
      cardNo: 500400,
      clubName: "OK New",
      startTime: 360000,
    });
    const entry = await latestEntry("runner.registered");
    expect(entry).not.toBeNull();
    const p = entry!.payload as {
      name: string;
      classId: number;
      cardNo: number;
      startTime: number;
      tempId: string;
    };
    expect(p.name).toBe("New Nils");
    expect(p.classId).toBe(classSeq);
    expect(p.cardNo).toBe(500400);
    expect(p.startTime).toBe(360000);
    // tempId is the freshly-minted runner UUID.
    expect(p.tempId).toMatch(/[0-9a-f-]{36}/);
    void created;
  });

  it("update → runner.updated with the pre-edit card + portable fields", async () => {
    const r = await caller.runner.create({
      name: "Edit Ed",
      classId: classSeq,
      cardNo: 500500,
      clubName: "OK Edit",
    });
    await caller.runner.update({
      id: r.id,
      name: "Edited Ed",
      status: 4, // DNF
      finishTime: 367000,
    });
    const entry = await latestEntry("runner.updated");
    expect(entry).not.toBeNull();
    const p = entry!.payload as {
      cardNo: number;
      runnerId: number;
      fields: Record<string, unknown>;
    };
    expect(p.cardNo).toBe(500500);
    expect(p.runnerId).toBe(r.id);
    expect(p.fields).toMatchObject({
      name: "Edited Ed",
      status: 4,
      finishTime: 367000,
    });
    // Must NOT carry DB-shaped routing keys.
    expect(p.fields).not.toHaveProperty("id");
    expect(p.fields).not.toHaveProperty("data");
  });

  it("delete → runner.deleted", async () => {
    const r = await caller.runner.create({
      name: "Doomed Dan",
      classId: classSeq,
      cardNo: 500600,
      clubName: "OK Del",
    });
    await caller.runner.delete({ id: r.id });
    const entry = await latestEntry("runner.deleted");
    expect(entry).not.toBeNull();
    expect(entry!.payload).toMatchObject({ cardNo: 500600, runnerId: r.id });
  });

  it("bulkDns → one runner.updated (status DNS) per runner", async () => {
    const a = await caller.runner.create({
      name: "Bulk A",
      classId: classSeq,
      cardNo: 500700,
      clubName: "OK Bulk",
    });
    const b = await caller.runner.create({
      name: "Bulk B",
      classId: classSeq,
      cardNo: 500701,
      clubName: "OK Bulk",
    });
    const before = await ctx.db.journalEntry.count({
      where: { eventId: ctx.eventId, type: "runner.updated" },
    });
    await caller.runner.bulkDns({ ids: [a.id, b.id] });
    const after = await ctx.db.journalEntry.count({
      where: { eventId: ctx.eventId, type: "runner.updated" },
    });
    expect(after - before).toBe(2);

    const entries = await ctx.db.journalEntry.findMany({
      where: { eventId: ctx.eventId, type: "runner.updated" },
      orderBy: { hlc: "desc" },
      take: 2,
    });
    for (const e of entries) {
      expect((e.payload as { fields: { status: number } }).fields.status).toBe(
        20,
      );
    }
  });
});

describe("cardReadout.linkCardToRunner → runner.updated", () => {
  it("journals the card assignment on the target runner", async () => {
    const r = await caller.runner.create({
      name: "Linkless Lena",
      classId: classSeq,
      clubName: "OK Link",
    });
    await caller.cardReadout.linkCardToRunner({
      cardNo: 500800,
      runnerId: r.id,
    });
    const entry = await latestEntry("runner.updated");
    expect(entry).not.toBeNull();
    const p = entry!.payload as {
      runnerId: number;
      fields: { cardNo: number };
    };
    expect(p.runnerId).toBe(r.id);
    expect(p.fields.cardNo).toBe(500800);
  });
});

describe("draw.execute → start.adjusted", () => {
  it("journals one start.adjusted per drawn runner with absolute times", async () => {
    // Isolated class so the draw only touches these three runners.
    const drawCls = await caller.class.create({
      name: "D-Draw",
      courseId: courseSeq,
    });
    const cards = [500900, 500901, 500902];
    for (let i = 0; i < cards.length; i++) {
      await caller.runner.create({
        name: `Draw ${i}`,
        classId: drawCls.id,
        cardNo: cards[i],
        clubName: "OK Draw",
      });
    }

    const before = await ctx.db.journalEntry.count({
      where: { eventId: ctx.eventId, type: "start.adjusted" },
    });
    const res = await caller.draw.execute({
      classes: [{ classId: drawCls.id, method: "random", interval: 600 }],
      settings: {
        firstStart: 360000,
        baseInterval: 600,
        maxParallelStarts: 1,
        detectCourseOverlap: false,
      },
    });
    expect(res.totalDrawn).toBe(3);
    const after = await ctx.db.journalEntry.count({
      where: { eventId: ctx.eventId, type: "start.adjusted" },
    });
    expect(after - before).toBe(3);

    // Payloads carry absolute deciseconds (>= firstStart) and resolve by card.
    const entries = await ctx.db.journalEntry.findMany({
      where: { eventId: ctx.eventId, type: "start.adjusted" },
      orderBy: { hlc: "desc" },
      take: 3,
    });
    for (const e of entries) {
      const p = e.payload as { cardNo: number; startTime: number };
      expect(cards).toContain(p.cardNo);
      expect(p.startTime).toBeGreaterThanOrEqual(360000);
    }
  });
});
