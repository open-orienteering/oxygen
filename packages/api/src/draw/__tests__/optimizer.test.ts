/**
 * Unit tests for the corridor optimizer.
 *
 * The optimizer decides which corridor each class starts in and at what
 * time. Three behaviours are load-bearing for a real start:
 *
 * 1. A class occupies its corridor until the end of its last runner's
 *    *slot* (last start + interval), so the next class in the same
 *    corridor starts exactly when the previous one's window closes.
 * 2. Corridors can be phase-shifted against each other (stagger) so that
 *    N parallel corridors on a 2-minute interval produce N/2 starters per
 *    minute instead of N starters every second minute.
 * 3. Classes that share their first control must never start
 *    simultaneously — they are forced into the same corridor.
 */

import { describe, it, expect } from "vitest";
import {
  optimizeStartTimes,
  type ClassCourseInfo,
  type OptimizerSettings,
} from "../optimizer.js";

const FIRST_START = 324_000; // 09:00:00 in absolute deciseconds
const MIN = 600; // one minute in deciseconds

function cls(over: Partial<ClassCourseInfo> & { classId: number }): ClassCourseInfo {
  return {
    runnerCount: 5,
    courseId: over.classId,
    initialControls: [],
    interval: 2 * MIN,
    ...over,
  };
}

function settings(over: Partial<OptimizerSettings> = {}): OptimizerSettings {
  return {
    firstStart: FIRST_START,
    baseInterval: MIN,
    maxParallelStarts: 10,
    detectCourseOverlap: false,
    ...over,
  };
}

function startOf(
  results: ReturnType<typeof optimizeStartTimes>,
  classId: number,
): number {
  return results.find((r) => r.classId === classId)!.computedFirstStart;
}

function corridorOf(
  results: ReturnType<typeof optimizeStartTimes>,
  classId: number,
): number {
  return results.find((r) => r.classId === classId)!.corridor;
}

describe("optimizeStartTimes — slot-based stacking", () => {
  it("starts the next class in a corridor when the previous slot ends", () => {
    const classes = [
      cls({ classId: 1, courseId: 7, runnerCount: 3, orderHint: 0 }),
      cls({ classId: 2, courseId: 7, runnerCount: 3, orderHint: 1 }),
    ];
    const res = optimizeStartTimes(classes, settings());

    // Same course => same corridor, sequential.
    expect(corridorOf(res, 1)).toBe(corridorOf(res, 2));
    expect(startOf(res, 1)).toBe(FIRST_START);
    // 3 runners * 2 min => last start at +4 min, slot ends at +6 min.
    expect(startOf(res, 2)).toBe(FIRST_START + 6 * MIN);
  });

  it("falls back to baseInterval when the class interval is shorter", () => {
    const classes = [
      cls({ classId: 1, courseId: 7, runnerCount: 3, interval: 300, orderHint: 0 }),
      cls({ classId: 2, courseId: 7, runnerCount: 3, interval: 300, orderHint: 1 }),
    ];
    const res = optimizeStartTimes(classes, settings());

    // Last start at +60s; the 30s slot is widened to the 60s baseInterval.
    expect(startOf(res, 2)).toBe(FIRST_START + 600 + MIN);
  });

  it("gives a single-runner class one full slot", () => {
    const classes = [
      cls({ classId: 1, courseId: 7, runnerCount: 1, orderHint: 0 }),
      cls({ classId: 2, courseId: 7, runnerCount: 4, orderHint: 1 }),
    ];
    const res = optimizeStartTimes(classes, settings());
    expect(startOf(res, 2)).toBe(FIRST_START + 2 * MIN);
  });
});

