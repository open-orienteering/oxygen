/** Corridor geometry (course-layer.md §10.2): insides joined, the band outside them, the edges along edged legs. */

import { describe, expect, it } from "vitest";
import { corridorGeometry, type CorridorGeometry } from "../corridor.js";
import { pointInRings, polylinesCrossRings, ringArea, type FlatRing } from "../../render/geometry.js";
import type { DerivedCourse, DerivedLeg } from "../types.js";
import type { MapPoint } from "../../course-maps/schema.js";
import { legPolylineOf } from "../bends.js";

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
        // Bounds first, and `expect` only on a crossing: curved runs (F13) have rings of thousands of edges.
        if (Math.max(a[0], a[2]) < Math.min(b[0], b[2]) || Math.max(b[0], b[2]) < Math.min(a[0], a[2])) continue;
        if (Math.max(a[1], a[3]) < Math.min(b[1], b[3]) || Math.max(b[1], b[3]) < Math.min(a[1], a[3])) continue;
        if (polylinesCrossRings([a], false, [b])) expect.fail(`ring edges ${i} × ${j} cross`);
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

  describe("curved legs (F13): one ring per run (user answer 2026-11-08)", () => {
    // An arch (0,0) → (20,0) through a smooth bend at (10,8), flattened at 5 µm: about 40 vertices.
    const ARCH = legPolylineOf(P(0, 0), [{ x: 10, y: 8, hIn: { x: -5, y: 0 }, hOut: { x: 5, y: 0 } }], P(20, 0));

    it("a corridor on a curve: inside along the arc, the band beyond it, the edge along it, simple rings", () => {
      expect(ARCH.length).toBeGreaterThan(20);
      const g = corridorGeometry([course("c", [ARCH], [C(4, 3, true)])])!;
      // On the arc's apex (10, 8): inside; 2.5 mm above it in the band; 5.5 mm above it the map.
      expect(inInside(g, 10, 8)).toBe(true);
      expect(inInside(g, 10, 6.2)).toBe(true);
      expect(inBand(g, 10, 10.5)).toBe(true);
      expect(inBand(g, 10, 13.5)).toBe(false);
      // The chord's midpoint lies outside the corridor: in the band below the arc (8 mm from the apex, ≥ 2 mm from the arc).
      expect(inInside(g, 10, 0)).toBe(false);
      expectSimple(g.inside);
      expectSimple(g.band!);
      expect(g.inside).toHaveLength(1);
      // The edge runs round the inside; every edge point 2 mm from the arc within the tolerance.
      expect(g.edges.length).toBeGreaterThan(0);
      for (const e of g.edges) for (const q of e.points) expect(Math.abs(distTo(ARCH, q.x / 1000, q.y / 1000) - 2)).toBeLessThan(0.02);
    });

    it("the buffer is the round-joined one within 5 µm: boundary points at half the width from the leg", () => {
      const g = corridorGeometry([course("c", [ARCH], [C(4, 3)])])!;
      for (const r of g.inside) for (let i = 0; i < r.length; i += 2) expect(Math.abs(distTo(ARCH, r[i] / 1000, r[i + 1] / 1000) - 2)).toBeLessThan(0.006);
    });

    it("a curve tighter than the half width stays one simple ring", () => {
      const tight = legPolylineOf(P(0, 0), [{ x: 2, y: 3, hIn: { x: -1, y: 0 }, hOut: { x: 1, y: 0 } }], P(4, 0));
      const g = corridorGeometry([course("c", [tight], [C(6, 3)])])!;
      expect(g.inside).toHaveLength(1);
      expectSimple(g.inside);
      expectSimple(g.band!);
      expect(inInside(g, 2, 1.5)).toBe(true);
    });

    const archLegs = (n: number): MapPoint[][] => Array.from({ length: n }, (_, i) => {
      const a = P(i * 20, (i % 2) * 10), b = P((i + 1) * 20, ((i + 1) % 2) * 10);
      return legPolylineOf(a, [{ x: a.x + 10, y: 15, hIn: { x: -6, y: 0 }, hOut: { x: 6, y: 0 } }], b);
    });

    it("a run of curved legs joined across a narrower course on the same legs: simple rings", () => {
      const legs = archLegs(3);
      const g = corridorGeometry([course("a", legs, legs.map(() => C(6, 3, true))), course("b", legs.slice(0, 2), [C(4, 2), C(4, 2)])])!;
      expect(g.inside).toHaveLength(1);
      expectSimple(g.inside);
      expectSimple(g.band!);
      expect(inInside(g, 10, 15)).toBe(true);
    });

    it("thirty curved legs (about 2 600 vertices) in well under a second, not the crash of a piece per segment", () => {
      // F13 measured: F2's rectangle-per-segment union crashed polygon-clipping here; one ring per run takes ~0.4 s.
      const legs = archLegs(30);
      const t0 = performance.now();
      const g = corridorGeometry([course("a", legs, legs.map(() => C(6, 3, true))), course("b", legs.slice(0, 10), legs.slice(0, 10).map(() => C(4, 2)))])!;
      expect(performance.now() - t0).toBeLessThan(3000);
      expect(g.inside).toHaveLength(1);
      expect(g.band!.length).toBeGreaterThan(1);
      for (let i = 0; i < 30; i++) expect(inInside(g, i * 20 + 10, 15)).toBe(true);
      expect(inBand(g, 310, 15 + 3 + 1.5)).toBe(true);
      expect(g.edges.length).toBeGreaterThan(0);
    });
  });
});

function distTo(pts: readonly MapPoint[], x: number, y: number): number {
  let best = Infinity;
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i], b = pts[i + 1];
    const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
    const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / l2));
    best = Math.min(best, Math.hypot(x - (a.x + dx * t), y - (a.y + dy * t)));
  }
  return best;
}
