import { describe, expect, it } from "vitest";
import { COORD_FLAG } from "../../../render/pass-stream.js";
import { segmentPoint } from "../../../render/path.js";
import { flattenObject, polylineEnd, polylineLength, walkPolyline } from "../index.js";
import { S, syntheticDoc } from "./synthetic.js";

const { bezierFirst: B1, bezierSecond: B2, hole: HOLE } = COORD_FLAG;

describe("flattenObject (map-terrain.md §1.4)", () => {
  it("returns straight lines in paper mm", () => {
    const d = syntheticDoc([{ sym: S.contour, coords: [0, 0, 1.5, 0, 1.5, 2.25] }]);
    expect(Array.from(flattenObject(d, 0)[0])).toEqual([0, 0, 1.5, 0, 1.5, 2.25]);
  });

  it("cuts a cubic into ⌈control polygon / 0.25 mm⌉ chords, clamped to 3–24", () => {
    // Control polygon 1 + 2 + 1 = 4 mm → 16 chords.
    const d = syntheticDoc([{ sym: S.contour, coords: [0, 0, 0, 1, 2, 1, 2, 0], flags: [0, B1, B2, 0] }]);
    const [p] = flattenObject(d, 0);
    expect(p.length / 2).toBe(17);
    expect([p[32], p[33]]).toEqual([2, 0]);
    const seg = { kind: "cubic" as const, x0: 0, y0: 0, cx0: 0, cy0: 100, cx1: 200, cy1: 100, x1: 200, y1: 0 };
    const [mx, my] = segmentPoint(seg, 0.5);
    expect(p[16]).toBeCloseTo(mx / 100, 12);
    expect(p[17]).toBeCloseTo(my / 100, 12);
    // A tiny cubic still gets three chords; a long one at most 24.
    const tiny = syntheticDoc([{ sym: S.contour, coords: [0, 0, 0, 0.01, 0.01, 0.01, 0.01, 0], flags: [0, B1, B2, 0] }]);
    expect(flattenObject(tiny, 0)[0].length / 2).toBe(4);
    const long = syntheticDoc([{ sym: S.contour, coords: [0, 0, 0, 10, 10, 10, 10, 0], flags: [0, B1, B2, 0] }]);
    expect(flattenObject(long, 0)[0].length / 2).toBe(25);
  });

  it("splits an area's rings at hole flags", () => {
    const d = syntheticDoc([
      { sym: S.water, coords: [0, 0, 10, 0, 10, 10, 0, 10, 0, 0, 2, 2, 4, 2, 4, 4, 2, 2], flags: [0, 0, 0, 0, 0, HOLE, 0, 0, 0] },
    ]);
    const parts = flattenObject(d, 0);
    expect(parts.map((p) => p.length / 2)).toEqual([5, 4]);
    expect([parts[1][0], parts[1][1]]).toEqual([2, 2]);
  });

  it("degrades a malformed control run to straight lines", () => {
    const d = syntheticDoc([{ sym: S.contour, coords: [0, 0, 1, 1, 2, 0], flags: [0, B1, 0] }]);
    expect(Array.from(flattenObject(d, 0)[0])).toEqual([0, 0, 1, 1, 2, 0]);
  });
});

describe("polyline helpers", () => {
  it("measures length", () => {
    expect(polylineLength([0, 0, 3, 4, 3, 5])).toBe(6);
  });

  it("takes the end tangent over 0.6 mm, outward", () => {
    // A hook at the end: the last 0.1 mm turns, the tangent looks past it.
    const p = [0, 0, 1, 0, 2, 0, 2.5, 0, 2.6, 0.1];
    const end = polylineEnd(p, 1);
    expect(end.x).toBe(2.6);
    // Back to (2, 0), the first point at least 0.6 mm along: (0.6, 0.1) normalised.
    expect(end.tx).toBeCloseTo(0.6 / Math.hypot(0.6, 0.1), 12);
    expect(end.ty).toBeCloseTo(0.1 / Math.hypot(0.6, 0.1), 12);
    const start = polylineEnd(p, 0);
    expect(start.tx).toBe(-1);
    expect(start.ty).toBeCloseTo(0, 12);
  });

  it("walks at a fixed step, the first sample half a step in", () => {
    const xs: number[] = [];
    walkPolyline([0, 0, 1, 0, 1, 1], false, 0.5, (x, y) => xs.push(+(x + y).toFixed(6)));
    expect(xs).toEqual([0.25, 0.75, 1.25, 1.75]);
    const n: number[] = [];
    walkPolyline([0, 0, 1, 0, 1, 1], true, 0.5, () => n.push(1));
    expect(n.length).toBe(7); // 2 + √2 mm long: samples at 0.25, 0.75, … 3.25
  });
});
