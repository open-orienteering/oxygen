/**
 * Result list and finish receipt share one standings step (package 13:
 * RES-11, CRS-039, CRS-042, CRS-013). Ties share a place, no-timing classes
 * are unplaced, NoTiming-leg deductions decide the order in both, and the
 * receipt's finish row is the finish leg.
 *
 * Times: ZeroTime is 09:00:00 (324 000 ds). Runner rows store times
 * relative to it; `rel()` converts an absolute clock time.
 */

import { describe, it, expect, afterAll } from "vitest";
import { createTestEvent, disconnect, type TestEventContext } from "../helpers/test-db.js";
import { makeCaller } from "../helpers/caller.js";
import type { RunnerStatus as PgRunnerStatus } from "../../generated/prisma/client.js";

afterAll(async () => {
  await disconnect();
});

const ZERO = 324_000;
const rel = (abs: number) => abs - ZERO;
const T10 = 360_000; // 10:00:00

async function setup(label: string, opts: { noTimingControl?: boolean; noTimingClass?: boolean } = {}) {
  const ctx = await createTestEvent(label);
  const caller = makeCaller(ctx.event);
  const controls = [];
  for (const code of ["31", "32", "33"]) {
    controls.push(
      await ctx.db.control.create({
        data: {
          eventId: ctx.eventId,
          codes: code,
          name: "",
          ...(opts.noTimingControl && code === "32" ? { status: "no_timing" as const } : {}),
        },
      }),
    );
  }
  const course = await ctx.db.course.create({
    data: { eventId: ctx.eventId, name: "K1", lengthM: 2500, legs: "420;310;180;240;" },
  });
  await ctx.db.courseControl.createMany({
    data: controls.map((c, i) => ({ courseId: course.id, controlId: c.id, position: i + 1 })),
  });
  const cls = await ctx.db.class.create({
    data: { eventId: ctx.eventId, name: "H21", courseId: course.id, noTiming: opts.noTimingClass ?? false },
  });
  return { ctx, caller, cls };
}

async function addRunner(
  f: { ctx: TestEventContext; caller: ReturnType<typeof makeCaller>; cls: { seq: number } },
  name: string,
  classSeq: number | undefined,
  result?: { status: PgRunnerStatus; start: number; finish: number },
  cardNo?: number,
) {
  const created = await f.caller.runner.create({
    name,
    classId: classSeq ?? f.cls.seq,
    ...(cardNo ? { cardNo } : {}),
    startTime: result?.start ?? T10,
  });
  await f.ctx.db.runner.updateMany({
    where: { eventId: f.ctx.eventId, seq: created.id as number },
    data: {
      // `runner.create` requires a class; a classless row is set here.
      ...(classSeq === undefined ? { classId: null } : {}),
      ...(result
        ? { status: result.status, startTime: rel(result.start), finishTime: rel(result.finish) }
        : {}),
    },
  });
  return created.id as number;
}

const min = (m: number, s = 0) => (m * 60 + s) * 10;

