import { describe, it, expect } from "vitest";
import { computeOrigin } from "../meosOrigin.js";

/**
 * Reference values produced by compiling the exact MeOS algorithm
 * (`code/oPunch.cpp:321-330` from the upstream MeOS repository) and
 * running it as a native binary. These pin Oxygen's port to the
 * upstream behaviour so any future drift is caught immediately.
 *
 * Generation harness:
 *
 *   #include <cstdint>
 *   constexpr uint64_t origin_key = 1300602071;
 *   int computeOrigin(int time, int code) {
 *     if (time <= 0 || code <= 0) return 0;
 *     time = time % (36000 * 24 * 7);
 *     code = code % 29;
 *     uint64_t xcode = (uint64_t)(time * 29 + code) * 7;
 *     return (xcode * 53458ul) % origin_key;
 *   }
 */
const REFERENCE: ReadonlyArray<[time: number, code: number, expected: number]> = [
  [36000, 31, 491191112],
  [86400, 100, 1181927158],
  [324001, 1, 523404267],     // ZeroTime + 1ds, PunchStart
  [324001, 2, 523778473],     // ZeroTime + 1ds, PunchFinish
  [324001, 3, 524152679],     // ZeroTime + 1ds, PunchCheck
  [360000, 31, 1003369199],
  [864000, 999999, 73064487],
  [1, 1, 11226180],
  [1, 100, 15716652],
  [500000, 200, 1185491215],
  // Week-boundary wrap: time % WEEK_DS == 0 → result 0
  [36000 * 24 * 7, 31, 748412],
];

describe("computeOrigin", () => {
  it.each(REFERENCE)(
    "matches MeOS reference: computeOrigin(%i, %i) === %i",
    (time, code, expected) => {
      expect(computeOrigin(time, code)).toBe(expected);
    },
  );

  it("returns 0 for non-positive inputs", () => {
    expect(computeOrigin(0, 100)).toBe(0);
    expect(computeOrigin(100, 0)).toBe(0);
    expect(computeOrigin(-1, 100)).toBe(0);
    expect(computeOrigin(100, -1)).toBe(0);
  });

  it("is deterministic for the same inputs", () => {
    const a = computeOrigin(324500, 31);
    const b = computeOrigin(324500, 31);
    expect(a).toBe(b);
  });

  it("changes when time changes by 1 ds", () => {
    expect(computeOrigin(324001, 31)).not.toBe(computeOrigin(324002, 31));
  });

  it("changes when code changes (within mod 29)", () => {
    expect(computeOrigin(324001, 31)).not.toBe(computeOrigin(324001, 32));
  });

  it("never returns a value at or above origin_key (1 300 602 071)", () => {
    const KEY = 1300602071;
    for (let t = 1; t < 100; t++) {
      for (let c = 1; c < 50; c++) {
        const v = computeOrigin(t * 1234, c);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThan(KEY);
      }
    }
  });
});
