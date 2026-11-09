/** Corridor geometry (course-layer.md §10.2): insides joined, the band outside them, the edges along edged legs. */

import { describe, expect, it } from "vitest";
import { corridorGeometry, TERMINAL_END, type CorridorGeometry, type CorridorMouths, type CorridorSite } from "../corridor.js";
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
/** The band's end before F22: a lone leg's ends wrapped round (the tests of F2–F19's join). */
const ROUND = { terminalEnd: "round" } as const;

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

  it("a straight leg: the map inside, white for whiteMm outside the edge, the map again beyond; round ends (before F22)", () => {
    const g = corridorGeometry([course("c", [[P(0, 0), P(20, 0)]], [C(4, 3)])], undefined, ROUND)!;
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
      // One ring: the band stops at course a's last site (F22), so it no longer closes round the inside.
      expect(g.band).toHaveLength(1);
      for (let i = 0; i < 30; i++) expect(inInside(g, i * 20 + 10, 15)).toBe(true);
      expect(inBand(g, 310, 15 + 3 + 1.5)).toBe(true);
      expect(g.edges.length).toBeGreaterThan(0);
    });
  });
});

/** ISOM 1:15 000 extents (course-layer.md §3.1): 703 R 2.5 mm, 706 outer ring 3.0 mm, 701 circumradius 6 / √3 mm. */
const EXTENTS = { circleUm: 2500, finishUm: 3000, startUm: 6000 / Math.sqrt(3) };
/** Sites "0", "1", … at the legs' ends (the course helper's ids), each a control unless `roles` says otherwise; `extra` appended. */
function mouths(pts: MapPoint[][], roles: Record<string, CorridorSite["role"]> = {}, extra: CorridorSite[] = [], angles: Record<string, number> = {}): CorridorMouths {
  const at = [pts[0][0], ...pts.map((p) => p[p.length - 1])];
  const sites: CorridorSite[] = at.map((p, i) => ({ id: `${i}`, role: roles[`${i}`] ?? "control", x: p.x, y: p.y, ...(angles[`${i}`] !== undefined ? { angleDeg: angles[`${i}`] } : {}) }));
  return { sites: [...sites, ...extra], ...EXTENTS };
}
/** Distance from (x, y) µm to the nearest edge of `rings`, µm. */
function toBoundary(rings: FlatRing[], x: number, y: number): number {
  let best = Infinity;
  for (const r of rings) {
    const n = r.length / 2;
    for (let i = 0; i < n; i++) {
      const ax = r[2 * i], ay = r[2 * i + 1], bx = r[(2 * i + 2) % r.length], by = r[(2 * i + 3) % r.length];
      const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
      const t = l2 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2)) : 0;
      best = Math.min(best, Math.hypot(x - ax - t * dx, y - ay - t * dy));
    }
  }
  return best;
}
/** asin(2 / 2.5) in degrees: the half angle of a 4 mm corridor's opening in a 2.5 mm circle. */
const DELTA = (Math.asin(2 / 2.5) * 180) / Math.PI;

