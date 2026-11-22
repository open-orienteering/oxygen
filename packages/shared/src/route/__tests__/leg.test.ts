/** A leg's route search on a map document (docs/course-elevation.md §7.6–7.7). */

import { describe, it, expect } from "vitest";
import { S, syntheticDoc } from "../../terrain/graph/__tests__/synthetic.js";
import { BLOCKED, BLOCKED_SOFT, CLASS_INDEX, DEFAULT_COST_MODEL, ROUTE_CELL_MM, ROUTE_MAX_CELLS, boxedFeature, findLegRoutes, legPolylineCost, legWindow, routeFeaturesOfDocument, shortestLegRoute } from "../index.js";

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
