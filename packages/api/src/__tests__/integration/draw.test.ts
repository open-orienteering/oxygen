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
