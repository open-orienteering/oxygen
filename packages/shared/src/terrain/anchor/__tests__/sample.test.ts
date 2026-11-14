import { describe, expect, it } from "vitest";
import { chainDemStats, quantile, smoothedSampler, stencilSize } from "../sample.js";
import { ANCHOR_RULES } from "../types.js";
import { cone, line, planeX, ring } from "./synthetic-dem.js";

const G = 15; // 1:15 000
const anchorSide = ANCHOR_RULES.side.anchor;

describe("quantile (§6.2)", () => {
  it("interpolates linearly between order statistics", () => {
    const a = [1, 2, 3, 4];
    expect(quantile(a, 0.5)).toBeCloseTo(2.5);
    expect(quantile(a, 0.25)).toBeCloseTo(1.75);
    expect(quantile([7], 0.9)).toBe(7);
    expect(quantile([], 0.5)).toBeNaN();
  });
});

describe("chain statistics (§6.2)", () => {
  it("a ring on a cone has an exact median and no spread", () => {
    const dem = cone(0, 0, 100, 0.1, G);
    const s = chainDemStats(ring(0, 0, 10), true, dem, dem, G, anchorSide);
    // 10 mm at 1:15 000 = 150 m from the top, 0.1 m/m → 85 m (chords sit a little inside).
    expect(s.median).toBeCloseTo(85, 0);
    expect(s.halfIqr).toBeLessThan(0.05);
    expect(s.coverage).toBe(1);
  });

  it("a line up a plane has a quarter of its height range as half-IQR", () => {
    const dem = planeX(0.1, G); // 1.5 m per paper mm
    const s = chainDemStats(line(0, 0, 20, 0), false, dem, dem, G, anchorSide);
    expect(s.median).toBeCloseTo(15, 1);
    expect(s.halfIqr).toBeCloseTo(30 / 4, 0);
  });

  it("samples at most 2 m apart on the ground at 1:15 000 and 1:4 000", () => {
    for (const g of [15, 4]) {
      const dem = planeX(0, g);
      const lengthMm = 30;
      const s = chainDemStats(line(0, 0, lengthMm, 0), false, dem, dem, g, anchorSide);
      expect(s.samples).toBeGreaterThanOrEqual(Math.floor((lengthMm * g) / 2));
      expect(s.samples).toBeLessThanOrEqual(Math.ceil((lengthMm * g) / 2));
    }
  });

  it("counts coverage over all samples and NaN for no data", () => {
    const half: (x: number, y: number) => number = (x) => (x < 0 ? NaN : 10);
    const s = chainDemStats(line(-10, 0, 10, 0), false, half, half, G, anchorSide);
    expect(s.coverage).toBeCloseTo(0.5, 2);
    expect(s.median).toBe(10);
    const none = chainDemStats(line(-10, 0, -5, 0), false, half, half, G, anchorSide);
    expect(none.valid).toBe(0);
    expect(none.coverage).toBe(0);
    expect(none.median).toBeNaN();
    expect(none.halfIqr).toBeNaN();
    expect(none.side).toBe(0);
  });

  it("walks a closed chain's closing segment", () => {
    const square = new Float64Array([0, 0, 10, 0, 10, 10, 0, 10]);
    const dem = planeX(0, G);
    const closed = chainDemStats(square, true, dem, dem, G, anchorSide);
    const open = chainDemStats(square, false, dem, dem, G, anchorSide);
    expect(closed.samples).toBe(Math.round((40 * G) / 2));
    expect(open.samples).toBe(Math.round((30 * G) / 2));
  });
});

describe("the smoothed model (§6.3)", () => {
  it("sizes the stencil from the DEM cell", () => {
    expect(stencilSize(1, 5)).toBe(5);
    expect(stencilSize(2, 5)).toBe(3);
    expect(stencilSize(5, 5)).toBe(1);
    expect(stencilSize(0.5, 5)).toBe(5);
    expect(stencilSize(30, 5)).toBe(1);
    expect(stencilSize(1, 0)).toBe(1);
  });

  it("is an n × n box mean at the DEM cell", () => {
    const spike = (x: number, y: number) => (Math.abs(x) < 1e-9 && Math.abs(y) < 1e-9 ? 25 : 0);
    const s = smoothedSampler(spike, 1, G, 5);
    expect(s(0, 0)).toBeCloseTo(1);
    // One DEM cell (1 m = 1/15 mm) away the spike is still inside the 5 × 5 box.
    expect(s(1 / G, 0)).toBeCloseTo(1);
    expect(s(3 / G, 0)).toBe(0);
  });

  it("is NaN when any stencil point is NaN", () => {
    const edge = (x: number) => (x > 0.2 ? NaN : 1); // the stencil reaches ±2 m = ±0.133 mm
    const s = smoothedSampler(edge, 1, G, 5);
    expect(s(0, 0)).toBe(1);
    expect(s(0.1, 0)).toBeNaN();
  });

  it("is the sampler itself without smoothing", () => {
    const dem = planeX(0.1, G);
    expect(smoothedSampler(dem, 30, G, 0)).toBe(dem);
  });
});