describe("optimizeStartTimes — corridor stagger", () => {
  it("phase-shifts adjacent corridors by the stagger offset", () => {
    const classes = [
      cls({ classId: 1, courseId: 1, runnerCount: 6 }),
      cls({ classId: 2, courseId: 2, runnerCount: 5 }),
    ];
    const res = optimizeStartTimes(
      classes,
      settings({ maxParallelStarts: 2, staggerOffset: MIN }),
    );

    const byCorridor = new Map(res.map((r) => [r.corridor, r.computedFirstStart]));
    expect(byCorridor.get(0)).toBe(FIRST_START);
    expect(byCorridor.get(1)).toBe(FIRST_START + MIN);
  });

  it("wraps the phase within the interval so 4 corridors alternate minutes", () => {
    const classes = [1, 2, 3, 4].map((id) =>
      cls({ classId: id, courseId: id, runnerCount: 7 - id }),
    );
    const res = optimizeStartTimes(
      classes,
      settings({ maxParallelStarts: 4, staggerOffset: MIN }),
    );

    const byCorridor = new Map(res.map((r) => [r.corridor, r.computedFirstStart]));
    expect(byCorridor.get(0)).toBe(FIRST_START);
    expect(byCorridor.get(1)).toBe(FIRST_START + MIN);
    expect(byCorridor.get(2)).toBe(FIRST_START);
    expect(byCorridor.get(3)).toBe(FIRST_START + MIN);
  });

  it("applies no phase shift when stagger is zero or absent", () => {
    const classes = [
      cls({ classId: 1, courseId: 1, runnerCount: 6 }),
      cls({ classId: 2, courseId: 2, runnerCount: 5 }),
    ];
    for (const staggerOffset of [undefined, 0]) {
      const res = optimizeStartTimes(
        classes,
        settings({ maxParallelStarts: 2, staggerOffset }),
      );
      expect(res.every((r) => r.computedFirstStart === FIRST_START)).toBe(true);
    }
  });

  it("keeps the phase for later classes in the same corridor", () => {
    const classes = [
      cls({ classId: 1, courseId: 1, runnerCount: 4 }),
      cls({ classId: 2, courseId: 9, runnerCount: 3, orderHint: 0, corridorHint: 1 }),
      cls({ classId: 3, courseId: 9, runnerCount: 3, orderHint: 1, corridorHint: 1 }),
    ];
    const res = optimizeStartTimes(
      classes,
      settings({ maxParallelStarts: 2, staggerOffset: MIN }),
    );

    expect(startOf(res, 2)).toBe(FIRST_START + MIN);
    expect(startOf(res, 3)).toBe(FIRST_START + MIN + 6 * MIN);
  });
});

describe("optimizeStartTimes — per-class offset", () => {
  it("shifts a corridor-leading class and replaces the corridor phase", () => {
    const classes = [cls({ classId: 1, runnerCount: 4, startOffset: 300 })];
    const res = optimizeStartTimes(classes, settings({ staggerOffset: MIN }));
    expect(startOf(res, 1)).toBe(FIRST_START + 300);
  });

  it("shifts a stacked class relative to its computed position", () => {
    const classes = [
      cls({ classId: 1, courseId: 7, runnerCount: 3, orderHint: 0 }),
      cls({ classId: 2, courseId: 7, runnerCount: 3, orderHint: 1, startOffset: MIN }),
    ];
    const res = optimizeStartTimes(classes, settings());
    expect(startOf(res, 2)).toBe(FIRST_START + 6 * MIN + MIN);
  });

  it("accepts a negative offset", () => {
    const classes = [
      cls({ classId: 1, courseId: 7, runnerCount: 3, orderHint: 0 }),
      cls({ classId: 2, courseId: 7, runnerCount: 3, orderHint: 1, startOffset: -300 }),
    ];
    const res = optimizeStartTimes(classes, settings());
    expect(startOf(res, 2)).toBe(FIRST_START + 6 * MIN - 300);
  });
});

