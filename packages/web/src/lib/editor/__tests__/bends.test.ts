import { describe, it, expect } from "vitest";
import {
  roundBend,
  dragBendGrip, insertBendAt, legPath, legPolyline, moveBend, setBendKind, toggleBendSmooth, pointAtFraction, polylineDistance, polylineFraction, polylineLength, polylineSlice, removeBend,
} from "../bends";

const A = { x: 0, y: 0 }, B = { x: 20, y: 0 };

describe("bends (docs/course-editor.md §6.7)", () => {
  it("the leg is [from, ...bends, to]", () => {
    expect(legPolyline(A, undefined, B)).toEqual([A, B]);
    expect(legPolyline(A, [{ x: 10, y: 10 }], B)).toEqual([A, { x: 10, y: 10 }, B]);
  });

  it("adds a smooth bend on the nearest segment, keeping the order; its handles from its neighbours (F16)", () => {
    // On the straight leg: at the nearest point of the segment, hOut = (next − prev) / 6, collinear (the shape kept).
    expect(insertBendAt(A, [], B, { x: 10, y: 1 })).toEqual({ bends: [{ x: 10, y: 0, hIn: { x: -3.33, y: 0 }, hOut: { x: 3.33, y: 0 } }], index: 0 });
    const two = [{ x: 5, y: 10 }, { x: 15, y: 10 }];
    // Near the first segment A → (5,10): before the first bend; its neighbours are A and (5,10).
    const first = insertBendAt(A, two, B, { x: 2, y: 5 });
    expect(first.index).toBe(0);
    expect(first.bends.slice(1)).toEqual(two);
    expect(first.bends[0]).toMatchObject({ x: 2.4, y: 4.8, hOut: { x: 0.83, y: 1.67 }, hIn: { x: -0.83, y: -1.67 } });
    // Near the middle segment, then the last: the stored corners stay corners.
    const mid = insertBendAt(A, two, B, { x: 10, y: 11 });
    expect(mid).toEqual({ bends: [two[0], { x: 10, y: 10, hIn: { x: -1.67, y: 0 }, hOut: { x: 1.67, y: 0 } }, two[1]], index: 1 });
    expect(insertBendAt(A, two, B, { x: 18, y: 4 }).index).toBe(2);
    expect(insertBendAt(A, two, B, { x: 18, y: 4 }).bends.slice(0, 2)).toEqual(two);
  });

  it("Alt on Add bend here: a corner", () => {
    expect(insertBendAt(A, [], B, { x: 10, y: 1 }, true)).toEqual({ bends: [{ x: 10, y: 0 }], index: 0 });
  });

  it("the path is [from, ...bends, to]; a bend rounds to 0.01 mm, a handle that rounds to nothing dropped", () => {
    const bends = [{ x: 10, y: 5, hOut: { x: 1, y: 0 } }];
    expect(legPath(A, bends, B)).toEqual([A, bends[0], B]);
    expect(roundBend({ x: 1.234, y: 5.678, hIn: { x: 0.004, y: 0 }, hOut: { x: 1.006, y: -2.001 } })).toEqual({ x: 1.23, y: 5.68, hOut: { x: 1.01, y: -2 } });
  });

  it("Alt-click toggles a bend between corner and smooth; the Smooth / Corner buttons set it", () => {
    const corner = [{ x: 10, y: 6 }];
    const smooth = toggleBendSmooth(A, corner, B, 0)!;
    expect(smooth).toEqual([{ x: 10, y: 6, hIn: { x: -3.33, y: 0 }, hOut: { x: 3.33, y: 0 } }]);
    expect(toggleBendSmooth(A, smooth, B, 0)).toEqual(corner);
    // A bend with one handle (a split's neighbour) has a handle: a corner.
    expect(toggleBendSmooth(A, [{ x: 10, y: 6, hIn: { x: -1, y: 0 } }], B, 0)).toEqual(corner);
    expect(toggleBendSmooth(A, corner, B, 3)).toBeNull();
    expect(setBendKind(A, corner, B, 0, "smooth")).toEqual(smooth);
    expect(setBendKind(A, smooth, B, 0, "corner")).toEqual(corner);
    // Already that kind: unchanged (no fresh handles over a pulled pair).
    const pulled = [{ x: 10, y: 6, hIn: { x: -1, y: 2 }, hOut: { x: 4, y: 0 } }];
    expect(setBendKind(A, pulled, B, 0, "smooth")).toEqual(pulled);
    expect(setBendKind(A, corner, B, 0, "corner")).toEqual(corner);
  });

  it("a grip drags one handle, the pair mirrored unless Alt; Shift turns it to 45°; rounded", () => {
    const smooth = [{ x: 10, y: 0, hIn: { x: -3, y: 0 }, hOut: { x: 3, y: 0 } }];
    expect(dragBendGrip(smooth, 0, "out", { x: 2, y: 2.004 }, false, false)).toEqual([{ x: 10, y: 0, hIn: { x: -2, y: -2 }, hOut: { x: 2, y: 2 } }]);
    expect(dragBendGrip(smooth, 0, "out", { x: 2, y: 2 }, true, false)).toEqual([{ x: 10, y: 0, hIn: { x: -3, y: 0 }, hOut: { x: 2, y: 2 } }]);
    // A half-way value rounds the same either way: the pair stays exactly mirrored.
    expect(dragBendGrip(smooth, 0, "out", { x: 7.985, y: -1.006 }, false, false)).toEqual([{ x: 10, y: 0, hIn: { x: -7.99, y: 1.01 }, hOut: { x: 7.99, y: -1.01 } }]);
    expect(dragBendGrip(smooth, 0, "in", { x: -3, y: 0.4 }, true, true)).toEqual([{ x: 10, y: 0, hIn: { x: -3.03, y: 0 }, hOut: { x: 3, y: 0 } }]);
  });
  it("moves and removes a bend", () => {
    const two = [{ x: 5, y: 10 }, { x: 15, y: 10 }];
    expect(moveBend(two, 1, { x: 16.123, y: 9 })).toEqual([two[0], { x: 16.12, y: 9 }]);
    expect(removeBend(two, 0)).toEqual([two[1]]);
  });

  it("measures distance, fraction and points along the bent length", () => {
    const poly = legPolyline(A, [{ x: 10, y: 10 }], { x: 20, y: 0 });
    const half = Math.hypot(10, 10);
    expect(polylineLength(poly)).toBeCloseTo(2 * half);
    expect(polylineDistance(poly, { x: 10, y: 12 })).toBeCloseTo(2);
    expect(polylineDistance([A], { x: 1, y: 1 })).toBe(Infinity);
    expect(polylineFraction(poly, { x: 10, y: 10 })).toBeCloseTo(0.5);
    expect(polylineFraction(poly, { x: 5, y: 5 })).toBeCloseTo(0.25);
    expect(pointAtFraction(poly, 0.75)).toEqual({ x: 15, y: 5 });
    expect(pointAtFraction(poly, 1)).toEqual({ x: 20, y: 0 });
    expect(polylineSlice(poly, 0.25, 0.75)).toEqual([{ x: 5, y: 5 }, { x: 10, y: 10 }, { x: 15, y: 5 }]);
    expect(polylineSlice(poly, 0.1, 0.2)).toHaveLength(2);
  });
});