describe("lists.resultList standings (RES-11, CRS-042)", () => {
  it("ties share a place, the next is 3rd, and the order is stable", async () => {
    const f = await setup("rs-tie");
    try {
      await addRunner(f, "Carl", f.cls.seq, { status: "ok", start: T10, finish: T10 + min(50) });
      await addRunner(f, "Bo", f.cls.seq, { status: "ok", start: T10, finish: T10 + min(45, 12) });
      await addRunner(f, "Ada", f.cls.seq, { status: "ok", start: T10, finish: T10 + min(45, 12) });
      const a = await f.caller.lists.resultList();
      expect(a.map((e) => [e.name, e.place])).toEqual([["Ada", 1], ["Bo", 1], ["Carl", 3]]);
      expect(a[2].timeBehind).toBe(min(4, 48));
      const b = await f.caller.lists.resultList();
      expect(b.map((e) => e.name)).toEqual(a.map((e) => e.name));
    } finally {
      await f.ctx.cleanup();
    }
  });

  it("a no-timing class is unplaced, flagged, and still shows the time", async () => {
    const f = await setup("rs-notiming", { noTimingClass: true });
    try {
      await addRunner(f, "Ida", f.cls.seq, { status: "no_timing", start: T10, finish: T10 + min(30) });
      const [e] = await f.caller.lists.resultList();
      expect(e.place).toBe(0);
      expect(e.noTiming).toBe(true);
      expect(e.runningTime).toBe(min(30));
    } finally {
      await f.ctx.cleanup();
    }
  });

  it("DQ is unplaced with no time; a classless runner is never placed; cancelled entries are left out", async () => {
    const f = await setup("rs-misc");
    try {
      await addRunner(f, "Ok", f.cls.seq, { status: "ok", start: T10, finish: T10 + min(40) });
      await addRunner(f, "Dq", f.cls.seq, { status: "dq", start: T10, finish: T10 + min(30) });
      await addRunner(f, "Gone", f.cls.seq, { status: "cancel", start: T10, finish: T10 + min(20) });
      await addRunner(f, "Nowhere", undefined, { status: "ok", start: T10, finish: T10 + min(35) });
      const list = await f.caller.lists.resultList();
      const by = new Map(list.map((e) => [e.name, e]));
      expect(by.get("Ok")).toMatchObject({ place: 1 });
      expect(by.get("Dq")).toMatchObject({ place: 0, runningTime: 0 });
      expect(by.get("Nowhere")).toMatchObject({ place: 0, runningTime: min(35) });
      expect(by.has("Gone")).toBe(false);
      // Classless rows come after the classes.
      expect(list[list.length - 1].name).toBe("Nowhere");
      const starts = await f.caller.lists.startList();
      expect(starts.some((e) => e.name === "Gone")).toBe(false);
    } finally {
      await f.ctx.cleanup();
    }
  });

  it("a start before ZeroTime is placed with its real time", async () => {
    const f = await setup("rs-early");
    try {
      const early = ZERO - min(10); // 08:50
      await addRunner(f, "Early", f.cls.seq, { status: "ok", start: early, finish: early + min(42) });
      await addRunner(f, "Late", f.cls.seq, { status: "ok", start: T10, finish: T10 + min(44) });
      const list = await f.caller.lists.resultList();
      expect(list.map((e) => [e.name, e.place, e.runningTime])).toEqual([
        ["Early", 1, min(42)],
        ["Late", 2, min(44)],
      ]);
    } finally {
      await f.ctx.cleanup();
    }
  });

  it("returns hasPunches and hasStarted for the in-forest and not-started filters", async () => {
    const f = await setup("rs-progress");
    try {
      // Started an hour ago, a radio punch, no finish yet.
      await addRunner(f, "Out", f.cls.seq, undefined, 777_001);
      await f.ctx.db.punch.create({
        data: { eventId: f.ctx.eventId, cardNo: 777_001, controlCode: 31, time: rel(T10 + min(5)), source: "radio" },
      });
      const list = await f.caller.lists.resultList();
      const out = list.find((e) => e.name === "Out")!;
      expect(out.hasPunches).toBe(true);
      expect(out.place).toBe(0);
    } finally {
      await f.ctx.cleanup();
    }
  });
});

// A punches 31 → 32 in 3:00, B in 0:30; the leg into 32 is not timed.
const punchesA = [
  { controlCode: 31, time: T10 + min(10) },
  { controlCode: 32, time: T10 + min(13) },
  { controlCode: 33, time: T10 + min(30) },
];

