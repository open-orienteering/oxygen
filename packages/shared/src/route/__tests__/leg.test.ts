/** A leg's route search on a map document (docs/course-elevation.md §7.6–7.7). */

import { describe, it, expect } from "vitest";
import { S, syntheticDoc } from "../../terrain/graph/__tests__/synthetic.js";
import { BLOCKED, BLOCKED_SOFT, CLASS_INDEX, DEFAULT_COST_MODEL, ROUTE_CELL_MM, ROUTE_MAX_CELLS, boxedFeature, findLegRoutes, legPolylineCost, legWindow, routeFeaturesOfDocument, shortestLegRoute, corridorHalfMm } from "../index.js";

const rect = (x0: number, y0: number, x1: number, y1: number) => [x0, y0, x1, y0, x1, y1, x0, y1, x0, y0];

describe("a document's route features (docs/course-elevation.md §7.6)", () => {
  const doc = syntheticDoc([
    { sym: S.water, coords: rect(20, 10, 26, 30) },
    { sym: S.vegetation, coords: rect(0, 0, 5, 5) },
    { sym: S.road, coords: [0, 35, 50, 35] },
    { sym: S.cliffTagged, coords: [30, 0, 30, 8] },
    { sym: S.contour, coords: [0, 20, 50, 20] },
    { sym: S.hiddenContour, coords: [0, 21, 50, 21] },
    { sym: S.sourceOnly, coords: rect(40, 0, 45, 5) },
    { sym: S.course, coords: [10, 10] },
  ]);

  it("lines and areas whose symbol has a class, by the applied match or the source code; contours and points are none", () => {
    // The document keeps its own object order.
    const f = [...routeFeaturesOfDocument(doc)].sort((a, b) => a.cls - b.cls);
    expect(f.map((x) => [x.cls, x.kind])).toEqual([
      [CLASS_INDEX.forest, "area"], [CLASS_INDEX.road, "line"], [CLASS_INDEX.slow, "area"], [BLOCKED_SOFT, "area"], [BLOCKED, "line"],
    ]);
    expect(f[3].box).toEqual([20, 10, 26, 30]);
    expect(Array.from(f[1].parts[0])).toEqual([0, 35, 50, 35]);
  });

  it("an object a patch hides is skipped", () => {
    const hidden = new Uint8Array(doc.attrs.symbolIdx.length);
    hidden[Array.from(doc.attrs.symbolIdx).indexOf(S.water)] = 1;
    expect(routeFeaturesOfDocument({ ...doc, hidden }).map((x) => x.cls)).not.toContain(BLOCKED_SOFT);
  });

  it("the shortest legal route: no vertices where the line is legal, round the lake where it is not, null without a way", () => {
    const features = routeFeaturesOfDocument(doc);
    expect(shortestLegRoute(features, { from: { x: 10, y: 34 }, to: { x: 36, y: 34 }, groundMPerMm: 15 })).toEqual([]);
    const req = { from: { x: 10, y: 20 }, to: { x: 36, y: 20 }, groundMPerMm: 15 };
    const round = shortestLegRoute(features, req)!;
    expect(round.length).toBeGreaterThan(0);
    // The same route the full search marks shortest.
    const full = findLegRoutes(features, null, req, DEFAULT_COST_MODEL).routes.find((r) => r.shortest)!;
    const len = (pts: { x: number; y: number }[]) => pts.slice(1).reduce((m, p, i) => m + Math.hypot(p.x - pts[i].x, p.y - pts[i].y), 0);
    expect(len([req.from, ...round, req.to]) * 15).toBeCloseTo(full.lengthM, 6);
    // Walled in on every side.
    const wall = boxedFeature(BLOCKED, "line", [[30, 14, 42, 14, 42, 26, 30, 26, 30, 14]]);
    expect(shortestLegRoute(features, { ...req, extra: [wall] })).toBeNull();
  });

  it("a leg's cost along a polyline: its metres on flat forest, less on the road, the same as the search's for its route", () => {
    const features = routeFeaturesOfDocument(doc);
    expect(legPolylineCost(features, null, { points: [{ x: 6, y: 40 }, { x: 46, y: 40 }], groundMPerMm: 15 }, DEFAULT_COST_MODEL)).toBeCloseTo(600, 3);
    expect(legPolylineCost(features, null, { points: [{ x: 6, y: 35 }, { x: 46, y: 35 }], groundMPerMm: 15 }, DEFAULT_COST_MODEL)).toBeLessThan(450);
    const req = { from: { x: 10, y: 20 }, to: { x: 36, y: 20 }, groundMPerMm: 15 };
    const [fastest] = findLegRoutes(features, null, req, DEFAULT_COST_MODEL).routes;
    expect(legPolylineCost(features, null, { points: fastest.points, groundMPerMm: 15 }, DEFAULT_COST_MODEL)).toBeCloseTo(fastest.costM, 0);
    expect(legPolylineCost(features, null, { points: [req.from], groundMPerMm: 15 }, DEFAULT_COST_MODEL)).toBe(0);
  });

  it("a leg across the lake runs round it; the course's out-of-bounds area closes one side", () => {
    const features = routeFeaturesOfDocument(doc);
    const req = { from: { x: 10, y: 20 }, to: { x: 36, y: 20 }, groundMPerMm: 15 };
    const open = findLegRoutes(features, null, req, DEFAULT_COST_MODEL);
    expect(open.cellMm).toBe(ROUTE_CELL_MM);
    expect(open.routes.length).toBeGreaterThanOrEqual(2);
    for (const r of open.routes) expect(r.lengthM).toBeGreaterThan(26 * 15);
    const south = boxedFeature(BLOCKED, "area", [rect(18, 0, 28, 10.5)]);
    const closed = findLegRoutes(features, null, { ...req, extra: [south] }, DEFAULT_COST_MODEL);
    for (const r of closed.routes) expect(Math.max(...r.points.map((p) => p.y))).toBeGreaterThan(29.9);
  });
});

