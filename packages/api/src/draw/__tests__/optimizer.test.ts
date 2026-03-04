import { describe, it, expect } from "vitest";
import {
  optimizeStartTimes,
  type ClassCourseInfo,
  type OptimizerSettings,
} from "../optimizer.js";

// ─── Fixtures ─────────────────────────────────────────────────

const DEFAULT_SETTINGS: OptimizerSettings = {
  firstStart: 32400 * 10, // 09:00:00 in deciseconds
  baseInterval: 20,       // 20 ds = 2 seconds gap between classes
  maxParallelStarts: 1,
  detectCourseOverlap: true,
};

function makeClass(
  classId: number,
  courseId: number,
  runnerCount = 5,
  interval = 20,
  overrides: Partial<ClassCourseInfo> = {},
): ClassCourseInfo {
  return {
    classId,
    runnerCount,
    courseId,
    initialControls: [],
    interval,
    ...overrides,
  };
}

// ─── optimizeStartTimes ───────────────────────────────────────

describe("optimizeStartTimes", () => {
  it("returns empty array for empty input", () => {
    expect(optimizeStartTimes([], DEFAULT_SETTINGS)).toEqual([]);
  });

  it("single class: computedFirstStart equals firstStart", () => {
    const cls = makeClass(1, 101);
    const result = optimizeStartTimes([cls], DEFAULT_SETTINGS);
    expect(result).toHaveLength(1);
    expect(result[0].computedFirstStart).toBe(DEFAULT_SETTINGS.firstStart);
  });

  it("single class: corridor is 0", () => {
    const cls = makeClass(1, 101);
    const result = optimizeStartTimes([cls], DEFAULT_SETTINGS);
    expect(result[0].corridor).toBe(0);
  });

  it("every input classId appears in output", () => {
    const classes = [
      makeClass(1, 101),
      makeClass(2, 102),
      makeClass(3, 103),
    ];
    const result = optimizeStartTimes(classes, DEFAULT_SETTINGS);
    const outputIds = result.map((r) => r.classId).sort();
    expect(outputIds).toEqual([1, 2, 3]);
  });

  it("two classes sharing same courseId end up in the same corridor", () => {
    const settings = { ...DEFAULT_SETTINGS, maxParallelStarts: 2 };
    const classes = [makeClass(1, 101), makeClass(2, 101)]; // same course
    const result = optimizeStartTimes(classes, settings);
    expect(result[0].corridor).toBe(result[1].corridor);
  });

  it("two non-conflicting classes with maxParallelStarts=2 get different corridors", () => {
    const settings = { ...DEFAULT_SETTINGS, maxParallelStarts: 2 };
    const classes = [makeClass(1, 101), makeClass(2, 102)]; // different courses
    const result = optimizeStartTimes(classes, settings);
    expect(result[0].corridor).not.toBe(result[1].corridor);
  });

  it("fixedFirstStart: class uses that time and gets corridor -1", () => {
    const fixedTime = 36000 * 10; // 10:00:00
    const cls = makeClass(1, 101, 5, 20, { fixedFirstStart: fixedTime });
    const result = optimizeStartTimes([cls], DEFAULT_SETTINGS);
    expect(result[0].computedFirstStart).toBe(fixedTime);
    expect(result[0].corridor).toBe(-1);
  });

  it("fixedFirstStart class does not interfere with corridor assignment of others", () => {
    const fixedTime = 36000 * 10;
    const classes = [
      makeClass(1, 101, 5, 20, { fixedFirstStart: fixedTime }),
      makeClass(2, 102),
    ];
    const result = optimizeStartTimes(classes, DEFAULT_SETTINGS);
    const fixed = result.find((r) => r.classId === 1)!;
    const normal = result.find((r) => r.classId === 2)!;
    expect(fixed.corridor).toBe(-1);
    expect(normal.corridor).toBeGreaterThanOrEqual(0);
  });

  it("corridorHint: class is assigned the hinted corridor", () => {
    const settings = { ...DEFAULT_SETTINGS, maxParallelStarts: 3 };
    const classes = [
      makeClass(1, 101, 5, 20, { corridorHint: 2 }),
      makeClass(2, 102),
      makeClass(3, 103),
    ];
    const result = optimizeStartTimes(classes, settings);
    const hinted = result.find((r) => r.classId === 1)!;
    expect(hinted.corridor).toBe(2);
  });

  it("detectCourseOverlap=true: classes with 3+ shared initial controls → same corridor", () => {
    const settings = {
      ...DEFAULT_SETTINGS,
      detectCourseOverlap: true,
      maxParallelStarts: 2,
    };
    const sharedControls = [31, 32, 33, 34];
    const classes = [
      makeClass(1, 101, 5, 20, { initialControls: sharedControls }),
      makeClass(2, 102, 5, 20, { initialControls: sharedControls }), // different courseId but same controls
    ];
    const result = optimizeStartTimes(classes, settings);
    expect(result[0].corridor).toBe(result[1].corridor);
  });

  it("detectCourseOverlap=false: classes with same initial controls can go to different corridors", () => {
    const settings = {
      ...DEFAULT_SETTINGS,
      detectCourseOverlap: false,
      maxParallelStarts: 2,
    };
    const sharedControls = [31, 32, 33, 34];
    const classes = [
      makeClass(1, 101, 5, 20, { initialControls: sharedControls }),
      makeClass(2, 102, 5, 20, { initialControls: sharedControls }),
    ];
    const result = optimizeStartTimes(classes, settings);
    // With overlap detection off and 2 corridors, they should be in different corridors
    expect(result[0].corridor).not.toBe(result[1].corridor);
  });

  it("classes within same corridor start sequentially (no overlap)", () => {
    const settings = { ...DEFAULT_SETTINGS, maxParallelStarts: 1 };
    const classes = [
      makeClass(1, 101, 5, 20),
      makeClass(2, 101, 5, 20), // same course → same corridor
    ];
    const result = optimizeStartTimes(classes, settings);
    result.sort((a, b) => a.computedFirstStart - b.computedFirstStart);
    // Duration of class 1 = 5 runners × 20 ds interval = 100 ds
    // Class 2 should start after class 1 finishes + baseInterval
    expect(result[1].computedFirstStart).toBeGreaterThan(result[0].computedFirstStart);
  });

  it("orderHint: within same corridor, lower hint starts first", () => {
    const settings = { ...DEFAULT_SETTINGS, maxParallelStarts: 1 };
    const classes = [
      makeClass(1, 101, 3, 20, { orderHint: 2 }),
      makeClass(2, 101, 3, 20, { orderHint: 1 }),
    ];
    const result = optimizeStartTimes(classes, settings);
    const cls1 = result.find((r) => r.classId === 1)!;
    const cls2 = result.find((r) => r.classId === 2)!;
    // cls2 has orderHint=1 (lower), so should start first
    expect(cls2.computedFirstStart).toBeLessThan(cls1.computedFirstStart);
  });

  it("computedFirstStart is never earlier than firstStart for normal classes", () => {
    const classes = [
      makeClass(1, 101),
      makeClass(2, 102),
      makeClass(3, 103),
    ];
    const result = optimizeStartTimes(classes, DEFAULT_SETTINGS);
    for (const r of result) {
      if (r.corridor !== -1) {
        expect(r.computedFirstStart).toBeGreaterThanOrEqual(
          DEFAULT_SETTINGS.firstStart,
        );
      }
    }
  });
});
