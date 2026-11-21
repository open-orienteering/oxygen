import { describe, expect, it } from "vitest";
import { CLIMB_THRESHOLD_M, climbRises, climbShares, hysteresisClimb, hysteresisDescent } from "../climb.js";

describe("hysteresisClimb (course-elevation.md §2)", () => {
  it("the threshold is 1 m", () => expect(CLIMB_THRESHOLD_M).toBe(1));

  it("nothing for no heights, one height or flat ground", () => {
    expect(hysteresisClimb([])).toBe(0);
    expect(hysteresisClimb([12])).toBe(0);
    expect(hysteresisClimb([3, 3, 3, 3])).toBe(0);
  });

  it("a steady rise counts in full, from the low to the high", () => {
    expect(hysteresisClimb([0, 2, 4, 6, 8, 10])).toBe(10);
    expect(hysteresisDescent([0, 2, 4, 6, 8, 10])).toBe(0);
  });

  it("a descent first moves the low: the rise counts from the valley", () => {
    expect(hysteresisClimb([10, 4, 9])).toBe(5);
    expect(hysteresisDescent([10, 4, 9])).toBe(6);
  });

  it("a rise below the threshold does not count", () => {
    expect(hysteresisClimb([0, 0.9, 0, 0.9, 0])).toBe(0);
    expect(hysteresisClimb([0, 0.99])).toBe(0);
  });

  it("a rise of exactly the threshold counts", () => {
    expect(hysteresisClimb([0, 1])).toBe(1);
  });

  it("a dip below the threshold inside a rise does not split it", () => {
    // 0 → 5, dip of 0.5, → 8: one rise of 8, not 5 + 3.5
    expect(hysteresisClimb([0, 5, 4.5, 8])).toBe(8);
  });

  it("a dip of the threshold or more ends the rise; the next starts at the dip's low", () => {
    // 0 → 5 (5), down to 3, on down to 2, up to 8 (6)
    expect(hysteresisClimb([0, 5, 3, 2, 8])).toBe(11);
  });

  it("a rise in progress at the end is added", () => {
    expect(hysteresisClimb([5, 0, 3])).toBe(3);
  });

  it("two hills: each counts", () => {
    expect(hysteresisClimb([0, 10, 0, 7, 2])).toBe(17);
    expect(hysteresisDescent([0, 10, 0, 7, 2])).toBe(15);
  });

  it("does not depend on the sampling density", () => {
    const hill = (x: number) => 20 * Math.sin((x / 400) * Math.PI) ** 2 + 6 * Math.sin((x / 90) * Math.PI);
    const at = (step: number) => {
      const zs: number[] = [];
      for (let x = 0; x <= 800 + 1e-9; x += step) zs.push(hill(x));
      return hysteresisClimb(zs);
    };
    const fine = at(0.5);
    expect(fine).toBeGreaterThan(40);
    for (const step of [1, 2, 3, 5]) expect(Math.abs(at(step) - fine)).toBeLessThan(0.02 * fine);
  });

  it("noise below the threshold adds little, where a plain sum of rises adds much", () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
    const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
    const clean: number[] = [], noisy: number[] = [];
    for (let x = 0; x <= 2000; x++) {
      const z = 15 * Math.sin((x / 500) * Math.PI) + 0.01 * x;
      clean.push(z);
      noisy.push(z + 0.2 * gauss());
    }
    const sum = (zs: number[]) => zs.reduce((c, z, i) => (i && z > zs[i - 1] ? c + z - zs[i - 1] : c), 0);
    const truth = hysteresisClimb(clean);
    expect(Math.abs(sum(clean) - truth)).toBeLessThan(0.01 * truth);
    expect(sum(noisy)).toBeGreaterThan(2 * truth);
    expect(Math.abs(hysteresisClimb(noisy) - truth)).toBeLessThan(0.1 * truth);
  });

  it("a custom threshold", () => {
    expect(hysteresisClimb([0, 1.5, 0, 1.5], 2)).toBe(0);
    expect(hysteresisClimb([0, 1.5, 0, 1.5], 0.5)).toBe(3);
  });
});

describe("climbRises / climbShares (course-elevation.md §2)", () => {
  it("rises as index pairs, low then high", () => {
    expect(climbRises([0, 5, 3, 2, 8])).toEqual([{ from: 0, to: 1 }, { from: 3, to: 4 }]);
    expect(climbRises([5, 0, 3])).toEqual([{ from: 1, to: 2 }]);
    expect(climbRises([])).toEqual([]);
  });

  it("a rise spanning ranges is shared by the gain of its running maximum", () => {
    // one rise 0 → 6 with a 0.5 dip; ranges [0..2] and [2..4]
    expect(climbShares([0, 2, 4, 3.5, 6], [0, 2, 4])).toEqual([4, 2]);
    // the dip falls in the second range: it gains only above the earlier top
    expect(climbShares([0, 4, 3.6, 3.8, 6], [0, 1, 4])).toEqual([4, 2]);
  });

  it("shares sum to the climb; ranges without a rise get 0", () => {
    const zs = [0, 3, 1, 1, 1, 7, 2];
    const shares = climbShares(zs, [0, 2, 4, 6]);
    expect(shares).toEqual([3, 0, 6]);
    expect(shares.reduce((a, b) => a + b, 0)).toBe(hysteresisClimb(zs));
  });

  it("no ranges, no heights", () => {
    expect(climbShares([], [0])).toEqual([]);
    expect(climbShares([], [0, 0, 0])).toEqual([0, 0]);
  });
});
