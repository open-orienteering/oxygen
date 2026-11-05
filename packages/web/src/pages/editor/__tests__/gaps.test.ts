import { describe, expect, it } from "vitest";
import {
  circleGapAt, circleGapFromDrag, compassDeg, legFraction, legGapAt, legGapFromDrag, mergeCircleGaps, mergeLegGaps,
} from "../tools/gaps";

const c = { x: 0, y: 0 };
const at = (deg: number, r = 3) => ({ x: r * Math.sin((deg * Math.PI) / 180), y: r * Math.cos((deg * Math.PI) / 180) });

describe("circle gaps (docs/course-layer.md §2 convention)", () => {
  it("compass degrees: 0° = +y, clockwise", () => {
    expect(compassDeg(c, { x: 0, y: 1 })).toBeCloseTo(0);
    expect(compassDeg(c, { x: 1, y: 0 })).toBeCloseTo(90);
    expect(compassDeg(c, { x: -1, y: 0 })).toBeCloseTo(270);
  });

  it("a rim drag opens the shorter arc whichever way it went", () => {
    expect(circleGapFromDrag(c, at(10), at(40))).toEqual({ start: 10, end: 40 });
    expect(circleGapFromDrag(c, at(40), at(10))).toEqual({ start: 10, end: 40 });
    expect(circleGapFromDrag(c, at(350), at(20))).toEqual({ start: 350, end: 20 });
  });

  it("a drag shorter than the minimum is no gap", () => {
    expect(circleGapFromDrag(c, at(10), at(11))).toBeNull();
  });

  it("merges overlapping arcs, across north too", () => {
    expect(mergeCircleGaps([{ start: 10, end: 40 }, { start: 30, end: 60 }, { start: 100, end: 110 }]))
      .toEqual([{ start: 10, end: 60 }, { start: 100, end: 110 }]);
    expect(mergeCircleGaps([{ start: 350, end: 10 }, { start: 5, end: 20 }])).toEqual([{ start: 350, end: 20 }]);
    expect(mergeCircleGaps([{ start: 300, end: 359 }, { start: 0, end: 10 }])).toEqual([{ start: 0, end: 10 }, { start: 300, end: 359 }]);
  });

  it("finds the gap under an angle", () => {
    const gaps = [{ start: 350, end: 20 }, { start: 100, end: 110 }];
    expect(circleGapAt(gaps, 5)).toBe(0);
    expect(circleGapAt(gaps, 105)).toBe(1);
    expect(circleGapAt(gaps, 200)).toBe(-1);
  });
});

describe("leg gaps", () => {
  const a = { x: 0, y: 0 }, b = { x: 100, y: 0 };
  it("fractions of the centre-to-centre leg, clamped", () => {
    expect(legFraction(a, b, { x: 25, y: 5 })).toBe(0.25);
    expect(legFraction(a, b, { x: -5, y: 0 })).toBe(0);
  });

  it("a drag along the leg opens from the smaller fraction", () => {
    expect(legGapFromDrag(a, b, { x: 60, y: 0 }, { x: 40, y: 1 })).toEqual({ from: 0.4, to: 0.6 });
    expect(legGapFromDrag(a, b, { x: 40, y: 0 }, { x: 40.2, y: 0 })).toBeNull();
  });

  it("merges and finds gaps", () => {
    const gaps = mergeLegGaps([{ from: 0.5, to: 0.7 }, { from: 0.2, to: 0.3 }, { from: 0.25, to: 0.4 }]);
    expect(gaps).toEqual([{ from: 0.2, to: 0.4 }, { from: 0.5, to: 0.7 }]);
    expect(legGapAt(gaps, 0.6)).toBe(1);
    expect(legGapAt(gaps, 0.45)).toBe(-1);
  });
});