describe("mouths and openings (F19, course-layer.md §10.2)", () => {
  const LEG = [[P(0, 0), P(20, 0)]];

  it("a narrow corridor's end at a control: the disc joins the inside, the band wraps it at R + whiteMm (before F22)", () => {
    const plain = corridorGeometry([course("c", LEG, [C(4, 3)])], undefined, ROUND)!;
    const g = corridorGeometry([course("c", LEG, [C(4, 3)])], mouths(LEG), ROUND)!;
    // Past the round end (radius 2) but within R = 2.5: band before F19, the map now.
    expect(inInside(plain, 22.4, 0)).toBe(false);
    expect(inInside(g, 22.4, 0)).toBe(true);
    expect(inInside(g, 20, 2.4)).toBe(true);
    expect(inBand(g, 22.4, 0)).toBe(false);
    // The band from R to R + 3 = 5.5 round the circle.
    expect(inBand(g, 25.4, 0)).toBe(true);
    expect(inBand(g, 25.6, 0)).toBe(false);
    expect(inBand(g, 20, -5.4)).toBe(true);
    expectSimple(g.inside);
    expectSimple(g.band!);
  });

  it("h ≥ R keeps today's geometry: the rings equal the call without mouths, nothing opens (answer 1)", () => {
    const plain = corridorGeometry([course("c", LEG, [C(8, 3, true)])])!;
    const g = corridorGeometry([course("c", LEG, [C(8, 3, true)])], mouths(LEG))!;
    expect(g.inside).toEqual(plain.inside);
    expect(g.band).toEqual(plain.band);
    expect(g.edges).toEqual(plain.edges);
    expect(g.edges).toHaveLength(1);
    expect(g.edges[0].closed).toBe(true);
    expect(g.openings.size).toBe(0);
    expect(plain.openings.size).toBe(0);
  });

  it("a finish: its outer ring's disc and the band beyond it; never opened (answer 2; before F22)", () => {
    const g = corridorGeometry([course("c", LEG, [C(4, 3, true)])], mouths(LEG, { "1": "finish" }), ROUND)!;
    expect(inInside(g, 22.9, 0)).toBe(true);
    expect(inBand(g, 23.1, 0)).toBe(true);
    expect(inBand(g, 25.9, 0)).toBe(true);
    expect(inBand(g, 26.1, 0)).toBe(false);
    expect(g.openings.has("1")).toBe(false);
    expect(g.openings.has("0")).toBe(true);
  });

  it("a start: the 701 triangle turned by angleDeg joins the inside; never opened (answer 2)", () => {
    // Apex towards the leg (+x): angleDeg −90; the corners at 120° and 240° round the centroid.
    const g = corridorGeometry([course("c", LEG, [C(4, 3, true)])], mouths(LEG, { "0": "start" }, [], { "0": -90 }))!;
    const plain = corridorGeometry([course("c", LEG, [C(4, 3, true)])])!;
    // Near the back corner (−1.73, 3): inside the triangle, 2.9 mm from the site (beyond the round end).
    expect(inInside(plain, -1.5, 2.5)).toBe(false);
    expect(inInside(g, -1.5, 2.5)).toBe(true);
    // Unturned (north apex), the same point is outside the triangle.
    const north = corridorGeometry([course("c", LEG, [C(4, 3, true)])], mouths(LEG, { "0": "start" }))!;
    expect(inInside(north, -1.5, 2.5)).toBe(false);
    expect(inInside(north, 0, 3.3)).toBe(true);
    expect(g.openings.has("0")).toBe(false);
    expectSimple(g.inside);
    expectSimple(g.band!);
  });

  it("a control the corridor passes but does not end at is no mouth", () => {
    const g = corridorGeometry([course("c", LEG, [C(4, 3, true)])], mouths(LEG, {}, [{ id: "p", role: "control", x: 10, y: 3 }]))!;
    expect(inBand(g, 10, 4.5)).toBe(true);
    expect(inInside(g, 10, 4.5)).toBe(false);
    expect(g.openings.has("p")).toBe(false);
  });

  it("edge: false: the mouth applies, nothing opens and no edge (answer 3)", () => {
    const g = corridorGeometry([course("c", LEG, [C(4, 3)])], mouths(LEG))!;
    expect(inInside(g, 22.4, 0)).toBe(true);
    expect(g.openings.size).toBe(0);
    expect(g.edges).toEqual([]);
  });

  it("two legs meeting at a control: the band round it is R + the larger whiteMm", () => {
    const legs = [[P(0, 0), P(20, 0)], [P(20, 0), P(20, 20)]];
    const g = corridorGeometry([course("c", legs, [C(4, 2), C(4, 4)])], mouths(legs))!;
    expect(inBand(g, 26.4, 0)).toBe(true);
    expect(inBand(g, 26.6, 0)).toBe(false);
    expect(inBand(g, 20, -6.4)).toBe(true);
    expectSimple(g.band!);
  });

  it("the edge ends where the straight sides meet the circles: two open pieces, none on the arcs", () => {
    const g = corridorGeometry([course("c", LEG, [C(4, 3, true)])], mouths(LEG))!;
    expect(g.edges).toHaveLength(2);
    // √(2.5² − 2²) = 1.5 mm along the leg from each centre.
    const junctions = [[1500, 2000], [1500, -2000], [18500, 2000], [18500, -2000]];
    for (const e of g.edges) {
      expect(e.closed).toBe(false);
      for (const p of e.points) {
        expect(Math.abs(Math.abs(p.y) - 2000)).toBeLessThan(30);
        expect(p.x).toBeGreaterThan(1470);
        expect(p.x).toBeLessThan(18530);
      }
      for (const end of [e.points[0], e.points[e.points.length - 1]]) {
        expect(Math.min(...junctions.map(([x, y]) => Math.hypot(end.x - x, end.y - y)))).toBeLessThan(30);
      }
    }
  });

  it("the edge stops at a start's triangle: no piece behind it from the round end", () => {
    const g = corridorGeometry([course("c", LEG, [C(4, 3, true)])], mouths(LEG, { "0": "start" }, [], { "0": -90 }))!;
    expect(g.edges.length).toBeGreaterThan(0);
    for (const e of g.edges) for (const p of e.points) expect(p.x).toBeGreaterThan(-30);
    // The run ends flat at the 701: nothing of its round end bulges past the base (x = −1.73).
    expect(inInside(g, -1.85, 0)).toBe(false);
    expect(inBand(g, -1.85, 0)).toBe(true);
  });

  it("a corridor wider than the 701 at its centroid: the sides run back to the triangle, no notch", () => {
    // h 2.6 > the triangle's half width 2.0 at the centroid: the sides meet its sides at x ≈ −0.87.
    const g = corridorGeometry([course("c", LEG, [C(5.2, 3, true)])], mouths(LEG, { "0": "start" }, [], { "0": -90 }))!;
    expect(inInside(g, -0.1, 2.4)).toBe(true);
    expect(inInside(g, -0.1, -2.4)).toBe(true);
    const r = 6000 / Math.sqrt(3);
    const corners = [[r, 0], [-r / 2, 3000], [-r / 2, -3000]];
    const onTriangle = (p: { x: number; y: number }) => Math.min(...[0, 1, 2].map((i) => {
      const [ax, ay] = corners[i], [bx, by] = corners[(i + 1) % 3];
      const dx = bx - ax, dy = by - ay, t = Math.max(0, Math.min(1, ((p.x - ax) * dx + (p.y - ay) * dy) / (dx * dx + dy * dy)));
      return Math.hypot(p.x - ax - t * dx, p.y - ay - t * dy);
    }));
    const nearStart = g.edges.flatMap((e) => [e.points[0], e.points[e.points.length - 1]]).filter((p) => p.x < 5000);
    expect(nearStart).toHaveLength(2);
    for (const p of nearStart) expect(onTriangle(p)).toBeLessThan(30);
    expectSimple(g.inside);
    expectSimple(g.band!);
  });

  it("openings: θ ± asin(h/R) at each edged end, compass degrees; the junctions on the inside's boundary", () => {
    const g = corridorGeometry([course("c", LEG, [C(4, 3, true)])], mouths(LEG))!;
    // From 0 the leg runs east (compass 90), from 1 west (270).
    const [a] = g.openings.get("0")!, [b] = g.openings.get("1")!;
    expect(a.start).toBeCloseTo(90 - DELTA, 2);
    expect(a.end).toBeCloseTo(90 + DELTA, 2);
    expect(b.start).toBeCloseTo(270 - DELTA, 2);
    expect(b.end).toBeCloseTo(270 + DELTA, 2);
    for (const [x, y] of [[1500, 2000], [1500, -2000], [18500, 2000], [18500, -2000]]) expect(toBoundary(g.inside, x, y)).toBeLessThan(20);
  });

  it("a turn at a control: each leg opens its sector, together the inner corner (one junction on the boundary is enough)", () => {
    const legs = [[P(0, 0), P(20, 0)], [P(20, 0), P(20, 20)]];
    const g = corridorGeometry([course("c", legs, [C(4, 3, true), C(4, 3, true)])], mouths(legs))!;
    const gaps = g.openings.get("1")!;
    expect(gaps).toHaveLength(2);
    expect(gaps.map((x) => Math.round(x.start + DELTA) % 360)).toEqual([270, 0]);
    // A straight run through a control opens both sides.
    const line = [[P(0, 0), P(20, 0)], [P(20, 0), P(40, 0)]];
    const s = corridorGeometry([course("c", line, [C(4, 3, true), C(4, 3, true)])], mouths(line))!;
    expect(s.openings.get("1")!.map((x) => Math.round(x.start + DELTA) % 360)).toEqual([270, 90]);
  });

  it("no opening where a wider corridor covers both junctions", () => {
    const legs = [[P(0, 0), P(20, 0)], [P(20, 0), P(20, 20)]];
    const g = corridorGeometry([course("c", legs, [C(4, 3, true), C(10, 2)])], mouths(legs))!;
    expect(g.openings.has("1")).toBe(false);
    expect(g.openings.has("0")).toBe(true);
  });

  /** Each opening's two ends on the circle (compass → math), µm. */
  const openingEnds = (g: CorridorGeometry, id: string, c: MapPoint) => g.openings.get(id)!.flatMap((x) => [x.start, x.end]).map((deg) => {
    const a = ((90 - deg) * Math.PI) / 180;
    return { x: c.x * 1000 + 2500 * Math.cos(a), y: c.y * 1000 + 2500 * Math.sin(a) };
  });

  it("a curved leg (F13 / F16 smooth bend): both circles open where its sides cross them, the junctions on the boundary", () => {
    // 40 mm with a smooth bend 6 mm off the chord: flattened at 5 µm, the end segments are a fraction of √(R² − h²).
    const curve = legPolylineOf(P(0, 0), [{ x: 20, y: 6, hIn: { x: -40 / 6, y: 0 }, hOut: { x: 40 / 6, y: 0 } }], P(40, 0));
    expect(Math.hypot(curve[1].x - curve[0].x, curve[1].y - curve[0].y)).toBeLessThan(1.5);
    const legs = [curve];
    const g = corridorGeometry([course("c", legs, [C(4, 3, true)])], mouths(legs))!;
    for (const [id, c] of [["0", P(0, 0)], ["1", P(40, 0)]] as const) {
      const [gap] = g.openings.get(id)!;
      // Nearly straight within the circle: the opening about 2 asin(h / R) wide.
      expect(gap.end - gap.start).toBeGreaterThan(2 * DELTA - 3);
      expect(gap.end - gap.start).toBeLessThan(2 * DELTA + 3);
      for (const j of openingEnds(g, id, c)) expect(toBoundary(g.inside, j.x, j.y)).toBeLessThan(20);
    }
    // The edge ends on the circles: every edge end within 30 µm of an opening's end.
    const js = [...openingEnds(g, "0", P(0, 0)), ...openingEnds(g, "1", P(40, 0))];
    for (const e of g.edges) for (const p of [e.points[0], e.points[e.points.length - 1]]) {
      expect(Math.min(...js.map((j) => Math.hypot(p.x - j.x, p.y - j.y)))).toBeLessThan(30);
    }
  });

  it("a bend inside the circle: the opening is where the corridor actually crosses it", () => {
    const bent = [[P(0, 0), P(19, 1), P(20, 0)]];
    const b = corridorGeometry([course("c", bent, [C(4, 3, true)])], mouths(bent))!;
    expect(b.openings.get("1")!.length).toBeGreaterThan(0);
    for (const j of openingEnds(b, "1", P(20, 0))) expect(toBoundary(b.inside, j.x, j.y)).toBeLessThan(20);
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

describe("the last call's result is kept (F20b, course-layer.md §10.2)", () => {
  const LEGS = [[P(0, 0), P(20, 0)], [P(20, 0), P(30, 10), P(40, 0)]];
  const base = () => [course("c", LEGS, [C(4, 3, true), C(4, 3, true)])];

  it("the same input again: the same object, without recomputing", () => {
    const a = corridorGeometry(base(), mouths(LEGS))!;
    expect(corridorGeometry(base(), mouths(LEGS))).toBe(a);
  });

  it("a change to anything the geometry reads recomputes it, and the result is a fresh call's", () => {
    const m = mouths(LEGS);
    const variants: [string, () => [DerivedCourse[], CorridorMouths | undefined]][] = [
      ["a point moved", () => [[course("c", [LEGS[0], [P(20, 0), P(30, 10.001), P(40, 0)]], [C(4, 3, true), C(4, 3, true)])], m]],
      ["a width", () => [[course("c", LEGS, [C(4, 3, true), C(4.5, 3, true)])], m]],
      ["a band", () => [[course("c", LEGS, [C(4, 3, true), C(4, 2, true)])], m]],
      ["the edge", () => [[course("c", LEGS, [C(4, 3, true), C(4, 3, false)])], m]],
      ["the course id (the edges' refs)", () => [[course("d", LEGS, [C(4, 3, true), C(4, 3, true)])], m]],
      ["a leg's index (a leg without a corridor before it)", () => [[course("c", [[P(-10, 0), P(0, 0)], ...LEGS], [undefined, C(4, 3, true), C(4, 3, true)])], m]],
      ["no mouths", () => [base(), undefined]],
      ["a mouth site moved", () => [base(), { ...m, sites: m.sites.map((s) => (s.id === "1" ? { ...s, x: 20.5 } : s)) }]],
      ["a mouth site's role", () => [base(), { ...m, sites: m.sites.map((s) => (s.id === "0" ? { ...s, role: "start" as const } : s)) }]],
      ["a start's turn", () => [base(), mouths(LEGS, { "0": "start" }, [], { "0": 30 })]],
      ["an extent", () => [base(), { ...m, circleUm: 3000 }]],
    ];
    for (const [name, make] of variants) {
      const a = corridorGeometry(base(), m);
      const [courses, mo] = make();
      const b = corridorGeometry(courses, mo);
      expect(b, name).not.toBe(a);
      corridorGeometry([course("x", [[P(0, 0), P(1, 0)]], [C(1, 0)])]);
      expect(corridorGeometry(courses, mo), name).toEqual(b);
    }
  });

  it("a -0 is not a 0 (the rings keep the sign)", () => {
    const a = corridorGeometry([course("c", [[P(0, 0), P(20, 0)]], [C(4, 3)])]);
    expect(corridorGeometry([course("c", [[P(-0, 0), P(20, 0)]], [C(4, 3)])])).not.toBe(a);
  });

  it("sites no corridor leg ends at do not count: moving one keeps the result", () => {
    const m = mouths(LEGS, {}, [{ id: "far", role: "control", x: 100, y: 100 }]);
    const a = corridorGeometry(base(), m);
    expect(corridorGeometry(base(), { ...m, sites: m.sites.map((s) => (s.id === "far" ? { ...s, x: 101 } : s)) })).toBe(a);
  });
});

describe("terminal ends (F22, course-layer.md §10.2 \"Ends\")", () => {
  const LEG = [[P(0, 0), P(20, 0)]];
  /** A leg between named sites (a revisit reuses its site's id). */
  const legOf = (from: string, to: string, points: MapPoint[], corridor: Corridor): DerivedLeg => ({ from, to, points, style: "line", gaps: [], pieces: [points], corridor });
  const courseOf = (id: string, legs: DerivedLeg[]): DerivedCourse => ({ id, orderMode: "ordered", sequence: [], legs });
  const sitesAt = (at: Record<string, MapPoint>, roles: Record<string, CorridorSite["role"]> = {}): CorridorMouths => ({
    sites: Object.entries(at).map(([id, p]) => ({ id, role: roles[id] ?? "control", x: p.x, y: p.y })), ...EXTENTS,
  });
  /** Band membership on a 0.1 mm grid within `radius` of `c`: equal to the reference's, or a list of the points that differ. */
  const bandDiff = (g: CorridorGeometry, ref: CorridorGeometry, c: MapPoint, radius: number) => {
    const out: string[] = [];
    for (let x = -radius; x <= radius; x += 0.1) for (let y = -radius; y <= radius; y += 0.1) {
      if (Math.hypot(x, y) > radius) continue;
      if (inBand(g, c.x + x, c.y + y) !== inBand(ref, c.x + x, c.y + y)) out.push(`${(c.x + x).toFixed(1)},${(c.y + y).toFixed(1)}`);
    }
    return out;
  };
  /** The inside, the edges and the openings equal the pre-F22 result (answer 3). */
  const expectInsideKept = (g: CorridorGeometry, ref: CorridorGeometry) => {
    expect(g.inside).toEqual(ref.inside);
    expect(g.edges).toEqual(ref.edges);
    expect(g.openings).toEqual(ref.openings);
  };

  it("TERMINAL_END is the flat end, the default", () => {
    expect(TERMINAL_END).toBe("flat");
    const courses = [course("c", LEG, [C(4, 3, true)])];
    expect(corridorGeometry(courses, mouths(LEG), { terminalEnd: TERMINAL_END })).toEqual(corridorGeometry(courses, mouths(LEG)));
  });

  it("a lone leg, h < R: the band stops on the line through each centre, the near half still wrapped; inside, edges and openings kept", () => {
    const courses = [course("c", LEG, [C(4, 3, true)])];
    const g = corridorGeometry(courses, mouths(LEG))!;
    const ref = corridorGeometry(courses, mouths(LEG), ROUND)!;
    expectInsideKept(g, ref);
    // Behind each circle: the map now, the band before (R + w = 5.5 all round).
    for (const [x, y] of [[-3, 0], [-4, 2], [-0.3, 4], [23, 0], [24, -2], [20.3, -4]]) {
      expect(inBand(ref, x, y), `${x},${y} before`).toBe(true);
      expect(inBand(g, x, y), `${x},${y}`).toBe(false);
    }
    // The near half: h + w = 5 reaches past R 2.5, so the band is the run's alone (user, "fix the bump"): to h + w
    // beside the leg, up to the line beside the circle.
    for (const [x, y] of [[2.5, 4], [3, -4.6], [17.5, 4], [17, -4.6], [10, 4.5], [10, -2.5], [0.2, 2.8], [19.8, -2.8]]) expect(inBand(g, x, y), `${x},${y}`).toBe(true);
    // Beyond h + w nothing: no bump of the mouth's grown disc (R + w = 5.5).
    expect(inBand(g, 2.5, 5.2)).toBe(false);
    expect(inBand(g, 4, -5.2)).toBe(false);
    // One corner each side, radius min(w, h + w − R) = 2.5 about (2.5, ±2.5): the face on the line spans ±R.
    const corner = g.band!.flatMap((q) => ringPoints(q)).filter((p) => p.x > 5 && p.x < 2495 && Math.abs(p.y) > 2550);
    expect(corner.length).toBeGreaterThan(5);
    for (const p of corner) expect(Math.abs(Math.hypot(p.x - 2500, Math.abs(p.y) - 2500) - 2500), `${p.x},${p.y}`).toBeLessThan(6);
    expectSimple(g.band!);
    expectSimple(g.inside);
  });

  it("the corners: the run's band is flat on the line, its corners arcs of radius whiteMm (no mouths: R = 0)", () => {
    // h 4 + w 3 = 7: the face from −4 to 4 on x = 0, each corner a quarter circle of radius 3 about (3, ±4).
    const g = corridorGeometry([course("c", LEG, [C(8, 3)])])!;
    expect(inBand(g, -0.2, 5)).toBe(false);
    expect(inBand(g, 0.3, 4.5)).toBe(true);
    expect(inBand(g, 0.3, 6.8)).toBe(false);
    expect(inBand(g, 3.2, 6.8)).toBe(true);
    const corner = g.band!.flatMap((r) => ringPoints(r)).filter((p) => p.x < 3000 && Math.abs(p.y) > 4000);
    expect(corner.length).toBeGreaterThan(5);
    for (const p of corner) expect(Math.abs(Math.hypot(p.x - 3000, Math.abs(p.y) - 4000) - 3000)).toBeLessThan(6);
    // The face on x = 0 between the corners: every band vertex at x < 1 µm lies on it (|y| ≤ 4 mm).
    for (const p of g.band!.flatMap((r) => ringPoints(r)).filter((q) => q.x < 1)) {
      expect(Math.abs(p.x)).toBeLessThanOrEqual(1);
      expect(Math.abs(p.y)).toBeLessThanOrEqual(4001);
    }
    // The other end alike, mirrored.
    expect(inBand(g, 20.2, -5)).toBe(false);
    expect(inBand(g, 19.7, -4.5)).toBe(true);
    expectSimple(g.band!);
  });

  it("h ≥ R: the inside's round end and the edge's closed ring stay, the half circle behind the centre on the map (answer 3)", () => {
    const courses = [course("c", LEG, [C(8, 3, true)])];
    const g = corridorGeometry(courses, mouths(LEG))!;
    const ref = corridorGeometry(courses, mouths(LEG), ROUND)!;
    expectInsideKept(g, ref);
    expect(g.edges).toHaveLength(1);
    expect(g.edges[0].closed).toBe(true);
    // The round end reaches x = −4; the band beyond it before, the map now.
    expect(inInside(g, -3.9, 0)).toBe(true);
    expect(inBand(ref, -4.5, 0)).toBe(true);
    expect(inBand(g, -4.5, 0)).toBe(false);
    expect(inBand(g, -1, 5)).toBe(false);
    expect(inBand(g, 1, 5)).toBe(true);
  });

  it("the finish is a terminal end with R = the 706's outer ring (answer 2)", () => {
    const courses = [course("c", LEG, [C(4, 3, true)])];
    const g = corridorGeometry(courses, mouths(LEG, { "1": "finish" }))!;
    expectInsideKept(g, corridorGeometry(courses, mouths(LEG, { "1": "finish" }), ROUND)!);
    expect(inInside(g, 22.9, 0)).toBe(true);
    expect(inBand(g, 23.5, 0)).toBe(false);
    expect(inBand(g, 18, 4.5)).toBe(true);
    expect(inBand(g, 16.5, 4.5)).toBe(true);
    // The near half of the 706 wrapped up to the line (its face spans ±R = ±3 there).
    expect(inBand(g, 19.9, 3.2)).toBe(true);
    expect(inBand(g, 19.9, -3.2)).toBe(true);
    expect(inBand(g, 16, 6.2)).toBe(false);
  });

  it("the start keeps its geometry: the band frames the whole triangle (answer 2)", () => {
    for (const angles of [{ "0": -90 }, {}] as Record<string, number>[]) {
      const courses = [course("c", LEG, [C(4, 3, true)])];
      const m = mouths(LEG, { "0": "start" }, [], angles);
      const g = corridorGeometry(courses, m)!;
      const ref = corridorGeometry(courses, m, ROUND)!;
      expect(bandDiff(g, ref, P(0, 0), 9)).toEqual([]);
      // Its other end, a control, is terminal.
      expect(bandDiff(g, ref, P(20, 0), 9).length).toBeGreaterThan(0);
    }
    // A start wider than the triangle (h ≥ its extent, no joined 701, a round end) keeps it too.
    const wide = [course("c", LEG, [C(8, 3, true)])];
    const m = mouths(LEG, { "0": "start" });
    expect(bandDiff(corridorGeometry(wide, m)!, corridorGeometry(wide, m, ROUND)!, P(0, 0), 9)).toEqual([]);
  });

  it("a run through a control: the middle kept, both outer ends cut", () => {
    const legs = [[P(0, 0), P(20, 0)], [P(20, 0), P(40, 0)]];
    const courses = [course("c", legs, [C(4, 3, true), C(4, 3, true)])];
    const g = corridorGeometry(courses, mouths(legs))!;
    const ref = corridorGeometry(courses, mouths(legs), ROUND)!;
    expectInsideKept(g, ref);
    expect(bandDiff(g, ref, P(20, 0), 8)).toEqual([]);
    expect(inBand(g, -3, 0)).toBe(false);
    expect(inBand(g, 43, 0)).toBe(false);
    expectSimple(g.band!);
  });

  it("never thinner where corridors continue: a width change, two courses meeting, a reversal, a turn (answer 4)", () => {
    const A = P(0, 0), B = P(20, 0), Cc = P(20, 20), D = P(40, 0);
    const cases: [string, DerivedCourse[], CorridorMouths, MapPoint][] = [
      ["a width change", [courseOf("c", [legOf("a", "b", [A, B], C(4, 3, true)), legOf("b", "d", [B, D], C(3, 2, true))])], sitesAt({ a: A, b: B, d: D }), B],
      ["a band change", [courseOf("c", [legOf("a", "b", [A, B], C(4, 3, true)), legOf("b", "d", [B, D], C(4, 1, true))])], sitesAt({ a: A, b: B, d: D }), B],
      ["two courses meeting", [courseOf("x", [legOf("a", "b", [A, B], C(4, 3, true))]), courseOf("y", [legOf("b", "c", [B, Cc], C(4, 3, true))])], sitesAt({ a: A, b: B, c: Cc }), B],
      ["a reversal", [courseOf("c", [legOf("a", "b", [A, B], C(4, 3, true)), legOf("b", "a", [B, A], C(4, 3, true))])], sitesAt({ a: A, b: B }), A],
      ["a turn", [courseOf("c", [legOf("a", "b", [A, B], C(4, 3, true)), legOf("b", "c", [B, Cc], C(4, 3, true))])], sitesAt({ a: A, b: B, c: Cc }), B],
    ];
    for (const [name, courses, m, site] of cases) {
      const g = corridorGeometry(courses, m)!;
      const ref = corridorGeometry(courses, m, ROUND)!;
      expectInsideKept(g, ref);
      expect(bandDiff(g, ref, site, 8), name).toEqual([]);
      expectSimple(g.band!);
    }
  });

  it("a corridor passing over a terminal site keeps its band whole", () => {
    // Course x ends at t (20, 0); course y passes over t, north–south, ending far away.
    const T = P(20, 0);
    const passing = courseOf("y", [legOf("n", "s", [P(20, 20), P(20, -20)], C(4, 3, true))]);
    const courses = [courseOf("x", [legOf("a", "t", [P(0, 0), T], C(4, 3, true))]), passing];
    const m = sitesAt({ a: P(0, 0), t: T, n: P(20, 20), s: P(20, -20) });
    const g = corridorGeometry(courses, m)!;
    const alone = corridorGeometry([passing], m)!;
    // Every point of the passing corridor's band near t is band or inside here.
    for (let y = -8; y <= 8; y += 0.25) for (const x of [16.5, 17.5, 22.5, 23.5]) {
      if (!inBand(alone, x, y)) continue;
      expect(inBand(g, x, y) || inInside(g, x, y), `${x},${y}`).toBe(true);
    }
  });

  it("a run passing behind or over its own terminal end keeps that part's band (never thinner, answer 4)", () => {
    // Review of F22: the cut is the end's, not the run's — the run's earlier legs keep their band inside its reach.
    const cases: [string, MapPoint[], [number, number][], Corridor?][] = [
      ["a hairpin", [P(0, 0), P(30, 0), P(30, 10), P(8, 10)], [[5, 4], [6, 3.5], [7, 2.5], [9, 3]]],
      ["a figure eight (its end on its first leg)", [P(0, 0), P(30, 0), P(30, 12), P(15, 0)], [[12, 3.5], [12, -3.5], [10, -4], [13, -3], [9, -4.5]]],
      // Spec re-review: a last leg shorter than h + 2w that turns back — the previous leg's band beside the end kept.
      // The editor's default at 1:15 000 (50 m, a 5 mm band: h + 2w ≈ 11.7 mm), a 10 mm last leg.
      ["a short last leg turning back", [P(40, 8), P(20, 0), P(30, 0)], [[33, 1], [32.5, 0.8], [34, 2.5]], C(10 / 3, 5, true)],
      // A short last leg at a right angle: the previous leg's band within the end's corner kept.
      ["a short last leg at a right angle", [P(0, 0), P(20, 0), P(20, 6)], [[14, 4.5], [12.5, 3.5], [14, 3.5]]],
    ];
    for (const [name, pts, probes, k = C(4, 3, true)] of cases) {
      const ids = pts.map((_, i) => `s${i}`);
      const legs = pts.slice(1).map((p, i) => legOf(ids[i], ids[i + 1], [pts[i], p], k));
      const courses = [courseOf("c", legs)];
      const m = sitesAt(Object.fromEntries(pts.map((p, i) => [ids[i], p])));
      const g = corridorGeometry(courses, m)!;
      const ref = corridorGeometry(courses, m, ROUND)!;
      expectInsideKept(g, ref);
      for (const [x, y] of probes) {
        expect(inBand(ref, x, y), `${name} ${x},${y} before`).toBe(true);
        expect(inBand(g, x, y), `${name} ${x},${y}`).toBe(true);
      }
      // The end itself is still cut: behind the last control, away from the earlier legs, the map.
      const [a, b] = [pts[pts.length - 2], pts[pts.length - 1]];
      const len = Math.hypot(b.x - a.x, b.y - a.y), ux = (b.x - a.x) / len, uy = (b.y - a.y) / len;
      const behind = { x: b.x + ux * 4.5 - uy * 4.5, y: b.y + uy * 4.5 + ux * 4.5 };
      if (!inBand(corridorGeometry([courseOf("x", legs.slice(0, -1))], m, ROUND)!, behind.x, behind.y)) expect(inBand(g, behind.x, behind.y), `${name} behind`).toBe(false);
      expectSimple(g.band!);
    }
  });

  it("a curved end: flat across its end segment, simple rings", () => {
    const curve = legPolylineOf(P(0, 0), [{ x: 20, y: 6, hIn: { x: -40 / 6, y: 0 }, hOut: { x: 40 / 6, y: 0 } }], P(40, 0));
    const courses = [course("c", [curve], [C(4, 3, true)])];
    const g = corridorGeometry(courses, mouths([curve]))!;
    expectInsideKept(g, corridorGeometry(courses, mouths([curve]), ROUND)!);
    expectSimple(g.band!);
    expect(g.band!.every((r) => r.length >= 6)).toBe(true);
    // The curve leaves (0, 0) heading up-right: behind it is the map.
    const t = Math.atan2(curve[1].y, curve[1].x);
    expect(inBand(g, -3 * Math.cos(t), -3 * Math.sin(t))).toBe(false);
  });

  /** Band outline vertices near site 0 (x < `within` mm), µm. */
  const nearEnd = (g: CorridorGeometry, within: number) => g.band!.flatMap((q) => ringPoints(q)).filter((p) => p.x < within * 1000);
  /** The circle's near half (radius R about site 0, x from 10 µm to R): every point in the white or in the inside. */
  const expectCircleWrapped = (g: CorridorGeometry, R: number, label: string) => {
    for (let a = 0; a <= 180; a += 2) {
      const x = R * Math.sin((a * Math.PI) / 180), y = R * Math.cos((a * Math.PI) / 180);
      if (x < 0.01) continue;
      expect(inBand(g, x, y) || inInside(g, x, y), `${label}: circle at ${x.toFixed(3)},${y.toFixed(3)}`).toBe(true);
    }
  };

  describe("one corner where the band reaches past the circle (h + w > R; user, 2026-11-09: fix the bump)", () => {
    // A lone leg from site 0 (a control, R 2.5); x measured from 0 towards the leg. r = min(w, h + w − R), the arc
    // about (r, ±(h + w − r)): the face on the line spans ±(h + w − r) ≥ ±R; no mouth half, so nothing past h + w.
    const cases: [string, number, number][] = [["w < R", 1, 2], ["w = R", 1, 2.5], ["w > R (the default: 50 m, 5 mm at 1:15 000)", 5 / 3, 5], ["h ≥ R (r = w)", 3, 2]];
    for (const [name, h, w] of cases) {
      it(name, () => {
        const R = 2.5, H = h + w, r = Math.min(w, H - R), um = 1000;
        const g = corridorGeometry([course("c", LEG, [C(2 * h, w, true)])], mouths(LEG))!;
        expectSimple(g.band!);
        const near = nearEnd(g, 10);
        // Nothing past the line, and no bump: nothing farther from the leg than h + w.
        expect(Math.min(...near.map((p) => p.x))).toBeGreaterThan(-2);
        for (const p of near) expect(Math.abs(p.y), `${p.x},${p.y}`).toBeLessThan(H * um + 6);
        // The face's ends on the line at ±(h + w − r), each the corner's tangent point.
        for (const side of [1, -1]) expect(Math.min(...near.map((p) => Math.hypot(p.x, p.y - side * (H - r) * um)))).toBeLessThan(6);
        // The corner: every outline vertex between the line and r, beyond the face, on the arc of radius r.
        const corner = near.filter((p) => p.x > 5 && p.x < r * um - 5 && Math.abs(p.y) > (H - r) * um + 50);
        expect(corner.length).toBeGreaterThan(3);
        for (const p of corner) expect(Math.abs(Math.hypot(p.x - r * um, Math.abs(p.y) - (H - r) * um) - r * um), `${p.x},${p.y}`).toBeLessThan(6);
        expectCircleWrapped(g, R, name);
      });
    }
  });

  it("h + w ≤ R: the mouth's near half (face ±R, corners of radius w(2R + w) / (2(R + w)) tangent to the R + w disc)", () => {
    // h 0.5 + w 2 = R 2.5: the band alone would not reach the circle's sides; the mouth's grown half wraps it.
    const R = 2.5, w = 2, um = 1000, r = (w * (2 * R + w)) / (2 * (R + w));
    const g = corridorGeometry([course("c", LEG, [C(1, w, true)])], mouths(LEG))!;
    expectSimple(g.band!);
    expectSimple(g.inside);
    const near = nearEnd(g, R);
    expect(Math.min(...near.map((p) => p.x))).toBeGreaterThan(-2);
    for (const side of [1, -1]) expect(Math.min(...near.map((p) => Math.hypot(p.x, p.y - side * R * um)))).toBeLessThan(6);
    expect(near.filter((p) => Math.abs(p.x) <= 2 && Math.abs(p.y) > R * um + 6)).toEqual([]);
    const corner = near.filter((p) => p.x > 5 && p.x < r * um - 5 && Math.abs(p.y) > R * um + 50);
    expect(corner.length).toBeGreaterThan(5);
    for (const p of corner) expect(Math.abs(Math.hypot(p.x - r * um, Math.abs(p.y) - R * um) - r * um), `${p.x},${p.y}`).toBeLessThan(6);
    // Tangent to the grown disc inside, so nothing past R + w; the run's own corners (radius w) lie within.
    expect(Math.hypot(r, R) + r).toBeCloseTo(R + w, 9);
    for (const p of near) expect(Math.hypot(p.x, p.y)).toBeLessThan((R + w) * um + 6);
    expectCircleWrapped(g, R, "h + w ≤ R");
  });

  it("property: over h 0.5–4 and w 1–8 (R 2.5), the circle's near half in the white up to the line and one bump at most", () => {
    const R = 2.5;
    for (let h = 0.5; h <= 4 + 1e-9; h += 0.5) {
      for (let w = 1; w <= 8 + 1e-9; w += 1) {
        const H = h + w, label = `h ${h}, w ${w}`;
        if (H > R) {
          // The arc tangent to the line at (0, H − r), r = min(w, H − R): above the circle near the line.
          const r = Math.min(w, H - R);
          for (const e of [1e-4, 1e-3, 0.01, 0.1, Math.min(r, R) / 2, Math.min(r, R)]) {
            expect((H - r) + Math.sqrt(Math.max(0, r * r - (r - e) * (r - e))), `${label}, ε ${e}`).toBeGreaterThanOrEqual(Math.sqrt(Math.max(0, R * R - e * e)) - 1e-12);
          }
        }
        const g = corridorGeometry([course("c", LEG, [C(2 * h, w)])], mouths(LEG))!;
        expectCircleWrapped(g, R, label);
        // No bump: nothing farther from the leg than h + w where the band reaches past the circle, R + w where not.
        const limit = (H > R ? H : R + w) * 1000 + 6;
        for (const p of nearEnd(g, Math.max(H, R + w))) expect(Math.abs(p.y), `${label}: ${p.x},${p.y}`).toBeLessThan(limit);
      }
    }
  }, 60000);

  it("two options in a row give two results, each a fresh call's", () => {
    const courses = [course("c", LEG, [C(4, 3, true)])];
    const a = corridorGeometry(courses, mouths(LEG));
    const b = corridorGeometry(courses, mouths(LEG), ROUND);
    expect(b).not.toBe(a);
    expect(b!.band).not.toEqual(a!.band);
    expect(corridorGeometry(courses, mouths(LEG))).toEqual(a);
  });
});

const ringPoints = (r: FlatRing) => Array.from({ length: r.length / 2 }, (_, i) => ({ x: r[2 * i], y: r[2 * i + 1] }));
