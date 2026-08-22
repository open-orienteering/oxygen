/**
 * Integration tests for the draw tRPC router.
 *
 * Covers the defaults endpoint that powers the DrawPanel UI, plus the
 * preview → execute round-trip that assigns start times + start numbers
 * to runners. The underlying algorithm correctness is covered by the
 * unit suite (`packages/api/src/draw/__tests__`); these tests focus on
 * the router glue: counts, withdrawn-status filtering, persistence, and
 * the warnings channel.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  createTestEvent,
  disconnect,
  type TestEventContext,
} from "../helpers/test-db.js";
import { makeCaller } from "../helpers/caller.js";

const MIN = 600; // one minute in deciseconds
const TEN_OCLOCK = 360_000;

let ctx: TestEventContext;
let caller: ReturnType<typeof makeCaller>;
let classSeq: number;
let courseSeq: number;

beforeAll(async () => {
  ctx = await createTestEvent("draw");
  caller = makeCaller(ctx.event);
  const course = await caller.course.create({ name: "Sprint", length: 3000 });
  courseSeq = course.id;
  const cls = await caller.class.create({
    name: "H21",
    courseId: courseSeq,
  });
  classSeq = cls.id;

  // 5 runners, 4 active + 1 withdrawn (Cancel = 21).
  await caller.runner.create({
    name: "Alice",
    classId: classSeq,
    cardNo: 10001,
    clubName: "OK A",
  });
  await caller.runner.create({
    name: "Bob",
    classId: classSeq,
    cardNo: 10002,
    clubName: "OK B",
  });
  await caller.runner.create({
    name: "Carol",
    classId: classSeq,
    cardNo: 10003,
    clubName: "OK A",
  });
  await caller.runner.create({
    name: "Dave",
    classId: classSeq,
    cardNo: 10004,
    clubName: "OK C",
  });
  const withdrawn = await caller.runner.create({
    name: "Withdrawn Eve",
    classId: classSeq,
    cardNo: 10005,
    clubName: "OK D",
  });
  await caller.runner.update({ id: withdrawn.id, status: 21 });
});

afterAll(async () => {
  await ctx.cleanup();
  await disconnect();
});

describe("draw.defaults", () => {
  it("counts only non-withdrawn runners per class", async () => {
    const d = await caller.draw.defaults();
    const cls = d.classes.find((c) => c.id === classSeq)!;
    expect(cls.runnerCount).toBe(4);
    expect(cls.courseName).toBe("Sprint");
  });
});

describe("draw.preview", () => {
  it("returns one entry per active runner with monotonic start times", async () => {
    const res = await caller.draw.preview({
      classes: [
        {
          classId: classSeq,
          method: "random",
          interval: 600, // 1 minute in deciseconds
        },
      ],
      settings: {
        firstStart: 360_000, // 10:00:00 absolute
        baseInterval: 600,
        maxParallelStarts: 1,
        detectCourseOverlap: false,
      },
    });
    const cls = res.classes.find((c) => c.classId === classSeq)!;
    expect(cls.entries.length).toBe(4);

    const times = cls.entries.map((e) => e.startTime);
    expect(times[0]).toBe(360_000);
    for (let i = 1; i < times.length; i++) {
      expect(times[i]).toBe(times[i - 1] + 600);
    }
  });

  it("does not mutate runner rows", async () => {
    const before = await ctx.db.runner.findMany({
      where: { eventId: ctx.eventId, classId: { not: null }, removed: false },
      select: { name: true, startTime: true },
    });
    await caller.draw.preview({
      classes: [{ classId: classSeq, method: "random", interval: 600 }],
      settings: {
        firstStart: 360_000,
        baseInterval: 600,
        maxParallelStarts: 1,
        detectCourseOverlap: false,
      },
    });
    const after = await ctx.db.runner.findMany({
      where: { eventId: ctx.eventId, classId: { not: null }, removed: false },
      select: { name: true, startTime: true },
    });
    expect(after.map((r) => r.startTime).sort()).toEqual(
      before.map((r) => r.startTime).sort(),
    );
  });
});

describe("draw.execute", () => {
  it("writes startTime + startNo to each active runner", async () => {
    const res = await caller.draw.execute({
      classes: [{ classId: classSeq, method: "random", interval: 600 }],
      settings: {
        firstStart: 360_000,
        baseInterval: 600,
        maxParallelStarts: 1,
        detectCourseOverlap: false,
      },
    });
    expect(res.success).toBe(true);
    expect(res.totalDrawn).toBe(4);

    // Verify runners have start times stored (ZeroTime-relative).
    const runners = await ctx.db.runner.findMany({
      where: {
        eventId: ctx.eventId,
        classId: { not: null },
        removed: false,
        // Skip the withdrawn one.
        status: { not: "cancel" },
      },
      select: { startTime: true, startNo: true },
      orderBy: { startTime: "asc" },
    });
    expect(runners.length).toBe(4);
    for (const r of runners) {
      expect(r.startTime).toBeGreaterThan(0);
      expect(r.startNo).toBeGreaterThan(0);
    }

    // Class row should now have firstStart + startInterval populated.
    const cls = await ctx.db.class.findFirst({
      where: { eventId: ctx.eventId, seq: classSeq },
      select: { firstStart: true, startInterval: true },
    });
    expect(cls?.startInterval).toBe(600);
  });
});

/**
 * Start lanes: eight classes, each on its own course leaving the start
 * towards a different first control — the layout you get when every lane
 * has its own start flag. These suites cover the corridor stagger and the
 * per-class offset end-to-end through the router.
 */
