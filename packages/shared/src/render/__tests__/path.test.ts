import { describe, expect, it } from "vitest";
import { COORD_FLAG, makePath } from "../pass-stream.js";
import {
  hatchLines,
  pathBounds,
  pathRings,
  pathSegments,
  ringSegments,
  segmentLength,
  segmentPoint,
  segmentSub,
  sliceSegments,
  type Segment,
} from "../path.js";

const F = COORD_FLAG;

describe("pathRings", () => {
  it("returns one ring without hole flags", () => {
    const p = makePath([0, 0, 10, 0, 10, 10], undefined, true);
    expect(pathRings(p)).toEqual([{ start: 0, end: 3, hole: false }]);
  });
  it("splits at hole flags; first ring is the outer boundary", () => {
    const p = makePath([0, 0, 10, 0, 10, 10, 2, 2, 4, 2, 4, 4, 6, 6, 8, 6], [0, 0, 0, F.hole, 0, 0, F.hole, 0], true);
    expect(pathRings(p)).toEqual([
      { start: 0, end: 3, hole: false },
      { start: 3, end: 6, hole: true },
      { start: 6, end: 8, hole: true },
    ]);
  });
});

describe("ringSegments / pathSegments", () => {
  it("emits lines for unflagged points", () => {
    const p = makePath([0, 0, 10, 0, 10, 10]);
    expect(pathSegments(p)).toEqual([
      { kind: "line", x0: 0, y0: 0, x1: 10, y1: 0 },
      { kind: "line", x0: 10, y0: 0, x1: 10, y1: 10 },
    ]);
  });
  it("consumes two control points into one cubic", () => {
    const p = makePath([0, 0, 3, 10, 7, -10, 10, 0, 20, 0], [0, F.bezierFirst, F.bezierSecond, 0, 0]);
    expect(pathSegments(p)).toEqual([
      { kind: "cubic", x0: 0, y0: 0, cx0: 3, cy0: 10, cx1: 7, cy1: -10, x1: 10, y1: 0 },
      { kind: "line", x0: 10, y0: 0, x1: 20, y1: 0 },
    ]);
  });
  it("degrades a dangling control point to lines instead of throwing", () => {
    const p = makePath([0, 0, 3, 10, 10, 0], [0, F.bezierFirst, 0]);
    expect(pathSegments(p).every((s) => s.kind === "line")).toBe(true);
    expect(pathSegments(p)).toHaveLength(2);
  });
  it("closes rings with a line back to the start when the path is closed", () => {
    const p = makePath([0, 0, 10, 0, 10, 10], undefined, true);
    const segs = ringSegments(p, pathRings(p)[0]);
    expect(segs).toHaveLength(3);
    expect(segs[2]).toEqual({ kind: "line", x0: 10, y0: 10, x1: 0, y1: 0 });
  });
  it("does not add a closing segment when the ring already ends at its start", () => {
    const p = makePath([0, 0, 10, 0, 10, 10, 0, 0], undefined, true);
    expect(ringSegments(p, pathRings(p)[0])).toHaveLength(3);
  });
});

describe("pathBounds", () => {
  it("covers all points including control points", () => {
    const p = makePath([0, 0, 3, 50, 7, -20, 10, 0], [0, 1, 2, 0]);
    expect(pathBounds(p)).toEqual({ minX: 0, minY: -20, maxX: 10, maxY: 50 });
  });
  it("is zero for an empty path", () => {
    expect(pathBounds(makePath([]))).toEqual({ minX: 0, minY: 0, maxX: 0, maxY: 0 });
  });
});

