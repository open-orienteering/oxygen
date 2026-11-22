/** Leg routes (docs/course-elevation.md §7.1, §7.3). */

import { describe, it, expect } from "vitest";
import { LEG_ROUTE_MAX_POINTS, legPairKey, legRoutePointsSchema, routeLengthMm, routePolyline, routedLegs } from "../leg-routes.js";

const A = { x: 0, y: 0 };
const B = { x: 10, y: 0 };
const C = { x: 10, y: 10 };
const legs = [
  { from: "a", to: "b", points: [A, B] },
  { from: "b", to: "c", points: [B, { x: 12, y: 5 }, C] },
];

describe("leg routes (docs/course-elevation.md §7)", () => {
  it("a leg without a chosen route is its drawn line", () => {
    expect(routedLegs(legs, null)).toEqual([{ points: legs[0].points, routed: false }, { points: legs[1].points, routed: false }]);
    expect(routedLegs(legs, new Map())[0].points).toBe(legs[0].points);
  });

  it("a chosen route replaces the line between the leg's own ends, bends included", () => {
    const chosen = new Map([[legPairKey("b", "c"), [{ x: 5, y: 5 }]]]);
    const out = routedLegs(legs, chosen);
    expect(out[0].routed).toBe(false);
    expect(out[1]).toEqual({ points: [B, { x: 5, y: 5 }, C], routed: true });
  });

  it("a route is directed: the pair run the other way keeps its line", () => {
    const chosen = new Map([[legPairKey("b", "a"), [{ x: 5, y: 5 }]]]);
    expect(routedLegs(legs, chosen)[0].routed).toBe(false);
  });

  it("a pair run twice takes the route both times", () => {
    const twice = [legs[0], { from: "b", to: "a", points: [B, A] }, legs[0]];
    const out = routedLegs(twice, new Map([[legPairKey("a", "b"), [{ x: 5, y: 3 }]]]));
    expect(out.map((l) => l.routed)).toEqual([true, false, true]);
  });

  it("a marked route is its own route; an empty route is none", () => {
    const chosen = new Map([[legPairKey("a", "b"), [{ x: 5, y: 5 }]]]);
    expect(routedLegs([{ ...legs[0], style: "marked_route" }], chosen)[0].routed).toBe(false);
    expect(routedLegs(legs, new Map([[legPairKey("a", "b"), []]]))[0].routed).toBe(false);
  });

  it("the polyline and its length", () => {
    const line = routePolyline(A, [{ x: 0, y: 10 }], C);
    expect(line).toEqual([A, { x: 0, y: 10 }, C]);
    expect(line[0]).not.toBe(A);
    expect(routeLengthMm(line)).toBe(20);
    expect(routeLengthMm([A])).toBe(0);
  });

  it("stored points: at least one finite vertex, nothing else on it, bounded", () => {
    expect(legRoutePointsSchema.safeParse([{ x: 1, y: 2 }]).success).toBe(true);
    expect(legRoutePointsSchema.safeParse([]).success).toBe(false);
    expect(legRoutePointsSchema.safeParse([{ x: Number.NaN, y: 2 }]).success).toBe(false);
    expect(legRoutePointsSchema.safeParse([{ x: 1, y: 2, hIn: { x: 0, y: 0 } }]).success).toBe(false);
    expect(legRoutePointsSchema.safeParse(Array.from({ length: LEG_ROUTE_MAX_POINTS + 1 }, () => A)).success).toBe(false);
  });
});