describe("draw — start lanes, stagger and offsets", () => {
  let laneCtx: TestEventContext;
  let laneCaller: ReturnType<typeof makeCaller>;
  /** Class seqs for the four lanes with distinct first controls. */
  const laneClasses: number[] = [];
  /** Two classes whose courses share their first control. */
  let sharedA: number;
  let sharedB: number;

  beforeAll(async () => {
    laneCtx = await createTestEvent("draw_lanes");
    laneCaller = makeCaller(laneCtx.event);

    async function makeClassWithCourse(
      name: string,
      controlCodes: number[],
    ): Promise<number> {
      for (const code of controlCodes) {
        const existing = await laneCtx.db.control.findFirst({
          where: { eventId: laneCtx.eventId, codes: String(code) },
          select: { id: true },
        });
        if (!existing) {
          await laneCaller.control.create({ codes: String(code) });
        }
      }
      const course = await laneCaller.course.create({
        name: `Course ${name}`,
        controlIds: controlCodes,
      });
      const cls = await laneCaller.class.create({ name, courseId: course.id });
      // Three runners each: enough for a 2-minute block spanning 3 slots.
      for (let i = 0; i < 3; i++) {
        await laneCaller.runner.create({
          name: `${name} Runner ${i}`,
          classId: cls.id,
          clubName: `OK ${i}`,
        });
      }
      return cls.id;
    }

    // Four lanes: distinct first controls, shared later controls.
    for (const [i, first] of [31, 32, 33, 34].entries()) {
      laneClasses.push(await makeClassWithCourse(`Lane${i + 1}`, [first, 90, 91]));
    }
    // Two classes leaving towards the same first control.
    sharedA = await makeClassWithCourse("SharedA", [41, 92]);
    sharedB = await makeClassWithCourse("SharedB", [41, 93]);
  });

  afterAll(async () => {
    await laneCtx.cleanup();
  });

  function laneConfig(classId: number, over: Record<string, unknown> = {}) {
    return { classId, method: "random" as const, interval: 2 * MIN, ...over };
  }

  it("starts lanes with distinct first controls in parallel", async () => {
    const res = await laneCaller.draw.preview({
      classes: laneClasses.map((id) => laneConfig(id)),
      settings: {
        firstStart: TEN_OCLOCK,
        baseInterval: MIN,
        maxParallelStarts: 4,
        detectCourseOverlap: true,
      },
    });

    expect(res.classes.every((c) => c.computedFirstStart === TEN_OCLOCK)).toBe(true);
    expect(new Set(res.classes.map((c) => c.corridor)).size).toBe(4);
  });

  it("spreads staggered lanes across the minutes of the interval", async () => {
    const res = await laneCaller.draw.preview({
      classes: laneClasses.map((id) => laneConfig(id)),
      settings: {
        firstStart: TEN_OCLOCK,
        baseInterval: MIN,
        maxParallelStarts: 4,
        detectCourseOverlap: true,
        staggerOffset: MIN,
      },
    });

    // 4 lanes, 2-minute interval, 1-minute stagger => two lanes per minute.
    const starts = res.classes.map((c) => c.computedFirstStart).sort();
    expect(starts).toEqual([
      TEN_OCLOCK,
      TEN_OCLOCK,
      TEN_OCLOCK + MIN,
      TEN_OCLOCK + MIN,
    ]);

    // Every runner start falls on one of the two phases.
    for (const cls of res.classes) {
      for (const entry of cls.entries) {
        expect((entry.startTime - TEN_OCLOCK) % MIN).toBe(0);
      }
    }
  });

  it("interleaves two classes sharing a first control", async () => {
    const res = await laneCaller.draw.preview({
      classes: [laneConfig(sharedA), laneConfig(sharedB)],
      settings: {
        firstStart: TEN_OCLOCK,
        baseInterval: MIN,
        maxParallelStarts: 4,
        detectCourseOverlap: true,
      },
    });

    // Both keep their 2-minute interval and run in parallel; the second one
    // lands on the odd minutes.
    const [a, b] = res.classes;
    expect(a.corridor).not.toBe(b.corridor);
    expect(Math.abs(a.computedFirstStart - b.computedFirstStart)).toBe(MIN);

    const starts = res.classes
      .flatMap((c) => c.entries.map((e) => e.startTime))
      .sort((x, y) => x - y);
    for (let i = 1; i < starts.length; i++) {
      expect(starts[i] - starts[i - 1]).toBeGreaterThanOrEqual(MIN);
    }
  });

  it("honours a custom first-control gap", async () => {
    const res = await laneCaller.draw.preview({
      classes: [laneConfig(sharedA), laneConfig(sharedB)],
      settings: {
        firstStart: TEN_OCLOCK,
        baseInterval: MIN,
        maxParallelStarts: 4,
        detectCourseOverlap: true,
        minFirstControlGap: 300,
      },
    });
    const [a, b] = res.classes;
    expect(Math.abs(a.computedFirstStart - b.computedFirstStart)).toBe(300);
  });

  it("lets classes share a first control freely when spacing is off", async () => {
    const res = await laneCaller.draw.preview({
      classes: [laneConfig(sharedA), laneConfig(sharedB)],
      settings: {
        firstStart: TEN_OCLOCK,
        baseInterval: MIN,
        maxParallelStarts: 4,
        detectCourseOverlap: false,
      },
    });
    expect(res.classes.every((c) => c.computedFirstStart === TEN_OCLOCK)).toBe(true);
  });

  it("warns when a class starts faster than the first-control gap", async () => {
    const res = await laneCaller.draw.preview({
      classes: [laneConfig(sharedA, { interval: 300 })],
      settings: {
        firstStart: TEN_OCLOCK,
        baseInterval: MIN,
        maxParallelStarts: 4,
        detectCourseOverlap: true,
      },
    });
    expect(res.warnings.some((w) => w.includes("first control"))).toBe(true);
  });

  it("returns the interval so the timeline can size each block", async () => {
    const res = await laneCaller.draw.preview({
      classes: [laneConfig(laneClasses[0], { interval: 3 * MIN })],
      settings: {
        firstStart: TEN_OCLOCK,
        baseInterval: MIN,
        maxParallelStarts: 4,
        detectCourseOverlap: true,
      },
    });
    expect(res.classes[0].interval).toBe(3 * MIN);
  });

  it("applies a per-class offset on top of the computed start", async () => {
    const res = await laneCaller.draw.preview({
      classes: [
        laneConfig(laneClasses[0]),
        laneConfig(laneClasses[1], { startOffset: 300 }),
      ],
      settings: {
        firstStart: TEN_OCLOCK,
        baseInterval: MIN,
        maxParallelStarts: 4,
        detectCourseOverlap: true,
      },
    });

    const shifted = res.classes.find((c) => c.classId === laneClasses[1])!;
    expect(shifted.computedFirstStart).toBe(TEN_OCLOCK + 300);
    expect(shifted.entries[0].startTime).toBe(TEN_OCLOCK + 300);
  });

  it("persists offset start times on execute", async () => {
    const offset = 300;
    await laneCaller.draw.execute({
      classes: [laneConfig(laneClasses[2], { startOffset: offset })],
      settings: {
        firstStart: TEN_OCLOCK,
        baseInterval: MIN,
        maxParallelStarts: 4,
        detectCourseOverlap: true,
      },
    });

    const cls = await laneCtx.db.class.findFirst({
      where: { eventId: laneCtx.eventId, seq: laneClasses[2] },
      select: { id: true, firstStart: true },
    });
    const zeroTime = laneCtx.event.zeroTime;
    expect(cls?.firstStart).toBe(TEN_OCLOCK + offset - zeroTime);

    const runners = await laneCtx.db.runner.findMany({
      where: { eventId: laneCtx.eventId, classId: cls!.id, removed: false },
      select: { startTime: true },
      orderBy: { startTime: "asc" },
    });
    expect(runners.map((r) => r.startTime)).toEqual([
      TEN_OCLOCK + offset - zeroTime,
      TEN_OCLOCK + offset + 2 * MIN - zeroTime,
      TEN_OCLOCK + offset + 4 * MIN - zeroTime,
    ]);
  });
});
