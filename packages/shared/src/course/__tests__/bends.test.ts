/** A leg's bends as a path (course-layer.md §10.1, F13). */

import { describe, expect, it } from "vitest";
import { LEG_FLATTEN_TOLERANCE_MM, bendSegmentAt, hasCurvedBends, isCurvedSegment, legPolylineOf, reverseBends } from "../bends.js";
import { legLengthMm } from "../derive.js";
import type { PathVertex } from "../../course-maps/schema.js";

/** Bézier circle constant × 20 mm: a quarter circle of radius 20 about the origin. */
const K = 0.5522847498 * 20;
const A = { x: 30, y: 0 }, B = { x: 0, y: 30 };
const QUARTER: PathVertex[] = [{ x: 20, y: 0, hOut: { x: 0, y: K } }, { x: 0, y: 20, hIn: { x: K, y: 0 } }];

const cubicAt = (p0: { x: number; y: number }, c0: { x: number; y: number }, c1: { x: number; y: number }, p1: { x: number; y: number }, t: number) => {
  const m = 1 - t;
  return {
    x: m * m * m * p0.x + 3 * m * m * t * c0.x + 3 * m * t * t * c1.x + t * t * t * p1.x,
    y: m * m * m * p0.y + 3 * m * m * t * c0.y + 3 * m * t * t * c1.y + t * t * t * p1.y,
  };
};

/** Distance from `p` to the polyline. */
function distTo(pts: readonly { x: number; y: number }[], p: { x: number; y: number }): number {
  let best = Infinity;
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i], b = pts[i + 1];
    const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
    const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2));
    best = Math.min(best, Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t)));
  }
  return best;
}

describe("legPolylineOf (§10.1)", () => {
  it("without handles is exactly [a, …bends, b], repeats dropped", () => {
    expect(legPolylineOf(A, undefined, B)).toEqual([A, B]);
    expect(legPolylineOf(A, [{ x: 10, y: 10 }, { x: 10, y: 10 }, { x: 5, y: 20 }], B)).toEqual([A, { x: 10, y: 10 }, { x: 5, y: 20 }, B]);
    expect(legPolylineOf(A, [], A)).toEqual([A, A]);
  });

  it("flattens a cubic within 5 µm and keeps the anchors verbatim", () => {
    const pts = legPolylineOf(A, QUARTER, B);
    expect(pts.length).toBeGreaterThan(QUARTER.length + 2 + 10);
    expect(pts[0]).toEqual(A);
    expect(pts.at(-1)).toEqual(B);
    expect(pts).toContainEqual({ x: 20, y: 0 });
    expect(pts).toContainEqual({ x: 0, y: 20 });
    const c0 = { x: 20, y: K }, c1 = { x: K, y: 20 };
    for (let k = 0; k <= 100; k++) {
      expect(distTo(pts, cubicAt(QUARTER[0], c0, c1, QUARTER[1], k / 100))).toBeLessThan(LEG_FLATTEN_TOLERANCE_MM);
    }
  });

  it("measures a quarter circle along the arc", () => {
    expect(legLengthMm(legPolylineOf(A, QUARTER, B))).toBeCloseTo(20 + 10 * Math.PI, 1);
    expect(Math.abs(legLengthMm(legPolylineOf(A, QUARTER, B)) - (20 + 10 * Math.PI))).toBeLessThan(0.02);
  });

  it("never reads a handle on a site: the ends stay straight", () => {
    // A segment from a is a cubic only by its end's hIn.
    expect(isCurvedSegment([{ x: 1, y: 1 }], 0)).toBe(false);
    expect(isCurvedSegment([{ x: 1, y: 1, hIn: { x: 1, y: 0 } }], 0)).toBe(true);
    expect(isCurvedSegment([{ x: 1, y: 1, hOut: { x: 1, y: 0 } }], 1)).toBe(true);
    expect(isCurvedSegment([{ x: 1, y: 1, hIn: { x: 1, y: 0 } }], 1)).toBe(false);
    expect(hasCurvedBends([{ x: 1, y: 1 }])).toBe(false);
    expect(hasCurvedBends(QUARTER)).toBe(true);
  });

  it("is deterministic", () => {
    expect(legPolylineOf(A, QUARTER, B)).toEqual(legPolylineOf(A, QUARTER, B));
    expect(legPolylineOf(A, QUARTER, B, 0.1).length).toBeLessThan(legPolylineOf(A, QUARTER, B).length);
  });
});

describe("bendSegmentAt (§3.2, §10.3)", () => {
  it("picks the curved segment near its apex, the straight ones near the ends", () => {
    const apex = { x: 20 * Math.SQRT1_2, y: 20 * Math.SQRT1_2 };
    const hit = bendSegmentAt(A, QUARTER, B, apex);
    expect(hit.index).toBe(1);
    expect(hit.dist).toBeLessThan(0.01);
    expect(hit.t).toBeCloseTo(0.5, 2);
    expect(bendSegmentAt(A, QUARTER, B, { x: 25, y: 1 }).index).toBe(0);
    expect(bendSegmentAt(A, QUARTER, B, { x: 1, y: 25 }).index).toBe(2);
  });

  it("ties to the lowest index; a straight leg has one segment", () => {
    expect(bendSegmentAt(A, QUARTER, B, { x: 20, y: 0 }).index).toBe(0);
    expect(bendSegmentAt(A, undefined, B, { x: 15, y: 15 })).toMatchObject({ index: 0, t: 0.5 });
  });
});

describe("reverseBends", () => {
  it("swaps hIn and hOut and flattens to the reverse polyline", () => {
    const back = reverseBends(QUARTER);
    expect(back).toEqual([{ x: 0, y: 20, hOut: { x: K, y: 0 } }, { x: 20, y: 0, hIn: { x: 0, y: K } }]);
    const fwd = legPolylineOf(A, QUARTER, B);
    const rev = legPolylineOf(B, back, A);
    expect(rev.length).toBe(fwd.length);
    expect(legLengthMm(rev)).toBeCloseTo(legLengthMm(fwd), 9);
    for (const p of rev) expect(distTo(fwd, p)).toBeLessThan(1e-9 + LEG_FLATTEN_TOLERANCE_MM);
  });
});