describe("a leg's window (docs/course-elevation.md §7.6)", () => {
  it("half the leg's length beyond its ends, at least 10 mm; the finest cell while the window is small", () => {
    const short = legWindow({ from: { x: 10, y: 10 }, to: { x: 14, y: 10 } });
    expect(short.bounds).toEqual({ minX: 0, minY: 0, maxX: 24, maxY: 20 });
    expect(short.cellMm).toBe(ROUTE_CELL_MM);
    const leg = legWindow({ from: { x: 0, y: 0 }, to: { x: 60, y: 0 }, via: [{ x: 30, y: 50 }] });
    expect(leg.bounds).toEqual({ minX: -30, minY: -30, maxX: 90, maxY: 80 });
  });

  it("a long leg gets coarser cells: the cell count stays bounded", () => {
    const long = legWindow({ from: { x: 0, y: 0 }, to: { x: 300, y: 200 } });
    expect(long.cellMm).toBeGreaterThan(ROUTE_CELL_MM);
    const cells = ((long.bounds.maxX - long.bounds.minX) / long.cellMm) * ((long.bounds.maxY - long.bounds.minY) / long.cellMm);
    expect(cells).toBeLessThanOrEqual(ROUTE_MAX_CELLS * 1.01);
  });
});

describe("a corridor leg (docs/course-elevation.md §7.6, §0.46)", () => {
  const from = { x: 10, y: 20 }, to = { x: 40, y: 20 };
  const off = (line: { x: number; y: number }[], p: { x: number; y: number }) => Math.min(...line.slice(1).map((b, i) => {
    const a = line[i], dx = b.x - a.x, dy = b.y - a.y;
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy)));
    return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
  }));
  /** Every point of a route, 0.1 mm apart, within `reach` of the line. */
  const inside = (line: { x: number; y: number }[], route: { x: number; y: number }[], reach: number) => route.slice(1).every((b, i) => {
    const a = route[i], n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 0.1));
    return Array.from({ length: n + 1 }, (_, s) => ({ x: a.x + ((b.x - a.x) * s) / n, y: a.y + ((b.y - a.y) * s) / n })).every((p) => off(line, p) <= reach);
  });

  it("the width on the ground in paper mm: half of it, nothing for no width", () => {
    expect(corridorHalfMm(50, 10)).toBe(2.5);
    expect(corridorHalfMm(0, 10)).toBeNull();
    expect(corridorHalfMm(-1, 10)).toBeNull();
  });

  it("the shortest route follows the centre line where it is legal, bends and all", () => {
    const line = [from, { x: 25, y: 30 }, to];
    // Without the corridor the straight line is the route.
    expect(shortestLegRoute([], { from, to, groundMPerMm: 10 })).toEqual([]);
    expect(shortestLegRoute([], { from, to, groundMPerMm: 10, corridor: { line, halfMm: 1 } })).toEqual([]);
  });

  it("an obstacle on the centre: round it inside the corridor; the corridor closed: no way", () => {
    const line = [from, to];
    const lake = boxedFeature(BLOCKED_SOFT, "area", [rect(22, 19, 28, 21)]);
    // Unconfined the shortest way passes close round the lake; a corridor 2.5 mm wide either side keeps it within.
    const round = shortestLegRoute([lake], { from, to, groundMPerMm: 10, corridor: { line, halfMm: 2.5 } })!;
    expect(round.length).toBeGreaterThan(0);
    expect(inside(line, [from, ...round, to], 2.5 + 0.3)).toBe(true);
    const wall = boxedFeature(BLOCKED, "line", [[25, 15, 25, 25]]);
    expect(shortestLegRoute([wall], { from, to, groundMPerMm: 10, corridor: { line, halfMm: 2.5 } })).toBeNull();
    // Without the corridor the wall is passed at its end.
    expect(shortestLegRoute([wall], { from, to, groundMPerMm: 10 })).not.toBeNull();
  });

  it("a bent corridor whose centre crosses a lake: the route has its own vertices, inside, never read as the bent line", () => {
    const line = [from, { x: 25, y: 23 }, to];
    const lake = boxedFeature(BLOCKED_SOFT, "area", [rect(23, 21.5, 27, 26)]);
    const route = shortestLegRoute([lake], { from, to, groundMPerMm: 10, corridor: { line, halfMm: 4 } })!;
    expect(route.length).toBeGreaterThan(0);
    expect(inside(line, [from, ...route, to], 4 + 0.3)).toBe(true);
    expect(legPolylineCost([lake], null, { points: [from, ...route, to], groundMPerMm: 10 }, DEFAULT_COST_MODEL)).toBeLessThan(Infinity);
  });

  it("every computed route stays inside, though a faster way runs outside", () => {
    const line = [from, to];
    const road = boxedFeature(CLASS_INDEX.road, "line", [[0, 23, 50, 23]]);
    const free = findLegRoutes([road], null, { from, to, groundMPerMm: 10 }, DEFAULT_COST_MODEL);
    expect(Math.max(...free.routes.find((r) => r.fastest)!.points.map((p) => p.y))).toBeGreaterThan(22.5);
    const kept = findLegRoutes([road], null, { from, to, groundMPerMm: 10, corridor: { line, halfMm: 1.5 } }, DEFAULT_COST_MODEL);
    expect(kept.routes.length).toBeGreaterThan(0);
    for (const r of kept.routes) expect(inside(line, r.points, 1.5 + 0.3)).toBe(true);
  });

  it("the window is the corridor's, 1 mm beyond its edge", () => {
    const w = legWindow({ from, to, corridor: { line: [from, { x: 25, y: 30 }, to], halfMm: 2 } });
    expect(w.bounds).toEqual({ minX: 7, minY: 17, maxX: 43, maxY: 33 });
    expect(w.cellMm).toBe(ROUTE_CELL_MM);
  });
});
