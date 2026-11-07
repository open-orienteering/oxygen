/** Corridor geometry (course-layer.md §10.2): insides joined, the band outside them, the edges along edged legs. */

import { describe, expect, it } from "vitest";
import { corridorGeometry, type CorridorGeometry } from "../corridor.js";
import { pointInRings, polylinesCrossRings, ringArea, type FlatRing } from "../../render/geometry.js";
import type { DerivedCourse, DerivedLeg } from "../types.js";
import type { MapPoint } from "../../course-maps/schema.js";

type Corridor = NonNullable<DerivedLeg["corridor"]>;
const C = (widthMm: number, whiteMm: number, edge = false): Corridor => ({ widthMm, whiteMm, edge });

/** A course whose legs run through `pts` in order; `corridors[i]` is leg i's (undefined = none). */
function course(id: string, pts: MapPoint[][], corridors: (Corridor | undefined)[]): DerivedCourse {
  const legs: DerivedLeg[] = pts.map((points, i) => ({
    from: `${i}`, to: `${i + 1}`, points, style: "line", gaps: [], pieces: [points],
    ...(corridors[i] ? { corridor: corridors[i] } : {}),
  }));
  return { id, orderMode: "ordered", sequence: [], legs };
}
const P = (x: number, y: number): MapPoint => ({ x, y });

/** Point probes in mm against the µm rings. */
const inBand = (g: CorridorGeometry, x: number, y: number) => !!g.band && pointInRings(g.band, x * 1000, y * 1000);
const inInside = (g: CorridorGeometry, x: number, y: number) => pointInRings(g.inside, x * 1000, y * 1000);

/** Every ring simple: a non-zero area and no two non-adjacent edges crossing. */
function expectSimple(rings: FlatRing[]) {
  for (const r of rings) {
    expect(Math.abs(ringArea(r))).toBeGreaterThan(0);
    const n = r.length / 2;
    for (let i = 0; i < n; i++) {
      for (let j = i + 2; j < n; j++) {
        if (i === 0 && j === n - 1) continue;
        const a = [r[2 * i], r[2 * i + 1], r[(2 * i + 2) % r.length], r[(2 * i + 3) % r.length]];
        const b = [r[2 * j], r[2 * j + 1], r[(2 * j + 2) % r.length], r[(2 * j + 3) % r.length]];
        // Shared endpoints (a pinch at integer µm) are touching, not crossing: only proper crossings count.
        if (a[2] === b[0] && a[3] === b[1]) continue;
        if (b[2] === a[0] && b[3] === a[1]) continue;
        expect(polylinesCrossRings([a], false, [b]), `ring edges ${i} × ${j} cross`).toBe(false);
      }
    }
  }
}

