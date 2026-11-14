import { describe, expect, it } from "vitest";
import { chainDemStats, smoothedSampler } from "../sample.js";
import { ANCHOR_RULES, type DemSampler } from "../types.js";
import { cone, line, pit, ring } from "./synthetic-dem.js";

const G = 15;
const A = ANCHOR_RULES.side.anchor;
const C = ANCHOR_RULES.side.coarse;
const stats = (pts: Float64Array, closed: boolean, dem: DemSampler, rule: { offsetM: number; smoothM: number; minM: number } = A) =>
  chainDemStats(pts, closed, dem, smoothedSampler(dem, 1, G, rule.smoothM), G, rule);

/** Rises `slope` per ground metre along +y where `up(x)`, falls where not: left of a +x line is +y. */
const flipping = (slope: number, up: (x: number) => boolean): DemSampler => (x, y) => (up(x) ? 1 : -1) * slope * y * G;

describe("the DEM side (§6.3)", () => {
  it("a counter-clockwise ring around a hill is uphill left", () => {
    const s = stats(ring(0, 0, 10), true, cone(0, 0, 100, 0.1, G));
    expect(s.side).toBe(1);
    expect(s.sideMedian).toBeCloseTo(1.6, 1); // 16 m across at 0.1 m/m
    expect(s.sideAgree).toBe(1);
  });

  it("the same ring around a pit is uphill right", () => {
    expect(stats(ring(0, 0, 10), true, pit(0, 0, 10, 0.1, G)).side).toBe(-1);
  });

  it("is undecided below 0.4 m across 16 m", () => {
    const s = stats(ring(0, 0, 10), true, cone(0, 0, 100, 0.02, G));
    expect(s.sideMedian).toBeCloseTo(0.32, 1);
    expect(s.side).toBe(0);
  });

  it("needs 65 % of the samples to agree", () => {
    const at60 = stats(line(0, 0, 100, 0), false, flipping(0.1, (x) => x < 60));
    expect(at60.sideAgree).toBeCloseTo(0.6, 1);
    expect(at60.side).toBe(0);
    const at70 = stats(line(0, 0, 100, 0), false, flipping(0.1, (x) => x < 70));
    expect(at70.sideAgree).toBeCloseTo(0.7, 1);
    expect(at70.side).toBe(1);
  });

  it("is undecided on an uncovered chain", () => {
    const hill = cone(0, 0, 100, 0.1, G);
    const partly: DemSampler = (x, y) => (x < -8 ? NaN : hill(x, y));
    const s = stats(ring(0, 0, 10), true, partly);
    expect(s.coverage).toBeLessThan(ANCHOR_RULES.coverageMin);
    expect(s.side).toBe(0);
  });

  it("a coarse model probes at ±20 m unsmoothed and needs 0.5 m", () => {
    // 0.015 m/m: 0.24 m across 16 m (anchor: undecided), 0.6 m across 40 m (coarse: decided).
    const gentle = cone(0, 0, 100, 0.015, G);
    expect(stats(ring(0, 0, 10), true, gentle, A).side).toBe(0);
    const coarse = stats(ring(0, 0, 10), true, gentle, C);
    expect(coarse.sideMedian).toBeCloseTo(0.6, 1);
    expect(coarse.side).toBe(1);
  });
});