describe("optimizeStartTimes — first-control spacing", () => {
  /** All start times a class produces, given its computed first start. */
  function startTimes(
    res: ReturnType<typeof optimizeStartTimes>,
    c: ClassCourseInfo,
  ): number[] {
    const first = startOf(res, c.classId);
    if (c.interval <= 0) return [first];
    return Array.from({ length: c.runnerCount }, (_, i) => first + i * c.interval);
  }

  /** Smallest distance between any two starts heading for the same control. */
  function closestPair(times: number[][]): number {
    const all = times.flat().sort((a, b) => a - b);
    let min = Infinity;
    for (let i = 1; i < all.length; i++) {
      min = Math.min(min, all[i] - all[i - 1]);
    }
    return min;
  }

  it("interleaves two classes sharing a first control", () => {
    const classes = [
      cls({ classId: 1, courseId: 1, runnerCount: 5, initialControls: [31, 42] }),
      cls({ classId: 2, courseId: 2, runnerCount: 5, initialControls: [31, 60] }),
    ];
    const res = optimizeStartTimes(
      classes,
      settings({ detectCourseOverlap: true, maxParallelStarts: 4 }),
    );

    // Both keep their 2-minute interval and run in parallel corridors; the
    // second is nudged onto the odd minutes.
    expect(corridorOf(res, 1)).not.toBe(corridorOf(res, 2));
    expect(startOf(res, 1)).toBe(FIRST_START);
    expect(startOf(res, 2)).toBe(FIRST_START + MIN);
    expect(closestPair(classes.map((c) => startTimes(res, c)))).toBe(MIN);
  });

  it("honours a custom minimum gap", () => {
    const classes = [
      cls({ classId: 1, courseId: 1, runnerCount: 4, initialControls: [31] }),
      cls({ classId: 2, courseId: 2, runnerCount: 4, initialControls: [31] }),
    ];
    const res = optimizeStartTimes(
      classes,
      settings({
        detectCourseOverlap: true,
        maxParallelStarts: 4,
        minFirstControlGap: 300,
      }),
    );
    expect(startOf(res, 2)).toBe(FIRST_START + 300);
  });

  it("pushes a third class past a saturated first control", () => {
    const classes = [
      cls({ classId: 1, courseId: 1, runnerCount: 3, initialControls: [31] }),
      cls({ classId: 2, courseId: 2, runnerCount: 3, initialControls: [31] }),
      cls({ classId: 3, courseId: 3, runnerCount: 3, initialControls: [31] }),
    ];
    const res = optimizeStartTimes(
      classes,
      settings({ detectCourseOverlap: true, maxParallelStarts: 4 }),
    );

    // Classes 1 and 2 fill every minute from 09:00 to 09:05; the third has to
    // wait for the gate to clear.
    expect(closestPair(classes.map((c) => startTimes(res, c)))).toBeGreaterThanOrEqual(MIN);
    expect(startOf(res, 3)).toBeGreaterThanOrEqual(FIRST_START + 5 * MIN);
  });

  it("leaves classes with different first controls untouched", () => {
    const classes = [
      cls({ classId: 1, courseId: 1, initialControls: [31, 42, 55] }),
      cls({ classId: 2, courseId: 2, initialControls: [41, 42, 55] }),
    ];
    const res = optimizeStartTimes(
      classes,
      settings({ detectCourseOverlap: true, maxParallelStarts: 4 }),
    );

    expect(corridorOf(res, 1)).not.toBe(corridorOf(res, 2));
    expect(startOf(res, 1)).toBe(FIRST_START);
    expect(startOf(res, 2)).toBe(FIRST_START);
  });

  it("respects the gap against a pinned class", () => {
    const classes = [
      cls({
        classId: 1,
        courseId: 1,
        runnerCount: 3,
        initialControls: [31],
        fixedFirstStart: FIRST_START,
      }),
      cls({ classId: 2, courseId: 2, runnerCount: 3, initialControls: [31] }),
    ];
    const res = optimizeStartTimes(
      classes,
      settings({ detectCourseOverlap: true, maxParallelStarts: 4 }),
    );
    expect(startOf(res, 1)).toBe(FIRST_START);
    expect(startOf(res, 2)).toBe(FIRST_START + MIN);
  });

  it("ignores the first control when detection is off", () => {
    const classes = [
      cls({ classId: 1, courseId: 1, initialControls: [31, 42, 55] }),
      cls({ classId: 2, courseId: 2, initialControls: [31, 42, 55] }),
    ];
    const res = optimizeStartTimes(
      classes,
      settings({ detectCourseOverlap: false, maxParallelStarts: 4 }),
    );
    expect(startOf(res, 1)).toBe(FIRST_START);
    expect(startOf(res, 2)).toBe(FIRST_START);
  });

  it("spaces a mass start against another class on the same control", () => {
    const classes = [
      cls({ classId: 1, courseId: 1, runnerCount: 20, interval: 0, initialControls: [31] }),
      cls({ classId: 2, courseId: 2, runnerCount: 3, initialControls: [31] }),
    ];
    const res = optimizeStartTimes(
      classes,
      settings({ detectCourseOverlap: true, maxParallelStarts: 4 }),
    );
    // The mass start counts as a single instant at the control, so the two
    // classes only need one gap between them.
    const starts = [startOf(res, 1), startOf(res, 2)].sort((a, b) => a - b);
    expect(starts).toEqual([FIRST_START, FIRST_START + MIN]);
  });

  it("still stacks classes sharing a course in one corridor", () => {
    const classes = [
      cls({ classId: 1, courseId: 7, runnerCount: 3, initialControls: [31], orderHint: 0 }),
      cls({ classId: 2, courseId: 7, runnerCount: 3, initialControls: [31], orderHint: 1 }),
    ];
    const res = optimizeStartTimes(
      classes,
      settings({ detectCourseOverlap: true, maxParallelStarts: 4 }),
    );
    expect(corridorOf(res, 1)).toBe(corridorOf(res, 2));
    expect(startOf(res, 2)).toBe(FIRST_START + 6 * MIN);
  });
});

describe("optimizeStartTimes — pinning", () => {
  it("honours a fixed first start and ignores the corridor stagger", () => {
    const classes = [
      cls({ classId: 1, courseId: 1, fixedFirstStart: 360_000 }),
      cls({ classId: 2, courseId: 2 }),
    ];
    const res = optimizeStartTimes(
      classes,
      settings({ maxParallelStarts: 2, staggerOffset: MIN }),
    );
    expect(startOf(res, 1)).toBe(360_000);
    expect(corridorOf(res, 1)).toBe(-1);
  });

  it("honours a corridor hint", () => {
    const classes = [
      cls({ classId: 1, courseId: 1, corridorHint: 3 }),
      cls({ classId: 2, courseId: 2 }),
    ];
    const res = optimizeStartTimes(classes, settings({ maxParallelStarts: 4 }));
    expect(corridorOf(res, 1)).toBe(3);
  });

  it("returns an empty result for no classes", () => {
    expect(optimizeStartTimes([], settings())).toEqual([]);
  });
});
