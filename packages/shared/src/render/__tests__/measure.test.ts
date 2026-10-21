import { describe, expect, it } from "vitest";
import { COORD_FLAG, makePath } from "../pass-stream.js";
import { PathMeasure, gapIntervals, pathSections, subtractIntervals, wrapIntervals } from "../measure.js";
import { circlePath } from "../glyph-table.js";

const F = COORD_FLAG;

describe("PathMeasure", () => {
  it("measures polylines exactly", () => {
    const m = new PathMeasure(makePath([0, 0, 3000, 0, 3000, 4000]));
    expect(m.totalLength).toBe(7000);
    expect(Array.from(m.cumulative)).toEqual([0, 3000, 7000]);
  });

  it("measures a four-cubic Bézier circle to within 5 µm of 2πr (the Bézier itself deviates ~0.03 %)", () => {
    const m = new PathMeasure(circlePath(0, 0, 5000));
    expect(Math.abs(m.totalLength - 2 * Math.PI * 5000)).toBeLessThan(5);
  });

  it("inverts length to (segment, t) and back", () => {
    const m = new PathMeasure(makePath([0, 0, 3000, 0, 3000, 4000]));
    expect(m.paramAt(1500)).toEqual({ seg: 0, t: 0.5 });
    expect(m.paramAt(3000)).toEqual({ seg: 1, t: 0 });
    expect(m.paramAt(5000)).toEqual({ seg: 1, t: 0.5 });
    expect(m.paramAt(99999)).toEqual({ seg: 1, t: 1 });
    expect(m.lengthAt(1, 0.5)).toBe(5000);
    const c = new PathMeasure(circlePath(0, 0, 5000));
    const quarter = c.totalLength / 4;
    const p = c.pointAt(quarter);
    expect(p.x).toBeCloseTo(0, 0);
    expect(p.y).toBeCloseTo(5000, 0);
    expect(p.tx).toBeCloseTo(-1, 2);
    expect(p.ty).toBeCloseTo(0, 2);
    expect(Math.abs(c.lengthAt(p.seg, p.t) - quarter)).toBeLessThan(0.5);
  });

  it("reports tangents and slices", () => {
    const m = new PathMeasure(makePath([0, 0, 3000, 0, 3000, 4000]));
    const p = m.pointAt(4000);
    expect([p.tx, p.ty]).toEqual([0, 1]);
    expect(m.sliceBetween(1000, 5000)).toEqual({ seg0: 0, t0: 1000 / 3000, seg1: 1, t1: 0.5 });
  });

  it("maps segments back to their starting point, including after cubics", () => {
    const m = new PathMeasure(makePath([0, 0, 1000, 1000, 2000, 1000, 3000, 0, 4000, 0], [0, 1, 2, 0, 0]));
    expect(Array.from(m.segmentStartPoint)).toEqual([0, 3]);
    expect(m.flaggedLengths(F.corner)).toEqual([]);
  });
});

describe("pathSections", () => {
  const sec = (startLen: number, endLen: number, o: Partial<{ closedLoop: boolean; dashStart: boolean; dashEnd: boolean }> = {}) => ({
    startLen, endLen, closedLoop: false, dashStart: false, dashEnd: false, ...o,
  });
  it("is one section without split points, closed loops flagged", () => {
    expect(pathSections(new PathMeasure(makePath([0, 0, 1000, 0])))).toEqual([sec(0, 1000)]);
    const sq = makePath([0, 0, 1000, 0, 1000, 1000, 0, 1000], undefined, true);
    expect(pathSections(new PathMeasure(sq))).toEqual([sec(0, 4000, { closedLoop: true })]);
  });
  it("splits at corner and dash points and says which ends are dash points", () => {
    const m = new PathMeasure(makePath([0, 0, 1000, 0, 2000, 0, 3000, 0], [0, F.corner, F.dash, 0]));
    expect(pathSections(m)).toEqual([sec(0, 1000), sec(1000, 2000, { dashEnd: true }), sec(2000, 3000, { dashStart: true })]);
    // With the corner mask only, dash points neither split nor count.
    expect(pathSections(m, F.corner)).toEqual([sec(0, 1000), sec(1000, 3000)]);
  });
  it("on a closed path, the piece through the start point is one section that wraps", () => {
    // One corner: one section all the way round, from the corner back to it.
    const sq = makePath([0, 0, 1000, 0, 1000, 1000, 0, 1000], [0, 0, F.corner, 0], true);
    expect(pathSections(new PathMeasure(sq))).toEqual([sec(2000, 6000)]);
    // Two split points: the second section runs from the dash point through the start to the corner.
    const two = makePath([0, 0, 1000, 0, 1000, 1000, 0, 1000], [0, F.corner, 0, F.dash], true);
    expect(pathSections(new PathMeasure(two))).toEqual([sec(1000, 3000, { dashEnd: true }), sec(3000, 5000, { dashStart: true })]);
  });
  it("a flagged start point of a closed path is a split point", () => {
    const sq = makePath([0, 0, 1000, 0, 1000, 1000, 0, 1000], [F.dash, 0, F.corner, 0], true);
    expect(pathSections(new PathMeasure(sq))).toEqual([sec(0, 2000, { dashStart: true }), sec(2000, 4000, { dashEnd: true })]);
  });
  it("wrapIntervals folds lengths beyond the path end back to its start", () => {
    expect(wrapIntervals([[3500, 4500], [2000, 3000], [4600, 4800]], 4000)).toEqual([[0, 500], [600, 800], [2000, 3000], [3500, 4000]]);
    // Touching intervals are one drawn dash; nothing merges across the start point.
    expect(wrapIntervals([[1000, 2000], [2000, 2500], [3000, 4000], [0, 500]], 4000)).toEqual([[0, 500], [1000, 2500], [3000, 4000]]);
  });
});

describe("gap points", () => {
  it("pairs gap points into intervals and subtracts them", () => {
    const m = new PathMeasure(makePath([0, 0, 1000, 0, 2000, 0, 3000, 0, 4000, 0], [0, F.gap, 0, F.gap, 0]));
    expect(gapIntervals(m)).toEqual([[1000, 3000]]);
    expect(subtractIntervals([[0, 4000]], gapIntervals(m))).toEqual([[0, 1000], [3000, 4000]]);
    expect(subtractIntervals([[500, 1500], [2500, 2800], [3500, 3800]], [[1000, 3000]])).toEqual([[500, 1000], [3500, 3800]]);
  });
  it("an unpaired gap point at the end runs to the end of the line", () => {
    const m = new PathMeasure(makePath([0, 0, 1000, 0, 2000, 0], [0, F.gap, F.gap]));
    expect(gapIntervals(m)).toEqual([[1000, 2000]]);
  });
});