describe("curved bends (course-layer.md §10.1, F13)", () => {
  // A quarter circle of radius 20 about the origin between straight ends: (30,0) → (20,0) ⌒ (0,20) → (0,30).
  const K = 0.5522847498 * 20;
  const QA = { x: 30, y: 0 }, QB = { x: 0, y: 30 };
  const QUARTER = [{ x: 20, y: 0, hOut: { x: 0, y: K } }, { x: 0, y: 20, hIn: { x: K, y: 0 } }];

  it("the leg is the layer's flattened polyline, anchors kept", () => {
    const poly = legPolyline(QA, QUARTER, QB);
    expect(poly.length).toBeGreaterThan(10);
    expect(poly).toContainEqual({ x: 20, y: 0 });
    expect(polylineLength(poly)).toBeCloseTo(20 + 10 * Math.PI, 1);
    // Half way is on the arc, not on the chord.
    const mid = pointAtFraction(poly, 0.5);
    expect(Math.hypot(mid.x, mid.y)).toBeCloseTo(20, 2);
  });

  it("Add bend here on the curve splits it (de Casteljau): the shape kept, the neighbours' facing handles shortened", () => {
    const apex = { x: 20 * Math.SQRT1_2, y: 20 * Math.SQRT1_2 };
    const before = legPolyline(QA, QUARTER, QB);
    const { bends, index } = insertBendAt(QA, QUARTER, QB, apex);
    expect(index).toBe(1);
    expect(bends).toHaveLength(3);
    expect(bends[1]).toMatchObject({ x: 14.14, y: 14.14 });
    expect(bends[1].hIn).toBeDefined();
    expect(bends[1].hOut).toBeDefined();
    expect(Math.hypot(bends[0].hOut!.x, bends[0].hOut!.y)).toBeCloseTo(K / 2, 1);
    expect(bends[0].hIn).toBeUndefined();
    // The halves trace the arc (within the 0.01 mm rounding).
    for (const p of legPolyline(QA, bends, QB)) expect(polylineDistance(before, p)).toBeLessThan(0.02);
    // Alt: the new bend a corner, its neighbours' split handles kept.
    const corner = insertBendAt(QA, QUARTER, QB, apex, true).bends;
    expect(corner[1]).toEqual({ x: 14.14, y: 14.14 });
    expect(corner[0].hOut).toEqual(bends[0].hOut);
    // On the straight first segment: smooth from its neighbours (the site and the first bend), the curve untouched.
    const straight = insertBendAt(QA, QUARTER, QB, { x: 25, y: 1 });
    expect(straight.index).toBe(0);
    expect(straight.bends[0]).toEqual({ x: 25, y: 0, hIn: { x: 1.67, y: 0 }, hOut: { x: -1.67, y: 0 } });
    expect(straight.bends.slice(1)).toEqual(QUARTER);
  });

  it("moving a bend moves its handles with it; removing keeps the others'", () => {
    expect(moveBend(QUARTER, 0, { x: 21, y: 1 })).toEqual([{ x: 21, y: 1, hOut: { x: 0, y: K } }, QUARTER[1]]);
    expect(removeBend(QUARTER, 0)).toEqual([QUARTER[1]]);
  });
});