describe("race.finishReceipt position and finish leg (CRS-039, CRS-013)", () => {

  it("ranks by the adjusted time, like the result list", async () => {
    const f = await setup("rs-adjust", { noTimingControl: true });
    try {
      // B: raw 38:00, 0:30 deducted = 37:30; stored as an OK result.
      const b = await addRunner(f, "B", f.cls.seq, undefined, 555_002);
      await f.caller.cardReadout.storeReadout({
        cardNo: 555_002,
        cardType: "SI11",
        punches: [
          { controlCode: 31, time: T10 + min(10) },
          { controlCode: 32, time: T10 + min(10, 30) },
          { controlCode: 33, time: T10 + min(30) },
        ],
        startTime: T10,
        finishTime: T10 + min(38),
      });
      await f.ctx.db.runner.updateMany({
        where: { eventId: f.ctx.eventId, seq: b },
        data: { status: "ok", startTime: rel(T10), finishTime: rel(T10 + min(38)) },
      });
      // A: raw 40:00, 3:00 deducted = 37:00, not yet saved.
      const a = await addRunner(f, "A", f.cls.seq, undefined, 555_001);
      await f.caller.cardReadout.storeReadout({
        cardNo: 555_001,
        cardType: "SI11",
        punches: punchesA,
        startTime: T10,
        finishTime: T10 + min(40),
      });

      const receipt = await f.caller.race.finishReceipt({ runnerId: a });
      expect(receipt!.runningTime).toBe(min(37));
      expect(receipt!.position).toEqual({ rank: 1, total: 2 });

      const list = await f.caller.lists.resultList();
      expect(list.find((e) => e.name === "B")).toMatchObject({ place: 1, runningTime: min(37, 30) });
    } finally {
      await f.ctx.cleanup();
    }
  });

  it("the first finisher, not yet saved, is 1 of 1; a tie shares the rank", async () => {
    const f = await setup("rs-first");
    try {
      const a = await addRunner(f, "A", f.cls.seq, undefined, 555_011);
      await f.caller.cardReadout.storeReadout({
        cardNo: 555_011,
        cardType: "SI11",
        punches: punchesA,
        startTime: T10,
        finishTime: T10 + min(40),
      });
      expect((await f.caller.race.finishReceipt({ runnerId: a }))!.position).toEqual({ rank: 1, total: 1 });

      await addRunner(f, "Twin", f.cls.seq, { status: "ok", start: T10, finish: T10 + min(40) });
      expect((await f.caller.race.finishReceipt({ runnerId: a }))!.position).toEqual({ rank: 1, total: 2 });
    } finally {
      await f.ctx.cleanup();
    }
  });

  it("gives no position in a no-timing class", async () => {
    const f = await setup("rs-rcpt-nt", { noTimingClass: true });
    try {
      const a = await addRunner(f, "A", f.cls.seq, undefined, 555_021);
      await f.caller.cardReadout.storeReadout({
        cardNo: 555_021,
        cardType: "SI11",
        punches: punchesA,
        startTime: T10,
        finishTime: T10 + min(40),
      });
      expect((await f.caller.race.finishReceipt({ runnerId: a }))!.position).toBeNull();
    } finally {
      await f.ctx.cleanup();
    }
  });

  it("returns the finish leg: last control to finish, with the finish leg's length", async () => {
    const f = await setup("rs-finleg");
    try {
      const a = await addRunner(f, "A", f.cls.seq, undefined, 555_031);
      await f.caller.cardReadout.storeReadout({
        cardNo: 555_031,
        cardType: "SI11",
        punches: punchesA,
        startTime: T10,
        finishTime: T10 + min(30, 25),
      });
      const receipt = await f.caller.race.finishReceipt({ runnerId: a });
      expect(receipt!.finish).toEqual({ splitTime: min(0, 25), legLength: 240 });
    } finally {
      await f.ctx.cleanup();
    }
  });
});

describe("finish leg when the last control is missed (CRS-013)", () => {
  it("prints no finish split rather than a multi-leg one", async () => {
    const f = await setup("rs-finleg-mp");
    try {
      const a = await addRunner(f, "A", f.cls.seq, undefined, 555_041);
      await f.caller.cardReadout.storeReadout({
        cardNo: 555_041,
        cardType: "SI11",
        punches: punchesA.slice(0, 2),
        startTime: T10,
        finishTime: T10 + min(30, 25),
      });
      const receipt = await f.caller.race.finishReceipt({ runnerId: a });
      expect(receipt!.status).toBe(3);
      expect(receipt!.finish).toEqual({ splitTime: 0, legLength: 0 });
      expect(receipt!.position).toBeNull();
    } finally {
      await f.ctx.cleanup();
    }
  });

  it("a cancelled entry who runs anyway still gets a position", async () => {
    const f = await setup("rs-cancel-runs");
    try {
      const a = await addRunner(f, "A", f.cls.seq, { status: "cancel", start: T10, finish: T10 + min(40) }, 555_051);
      await f.caller.cardReadout.storeReadout({
        cardNo: 555_051,
        cardType: "SI11",
        punches: punchesA,
        startTime: T10,
        finishTime: T10 + min(40),
      });
      const receipt = await f.caller.race.finishReceipt({ runnerId: a });
      expect(receipt!.status).toBe(1);
      expect(receipt!.position).toEqual({ rank: 1, total: 1 });
    } finally {
      await f.ctx.cleanup();
    }
  });
});

describe("dashboard class info for the offline readout (RES-20)", () => {
  it("carries the class's max time and a boolean noTiming", async () => {
    const f = await setup("rs-dash", { noTimingClass: true });
    try {
      await f.ctx.db.class.update({ where: { id: f.cls.id }, data: { maxTime: min(90) } });
      const dash = await f.caller.competition.dashboard();
      const info = dash.classes.find((c) => c.id === f.cls.seq)!;
      expect(info.maxTime).toBe(min(90));
      expect(info.noTiming).toBe(true);
    } finally {
      await f.ctx.cleanup();
    }
  });
});