describe("corridorGeometry", () => {
  it("is null without a corridor", () => {
    expect(corridorGeometry([course("c", [[P(0, 0), P(20, 0)]], [undefined])])).toBeNull();
  });

  it("a straight leg: the map inside, white for whiteMm outside the edge, the map again beyond; round ends", () => {
    const g = corridorGeometry([course("c", [[P(0, 0), P(20, 0)]], [C(4, 3)])])!;
    // Edge at y = ±2, band to ±5.
    expect(inInside(g, 10, 1.5)).toBe(true);
    expect(inBand(g, 10, 1.5)).toBe(false);
    expect(inBand(g, 10, 2.5)).toBe(true);
    expect(inBand(g, 10, -4.5)).toBe(true);
    expect(inBand(g, 10, 5.5)).toBe(false);
    // Round end: inside the disc at the site, in the band beyond its rim along the leg's axis.
    expect(inInside(g, -1.9, 0)).toBe(true);
    expect(inBand(g, -2.5, 0)).toBe(true);
    expect(inBand(g, -1.5, 1.5)).toBe(true);
    expectSimple(g.band!);
    expectSimple(g.inside);
  });

  it("a bend: no notch on its inner side, a round join outside", () => {
    // An L: (0,0) → (20,0) → (20,20).
    const g = corridorGeometry([course("c", [[P(0, 0), P(20, 0), P(20, 20)]], [C(4, 3)])])!;
    // The inner corner at (18, 2) is inside both pieces' edges: map, not band.
    expect(inInside(g, 18.5, 1.5)).toBe(true);
    expect(inBand(g, 18.5, 1.5)).toBe(false);
    // Outside the corner, round: (21.5, -1.5) is 2.1 mm from the bend → band; (23.6, -3.6) is 5.1 mm → map.
    expect(inBand(g, 21.5, -1.5)).toBe(true);
    expect(inBand(g, 23.6, -3.6)).toBe(false);
    expect(g.band).toHaveLength(2);
    expectSimple(g.band!);
  });

  it("consecutive corridors join: nothing of one's band inside the next, the site inside", () => {
    const g = corridorGeometry([course("c", [[P(0, 0), P(20, 0)], [P(20, 0), P(20, 20)]], [C(4, 3), C(4, 3)])])!;
    // (21, 3) is inside leg 2's corridor and within leg 1's band distance of the site.
    expect(inInside(g, 21, 3)).toBe(true);
    expect(inBand(g, 21, 3)).toBe(false);
    expect(inInside(g, 20, 0)).toBe(true);
    expectSimple(g.band!);
  });

  it("joins mixed widths at a site and across courses", () => {
    const a = course("a", [[P(0, 0), P(20, 0)], [P(20, 0), P(40, 0)]], [C(2, 3), C(8, 1)]);
    const b = course("b", [[P(10, -10), P(10, 10)]], [C(2, 3)]);
    const g = corridorGeometry([a, b])!;
    // The wide leg's inside reaches 4 mm, past the narrow one's band at the site.
    expect(inInside(g, 22, 3.5)).toBe(true);
    expect(inBand(g, 22, 3.5)).toBe(false);
    // The crossing of the two courses is clear in both directions.
    expect(inBand(g, 10, 0.5)).toBe(false);
    expect(inBand(g, 10.5, 0)).toBe(false);
    expect(inBand(g, 12, 1.5)).toBe(true);
    expectSimple(g.band!);
  });

  it("degenerate inputs stay simple: a leg out and back, collinear legs, the same leg on two courses", () => {
    const back = course("r", [[P(0, 0), P(20, 0)], [P(20, 0), P(0, 0)]], [C(4, 2), C(4, 2)]);
    const line = course("l", [[P(0, 30), P(10, 30)], [P(10, 30), P(20, 30)], [P(20, 30), P(30, 30, )]], [C(4, 2), C(4, 2), C(4, 2)]);
    const twice = [course("x", [[P(0, 60), P(20, 64)]], [C(4, 2)]), course("y", [[P(0, 60), P(20, 64)]], [C(4, 2)])];
    for (const g of [corridorGeometry([back])!, corridorGeometry([line])!, corridorGeometry(twice)!]) {
      expect(g.band!.length).toBeGreaterThan(0);
      expectSimple(g.band!);
      expectSimple(g.inside);
    }
    // Collinear legs are one straight corridor: one outer ring, one hole.
    expect(corridorGeometry([line])!.band).toHaveLength(2);
  });

  it("whiteMm 0 has no band; a leg without a corridor adds nothing", () => {
    const g = corridorGeometry([course("c", [[P(0, 0), P(20, 0)], [P(20, 0), P(40, 0)]], [C(4, 0), undefined])])!;
    expect(g.band).toBeNull();
    expect(inInside(g, 10, 0)).toBe(true);
    expect(inInside(g, 30, 0)).toBe(false);
  });

  it("edges: the inside's boundary along the edged legs only, as polylines in µm", () => {
    const g = corridorGeometry([course("c", [[P(0, 0), P(20, 0)], [P(20, 0), P(20, 20)]], [C(4, 3, true), C(4, 3)])])!;
    expect(g.edges.length).toBeGreaterThan(0);
    expect(g.edges.every((e) => e.ref === "c:0")).toBe(true);
    const pts = g.edges.flatMap((e) => e.points);
    // On the edge: 2 mm from leg 1's centre line.
    for (const p of pts) {
      const d = p.x <= 20000 ? Math.hypot(p.x - Math.max(0, Math.min(20000, p.x)), p.y) : Math.hypot(p.x - 20000, p.y);
      expect(Math.abs(d - 2000)).toBeLessThan(30);
    }
    // Nothing along leg 2's sides, not even the first fraction of a mm past the join (its round end belongs to both).
    expect(pts.every((p) => p.x <= 20001)).toBe(true);
    expect(pts.some((p) => Math.abs(p.x - 20000) <= 2 && Math.abs(p.y + 2000) <= 2)).toBe(true);
    // An edged lone leg is one closed outline.
    const lone = corridorGeometry([course("c", [[P(0, 0), P(20, 0)]], [C(4, 3, true)])])!;
    expect(lone.edges).toHaveLength(1);
    expect(lone.edges[0].closed).toBe(true);
    // A separate unedged corridor (another course) has no edge.
    const two = corridorGeometry([course("c", [[P(0, 0), P(20, 0)]], [C(4, 3, true)]), course("d", [[P(0, 30), P(20, 30)]], [C(4, 3)])])!;
    expect(two.edges).toHaveLength(1);
    expect(two.edges[0].points.every((p) => p.y < 10000)).toBe(true);
  });
});
