import { describe, it, expect } from "vitest";
import { insertBendAt, legPolyline, moveBend, pointAtFraction, polylineDistance, polylineFraction, polylineLength, polylineSlice, removeBend } from "../bends";

const A = { x: 0, y: 0 }, B = { x: 20, y: 0 };

describe("bends (docs/course-editor.md §6.7)", () => {
  it("the leg is [from, ...bends, to]", () => {
    expect(legPolyline(A, undefined, B)).toEqual([A, B]);
    expect(legPolyline(A, [{ x: 10, y: 10 }], B)).toEqual([A, { x: 10, y: 10 }, B]);
  });

  it("adds a bend on the nearest segment, keeping the corner order", () => {
    expect(insertBendAt(A, [], B, { x: 10, y: 1 })).toEqual([{ x: 10, y: 1 }]);
    const two = [{ x: 5, y: 10 }, { x: 15, y: 10 }];
    // Near the first segment A → (5,10): before the first bend.
    expect(insertBendAt(A, two, B, { x: 2, y: 5 })).toEqual([{ x: 2, y: 5 }, ...two]);
    // Near the middle segment.
    expect(insertBendAt(A, two, B, { x: 10, y: 11 })).toEqual([two[0], { x: 10, y: 11 }, two[1]]);
    // Near the last segment (15,10) → B: after the last bend.
    expect(insertBendAt(A, two, B, { x: 18, y: 4 })).toEqual([...two, { x: 18, y: 4 }]);
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

  it("Add bend here on the curve lands between its bends as a corner, the handles kept", () => {
    const apex = { x: 20 * Math.SQRT1_2, y: 20 * Math.SQRT1_2 };
    expect(insertBendAt(QA, QUARTER, QB, apex)).toEqual([QUARTER[0], { x: 14.14, y: 14.14 }, QUARTER[1]]);
    expect(insertBendAt(QA, QUARTER, QB, { x: 25, y: 1 })).toEqual([{ x: 25, y: 1 }, ...QUARTER]);
  });

  it("moving a bend moves its handles with it; removing keeps the others'", () => {
    expect(moveBend(QUARTER, 0, { x: 21, y: 1 })).toEqual([{ x: 21, y: 1, hOut: { x: 0, y: K } }, QUARTER[1]]);
    expect(removeBend(QUARTER, 0)).toEqual([QUARTER[1]]);
  });
});