describe("Bézier evaluation and splitting", () => {
  const c: Segment = { kind: "cubic", x0: 0, y0: 0, cx0: 0, cy0: 100, cx1: 100, cy1: 100, x1: 100, y1: 0 };

  it("segmentPoint hits the endpoints and the symmetric midpoint", () => {
    expect(segmentPoint(c, 0)).toEqual([0, 0]);
    expect(segmentPoint(c, 1)).toEqual([100, 0]);
    const [mx, my] = segmentPoint(c, 0.5);
    expect(mx).toBeCloseTo(50);
    expect(my).toBeCloseTo(75);
  });

  it("segmentSub returns a curve whose endpoints lie on the original", () => {
    const sub = segmentSub(c, 0.25, 0.75);
    expect(sub.kind).toBe("cubic");
    const [ax, ay] = segmentPoint(c, 0.25);
    const [bx, by] = segmentPoint(c, 0.75);
    expect(sub.x0).toBeCloseTo(ax);
    expect(sub.y0).toBeCloseTo(ay);
    expect(sub.x1).toBeCloseTo(bx);
    expect(sub.y1).toBeCloseTo(by);
    // Interior point of the sub-curve coincides with the original at the mapped parameter.
    const [sx, sy] = segmentPoint(sub, 0.5);
    const [ox, oy] = segmentPoint(c, 0.5);
    expect(sx).toBeCloseTo(ox);
    expect(sy).toBeCloseTo(oy);
  });

  it("segmentSub of a line is a line between the parameter points", () => {
    expect(segmentSub({ kind: "line", x0: 0, y0: 0, x1: 100, y1: 0 }, 0.1, 0.4)).toEqual({ kind: "line", x0: 10, y0: 0, x1: 40, y1: 0 });
  });

  it("segmentLength matches the straight length for degenerate cubics and is subdivision-stable", () => {
    const straight: Segment = { kind: "cubic", x0: 0, y0: 0, cx0: 30, cy0: 0, cx1: 70, cy1: 0, x1: 100, y1: 0 };
    expect(segmentLength(straight)).toBeCloseTo(100, 6);
    const l = segmentLength(c, 0.01);
    const halves = segmentLength(segmentSub(c, 0, 0.5), 0.01) + segmentLength(segmentSub(c, 0.5, 1), 0.01);
    expect(Math.abs(l - halves)).toBeLessThan(0.05);
  });
});

describe("sliceSegments", () => {
  const p = makePath([0, 0, 100, 0, 100, 100, 200, 100]);

  it("returns whole segments inside the slice and partial ones at the ends", () => {
    const segs = sliceSegments(p, { seg0: 0, t0: 0.5, seg1: 2, t1: 0.25 });
    expect(segs).toEqual([
      { kind: "line", x0: 50, y0: 0, x1: 100, y1: 0 },
      { kind: "line", x0: 100, y0: 0, x1: 100, y1: 100 },
      { kind: "line", x0: 100, y0: 100, x1: 125, y1: 100 },
    ]);
  });
  it("handles a slice inside a single segment", () => {
    expect(sliceSegments(p, { seg0: 1, t0: 0.2, seg1: 1, t1: 0.6 })).toEqual([{ kind: "line", x0: 100, y0: 20, x1: 100, y1: 60 }]);
  });
  it("returns nothing for empty or inverted slices", () => {
    expect(sliceSegments(p, { seg0: 1, t0: 0.5, seg1: 1, t1: 0.5 })).toEqual([]);
    expect(sliceSegments(p, { seg0: 2, t0: 0, seg1: 1, t1: 1 })).toEqual([]);
  });
});

describe("hatchLines", () => {
  const b = { minX: 0, minY: 0, maxX: 10000, maxY: 10000 };

  it("produces horizontal lines spaced by spacingUm anchored at offsetUm", () => {
    const lines = hatchLines(b, { spacingUm: 2500, offsetUm: 500, angleDeg: 0 });
    expect(lines.map((l) => l.y0)).toEqual([500, 3000, 5500, 8000]);
    for (const l of lines) {
      expect(l.y1).toBe(l.y0);
      expect(l.x0).toBeLessThanOrEqual(0);
      expect(l.x1).toBeGreaterThanOrEqual(10000);
    }
  });
  it("rotates with angleDeg (vertical lines at 90°)", () => {
    const lines = hatchLines(b, { spacingUm: 5000, offsetUm: 0, angleDeg: 90 });
    const xs = lines.map((l) => Math.round(l.x0)).sort((a, c) => a - c);
    expect(xs).toEqual([0, 5000, 10000]);
    for (const l of lines) expect(Math.round(l.x0)).toBe(Math.round(l.x1));
  });
  it("covers the diagonal extent for 45°", () => {
    const lines = hatchLines(b, { spacingUm: 1000, offsetUm: 0, angleDeg: 45 });
    // Perpendicular extent of a 10 mm square across the 45° normal is 10√2 mm → 15 lines (k = -7..7).
    expect(lines).toHaveLength(15);
  });
  it("returns nothing for non-positive spacing", () => {
    expect(hatchLines(b, { spacingUm: 0, offsetUm: 0, angleDeg: 0 })).toEqual([]);
  });
});
