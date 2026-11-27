/** The route search (docs/course-elevation.md §7.6–7.7): cost classes, the grid, the cost field and the alternatives. */

import { describe, it, expect } from "vitest";
import {
  BLOCKED, BLOCKED_SOFT, CLASS_INDEX, COST_MODELS, DEFAULT_COST_MODEL, DEFAULT_COST_MODEL_DATA, costModelFromData, costModelNote, currentCostModel, SHORTEST_COST_MODEL, buildRouteGrid, cellOf, costClassOfCode, costField, defaultSlopeFactor,
  confineToCorridor, findRoutes, isBlockedClass, nearestPassable, openDisc, polylineCost, segmentCost, tracePath, type RouteFeature, type RouteGrid, type RoutePoint,
} from "../index.js";

const C = CLASS_INDEX;
const rect = (x0: number, y0: number, x1: number, y1: number): number[] => [x0, y0, x1, y0, x1, y1, x0, y1];
const area = (cls: number, ...parts: number[][]): RouteFeature => ({ cls, kind: "area", parts });
const line = (cls: number, ...parts: number[][]): RouteFeature => ({ cls, kind: "line", parts });
/** 40 × 40 mm at 1:10 000, 0.5 mm cells (5 m): 80 × 80 cells. */
const grid = (features: RouteFeature[], heightAt?: (p: RoutePoint) => number | null): RouteGrid =>
  buildRouteGrid({ bounds: { minX: 0, minY: 0, maxX: 40, maxY: 40 }, cellMm: 0.5, groundMPerMm: 10, features, heightAt });
const at = (g: RouteGrid, x: number, y: number) => g.cls[cellOf(g, { x, y })];
const legal = (g: RouteGrid, points: readonly RoutePoint[]) => Number.isFinite(polylineCost(g, SHORTEST_COST_MODEL, points));
const A = { x: 5.25, y: 20.25 };
const B = { x: 35.25, y: 20.25 };

describe("cost classes (docs/course-elevation.md §7.6)", () => {
  it("a model is data: the rule of thumb rebuilt from its numbers, by id, per map family; its note says what is measured (§7.9)", () => {
    const rebuilt = costModelFromData(JSON.parse(JSON.stringify(DEFAULT_COST_MODEL_DATA)));
    expect(rebuilt.classFactor).toEqual(DEFAULT_COST_MODEL.classFactor);
    for (const g of [-0.4, -0.1, -0.05, 0, 0.03, 0.2, Number.NaN]) expect(rebuilt.slopeFactor(g)).toBe(defaultSlopeFactor(g));
    expect(defaultSlopeFactor(0.1)).toBeCloseTo(1.75, 9);
    expect(defaultSlopeFactor(-0.1)).toBeCloseTo(0.85, 9);
    expect(defaultSlopeFactor(-0.2)).toBeCloseTo(1.15, 9);
    expect(COST_MODELS["default-1"]).toBe(DEFAULT_COST_MODEL_DATA);
    // Forest maps run under the model fitted from tracks (§7.9.7); sprint maps under the rule of thumb.
    for (const header of [undefined, null, { library: null }, { library: { id: "ISOM2017-2" } }]) expect(currentCostModel(header).id).toBe("forest-2026-1");
    expect(currentCostModel({ library: { id: "ISSprOM2019-2" } }).id).toBe("default-1");
    expect(costModelNote(currentCostModel(null))).toEqual({ id: "forest-2026-1", state: "partial", classes: ["forest", "path", "smallPath", "marsh"] });
    const forest = COST_MODELS["forest-2026-1"];
    // Only what was measured differs from the rule of thumb.
    for (const [c, v] of Object.entries(forest.classFactor)) expect(v === DEFAULT_COST_MODEL_DATA.classFactor[c as keyof typeof forest.classFactor], c).toBe(!["path", "smallPath", "marsh"].includes(c));
    expect(forest.slope).toEqual(DEFAULT_COST_MODEL_DATA.slope);
    const two = { s: { ...DEFAULT_COST_MODEL_DATA, id: "s" }, f: { ...DEFAULT_COST_MODEL_DATA, id: "f" } };
    const pick = (id: string | null) => currentCostModel(id === null ? null : { library: { id } }, { sprint: "s", forest: "f" }, two).id;
    expect([pick("ISSprOM2019-2"), pick("ISOM2017-2"), pick(null)]).toEqual(["s", "f", "f"]);
    expect(currentCostModel(null, { sprint: "gone", forest: "gone" }, two).id).toBe("default-1");
    expect(costModelNote(DEFAULT_COST_MODEL)).toEqual({ id: "default-1", state: "none", classes: [] });
    const some = costModelFromData({ ...DEFAULT_COST_MODEL_DATA, id: "x", calibrated: ["paved", "open"], anchor: "paved" });
    expect(costModelNote(some)).toEqual({ id: "x", state: "partial", classes: ["paved", "open"] });
    const all = costModelFromData({ ...DEFAULT_COST_MODEL_DATA, id: "y", calibrated: Object.keys(DEFAULT_COST_MODEL_DATA.classFactor) as never, slopeCalibrated: true });
    expect(costModelNote(all).state).toBe("full");
    expect(costModelNote(SHORTEST_COST_MODEL).state).toBe("none");
  });

  it("a symbol code names its class; the decimals and unknown symbols", () => {
    expect(costClassOfCode("405")).toBe(C.forest);
    expect(costClassOfCode("410")).toBe(C.fight);
    expect(costClassOfCode("505.1")).toBe(C.path);
    expect(costClassOfCode("301")).toBe(BLOCKED_SOFT);
    expect(costClassOfCode("521")).toBe(BLOCKED);
    for (const code of ["201", "307", "411", "515", "518", "520", "529", "708", "709"]) expect(isBlockedClass(costClassOfCode(code)!), code).toBe(true);
    expect(costClassOfCode("101")).toBeNull();
    expect(costClassOfCode("")).toBeNull();
  });

  it("the default model: forest is 1, ways are faster, green is slower, nothing uncrossable has a speed", () => {
    const f = DEFAULT_COST_MODEL.classFactor;
    expect(f[C.forest]).toBe(1);
    expect(f[C.paved]).toBeLessThan(f[C.path]);
    expect(f[C.path]).toBeLessThan(f[C.forest]);
    expect(f[C.slow]).toBeLessThan(f[C.walk]);
    expect(f[C.walk]).toBeLessThan(f[C.fight]);
    expect(f[BLOCKED]).toBe(Infinity);
    expect(DEFAULT_COST_MODEL.calibrated).toBe(false);
  });

  it("slope: up costs, gentle down helps, steep down costs again", () => {
    expect(defaultSlopeFactor(0)).toBe(1);
    expect(defaultSlopeFactor(0.1)).toBeCloseTo(1.75);
    expect(defaultSlopeFactor(-0.1)).toBeCloseTo(0.85);
    expect(defaultSlopeFactor(-0.05)).toBeLessThan(1);
    expect(defaultSlopeFactor(-0.4)).toBeGreaterThan(1);
    expect(defaultSlopeFactor(Number.NaN)).toBe(1);
  });
});

describe("the grid (docs/course-elevation.md §7.6)", () => {
  it("an area fills the cells whose centre is inside; a hole is left out; unmapped is forest", () => {
    const g = grid([area(C.open, rect(10, 10, 30, 30), rect(18, 18, 22, 22))]);
    expect([g.cols, g.rows]).toEqual([80, 80]);
    expect(at(g, 12, 12)).toBe(C.open);
    expect(at(g, 20, 20)).toBe(C.forest);
    expect(at(g, 5, 5)).toBe(C.forest);
    expect(at(g, 29.9, 29.9)).toBe(C.open);
    expect(at(g, 30.3, 20)).toBe(C.forest);
  });

  it("areas rank as the colours stack, whatever their order; the uncrossable is on top", () => {
    const features = [area(C.fight, rect(10, 10, 20, 20)), area(C.open, rect(5, 5, 30, 30)), area(BLOCKED, rect(12, 12, 14, 14)), area(C.fight, rect(12, 12, 14, 14))];
    for (const f of [features, [...features].reverse()]) {
      const g = grid(f);
      expect(at(g, 7, 7)).toBe(C.open);
      expect(at(g, 17, 17)).toBe(C.fight);
      expect(at(g, 13, 13)).toBe(BLOCKED);
    }
  });

  it("a path over uncrossable water is a bridge; over a building it opens nothing; a fence closes a path", () => {
    const g = grid([
      area(BLOCKED_SOFT, rect(10, 0, 14, 40)), area(BLOCKED, rect(20, 0, 24, 40)),
      line(C.path, [0, 20.25, 40, 20.25]), line(BLOCKED, [30.25, 0, 30.25, 40]),
    ]);
    expect(at(g, 12, 20.25)).toBe(C.path);
    expect(at(g, 12, 25)).toBe(BLOCKED_SOFT);
    expect(at(g, 22, 20.25)).toBe(BLOCKED);
    expect(at(g, 30.25, 20.25)).toBe(BLOCKED);
    expect(at(g, 27, 20.25)).toBe(C.path);
  });

  it("a line of a class that is no way and no barrier marks nothing", () => {
    const g = grid([line(C.open, [0, 20, 40, 20]), line(C.fight, [0, 10, 40, 10])]);
    expect(g.cls.every((c) => c === C.forest)).toBe(true);
  });

  it("a slanted barrier leaves no diagonal step to slip through", () => {
    const g = grid([line(BLOCKED, [-5, 3.1, 45, 37.4])]);
    const field = costField(g, SHORTEST_COST_MODEL, cellOf(g, { x: 5, y: 35 }));
    expect(field.cost[cellOf(g, { x: 35, y: 5 })]).toBe(Infinity);
    expect(Number.isFinite(field.cost[cellOf(g, { x: 5, y: 20 })])).toBe(true);
  });

  it("heights are read at the cells' centres; unknown is NaN", () => {
    const g = grid([], (p) => (p.x < 20 ? p.x : null));
    expect(g.heights![cellOf(g, { x: 5.25, y: 5.25 })]).toBeCloseTo(5.25);
    expect(Number.isNaN(g.heights![cellOf(g, { x: 30, y: 5 })])).toBe(true);
    expect(grid([]).heights).toBeNull();
  });

  it("a disc opens an obstacle; the nearest passable cell to a point inside one", () => {
    const g = grid([area(BLOCKED, rect(18, 0, 22, 40))]);
    const inside = cellOf(g, { x: 18.75, y: 20.25 });
    const near = nearestPassable(g, inside);
    expect(isBlockedClass(g.cls[near])).toBe(false);
    expect(Math.abs((near % g.cols) - (inside % g.cols))).toBeLessThanOrEqual(2);
    expect(nearestPassable(g, cellOf(g, { x: 5, y: 5 }))).toBe(cellOf(g, { x: 5, y: 5 }));
    expect(nearestPassable(g, cellOf(g, { x: 20, y: 20 }), 2)).toBe(-1);
    openDisc(g, { x: 20, y: 20 }, 2.5, C.path);
    expect(at(g, 20, 20)).toBe(C.path);
    expect(at(g, 20, 30)).toBe(BLOCKED);
  });
});

describe("the cost field (docs/course-elevation.md §7.7)", () => {
  it("on flat forest the cost is the distance, within the eight directions' error", () => {
    const g = grid([]);
    const field = costField(g, DEFAULT_COST_MODEL, cellOf(g, A));
    expect(field.cost[cellOf(g, B)]).toBeCloseTo(300, 6);
    const slant = field.cost[cellOf(g, { x: 35.25, y: 30.25 })];
    const straight = Math.hypot(300, 100);
    expect(slant).toBeGreaterThanOrEqual(straight - 1e-6);
    expect(slant).toBeLessThanOrEqual(straight * 1.083);
    expect(tracePath(field, cellOf(g, B)).at(-1)).toBe(cellOf(g, A));
  });

  it("a wall is passed at its gap; an enclosed cell is never reached; an uncrossable origin reaches nothing", () => {
    const g = grid([line(BLOCKED, [20.25, 0, 20.25, 30]), line(BLOCKED, [20.25, 32, 20.25, 40])]);
    const field = costField(g, DEFAULT_COST_MODEL, cellOf(g, A));
    const cells = tracePath(field, cellOf(g, B));
    const through = cells.filter((c) => c % g.cols === 40).map((c) => Math.floor(c / g.cols));
    expect(through.length).toBeGreaterThan(0);
    for (const r of through) { expect(r).toBeGreaterThanOrEqual(60); expect(r).toBeLessThan(64); }
    const closed = grid([line(BLOCKED, [...rect(30, 15, 38, 25), 30, 15])]);
    expect(costField(closed, DEFAULT_COST_MODEL, cellOf(closed, A)).cost[cellOf(closed, B)]).toBe(Infinity);
    expect(costField(closed, DEFAULT_COST_MODEL, cellOf(closed, { x: 30.25, y: 20 })).cost.every((c) => c === Infinity)).toBe(true);
  });

  it("uphill costs more than the same way down, and the reverse field costs each move in its running direction", () => {
    const g = grid([], (p) => p.x * 0.5);
    const up = costField(g, DEFAULT_COST_MODEL, cellOf(g, A)).cost[cellOf(g, B)];
    const down = costField(g, DEFAULT_COST_MODEL, cellOf(g, B)).cost[cellOf(g, A)];
    expect(up).toBeGreaterThan(down);
    expect(costField(g, DEFAULT_COST_MODEL, cellOf(g, B), true).cost[cellOf(g, A)]).toBeCloseTo(up, 6);
    expect(costField(g, DEFAULT_COST_MODEL, cellOf(g, A), true).cost[cellOf(g, B)]).toBeCloseTo(down, 6);
  });
});

describe("route alternatives (docs/course-elevation.md §7.7)", () => {
  const model = DEFAULT_COST_MODEL;

  it("open terrain: one route, straight, the fastest and the shortest", () => {
    const g = grid([]);
    const routes = findRoutes(g, A, B, { model });
    expect(routes).toHaveLength(1);
    expect(routes[0]).toMatchObject({ fastest: true, shortest: true });
    expect(routes[0].points).toEqual([A, B]);
    expect(routes[0].lengthM).toBeCloseTo(300, 6);
    expect(routes[0].costM).toBeCloseTo(300, 6);
  });

  it("a slanted leg comes out straight: the grid's staircase is taken out", () => {
    const g = grid([]);
    const to = { x: 33.25, y: 31.25 };
    const [r] = findRoutes(g, A, to, { model });
    expect(r.lengthM).toBeLessThanOrEqual(Math.hypot(280, 110) * 1.002);
    expect(r.points.length).toBeLessThanOrEqual(3);
  });

  it("a lake: every route runs round it and none touches it; both sides are offered", () => {
    const g = grid([area(BLOCKED_SOFT, rect(17, 11, 23, 29))]);
    const routes = findRoutes(g, A, B, { model });
    expect(routes.length).toBeGreaterThanOrEqual(2);
    for (const r of routes) {
      expect(legal(g, r.points)).toBe(true);
      expect(r.lengthM).toBeGreaterThan(300);
      expect(r.costM).toBeLessThanOrEqual(routes[0].costM * 1.3 + 1e-6);
    }
    expect(routes[0].fastest).toBe(true);
    expect(routes.filter((r) => r.fastest)).toHaveLength(1);
    expect(routes.filter((r) => r.shortest)).toHaveLength(1);
    // One passes south of the lake, one north.
    const sides = routes.map((r) => Math.sign(r.points.reduce((far, p) => (Math.abs(p.y - 20.25) > Math.abs(far) ? p.y - 20.25 : far), 0)));
    expect(new Set(sides).size).toBe(2);
  });

  it("a path round thick forest is the fastest; the straight way through is the shortest, and another route", () => {
    const g = grid([area(C.fight, rect(8, 12, 32, 28)), line(C.path, [5.25, 20.25, 5.25, 30.25, 35.25, 30.25, 35.25, 20.25])]);
    const routes = findRoutes(g, A, B, { model });
    const fastest = routes.find((r) => r.fastest)!;
    const shortest = routes.find((r) => r.shortest)!;
    expect(fastest).not.toBe(shortest);
    expect(fastest.lengthM).toBeGreaterThan(400);
    expect(Math.max(...fastest.points.map((p) => p.y))).toBeGreaterThan(28);
    expect(shortest.lengthM).toBeCloseTo(300, 0);
    expect(shortest.costM).toBeGreaterThan(fastest.costM);
    expect(fastest.costM).toBeCloseTo(polylineCost(g, model, fastest.points), 6);
  });

  it("a hill in the way: the fastest route costs less than the straight line over it", () => {
    const hill = (p: RoutePoint) => Math.max(0, 60 - Math.hypot(p.x - 20.25, p.y - 20.25) * 10 * 0.6);
    const g = grid([], hill);
    const fastest = findRoutes(g, A, B, { model }).find((r) => r.fastest)!;
    expect(fastest.costM).toBeLessThan(segmentCost(g, model, A, B));
    expect(fastest.lengthM).toBeGreaterThan(300);
  });

  it("no alternatives when none is asked for; the cost ratio and the shared share bound them", () => {
    const g = grid([area(BLOCKED_SOFT, rect(17, 11, 23, 29))]);
    expect(findRoutes(g, A, B, { model, alternatives: 0 }).filter((r) => !r.fastest && !r.shortest)).toHaveLength(0);
    // The lake off-centre: the long way round costs more than 1.05 × the short way.
    const off = grid([area(BLOCKED_SOFT, rect(17, 15, 23, 39.5))]);
    expect(findRoutes(off, A, B, { model, maxCostRatio: 1.05 })).toHaveLength(1);
  });

  it("no way: an enclosed control gives no route", () => {
    const g = grid([line(BLOCKED, [...rect(30, 15, 39, 25), 30, 15])]);
    expect(findRoutes(g, A, B, { model })).toEqual([]);
  });

  it("a crossing point opens the fence where it stands, and the route passes it", () => {
    const fence = [line(BLOCKED, [20.25, -1, 20.25, 41])];
    const g = grid(fence);
    expect(findRoutes(g, A, B, { model })).toEqual([]);
    const via = { x: 20.25, y: 30.25 };
    const routes = findRoutes(g, A, B, { model, via: [via] });
    expect(routes).toHaveLength(1);
    expect(routes[0]).toMatchObject({ fastest: true, shortest: true });
    expect(routes[0].points.some((p) => Math.hypot(p.x - via.x, p.y - via.y) < 1e-9)).toBe(true);
    expect(routes[0].points[0]).toEqual(A);
    expect(routes[0].points.at(-1)).toEqual(B);
    // The grid given is left as it was.
    expect(at(g, 20.25, 30.25)).toBe(BLOCKED);
  });

  it("a control standing on an uncrossable cell is run to from the nearest passable one", () => {
    const g = grid([area(BLOCKED, rect(34, 19, 37, 22))]);
    const [r] = findRoutes(g, A, B, { model });
    expect(r.points.at(-1)).toEqual(B);
    expect(r.lengthM).toBeGreaterThan(270);
  });

  describe("at the search's own cell size (0.25 mm), in a window like a leg's", () => {
    const fine = (features: RouteFeature[], heightAt?: (p: RoutePoint) => number | null): RouteGrid =>
      buildRouteGrid({ bounds: { minX: 0, minY: 0, maxX: 60, maxY: 40 }, cellMm: 0.25, groundMPerMm: 10, features, heightAt });
    const from = { x: 10, y: 20 };
    const to = { x: 50, y: 20 };
    /** The y of every place the route crosses the vertical at `x`. */
    const crossings = (points: readonly RoutePoint[], x: number): number[] => {
      const ys: number[] = [];
      for (let i = 1; i < points.length; i++) {
        const [a, b] = [points[i - 1], points[i]];
        if ((a.x - x) * (b.x - x) < 0) ys.push(a.y + ((x - a.x) / (b.x - a.x)) * (b.y - a.y));
      }
      return ys;
    };

    it("open terrain gives one route, not the same line twice", () => {
      const routes = findRoutes(fine([]), from, to, { model });
      expect(routes).toHaveLength(1);
      expect(routes[0].points).toEqual([from, to]);
    });

    it("a control on a building with a wall between: no route crosses the wall, and every cost is a number", () => {
      const wall = line(BLOCKED, [30, 5, 30, 35]);
      for (const [name, features, a, b] of [
        ["start on a building", [area(BLOCKED, rect(9, 19, 11, 21)), wall], from, to],
        ["end on a building", [area(BLOCKED, rect(49.5, 19.5, 50.5, 20.5)), line(BLOCKED, [45, 5, 45, 35])], from, to],
        ["end on a cliff", [wall, line(BLOCKED, [49, 20.1, 51, 20.1])], from, { x: 50, y: 20.1 }],
      ] as const) {
        const routes = findRoutes(fine([...features]), a, b, { model });
        expect(routes.length, name).toBeGreaterThanOrEqual(1);
        for (const r of routes) {
          expect(Number.isFinite(r.costM), name).toBe(true);
          expect(r.costM, name).toBeGreaterThan(400);
          expect(r.points[0], name).toEqual(a);
          expect(r.points.at(-1), name).toEqual(b);
          const x = name === "end on a building" ? 45 : 30;
          for (const y of crossings(r.points, x)) expect(y < 5 || y > 35, `${name}: crosses the wall at y ${y}`).toBe(true);
        }
      }
    });

    it("an uncrossable area thinner than a cell still closes the way, straight or slanted", () => {
      for (const strip of [[30.02, 0, 30.2, 0, 30.2, 40, 30.02, 40], [30.15, 0, 30.35, 0, 30.35, 40, 30.15, 40], [20, 0, 20.2, 0, 40.2, 40, 40, 40]])
        expect(findRoutes(fine([area(BLOCKED, strip)]), from, to, { model })).toEqual([]);
    });

    it("a wide lake with a thin arm: the arm closes the way, the lake is not outlined", () => {
      // A lake 20 mm wide with an arm 0.1 mm wide down to the edge: straight across the arm is not a way.
      const lake = [20, 25, 40, 25, 40, 40, 20, 40];
      const arm = [29.95, 0, 30.05, 0, 30.05, 25, 29.95, 25];
      const shape = [20, 25, 29.95, 25, 29.95, 0, 30.05, 0, 30.05, 25, 40, 25, 40, 40, 20, 40];
      for (const r of findRoutes(fine([area(BLOCKED, arm)]), from, to, { model })) for (const y of crossings(r.points, 30)) expect(y).toBeGreaterThan(25);
      expect(findRoutes(fine([area(BLOCKED, shape)]), from, to, { model })).toEqual([]);
      // The lake alone leaves the line at y 20 free, 5 mm from its bank.
      expect(findRoutes(fine([area(BLOCKED, lake)]), from, to, { model })[0].lengthM).toBeCloseTo(400, 3);
    });

    it("a passage between two buildings stays open, as narrow as two cells; a way through it too", () => {
      for (const gap of [0.4, 0.5]) {
        const walls = [area(BLOCKED, rect(25, 0, 35, 20)), area(BLOCKED, rect(25, 20 + gap, 35, 40))];
        const [r] = findRoutes(fine(walls), from, { x: 50, y: 20 + gap / 2 }, { model });
        expect(r, `gap ${gap}`).toBeDefined();
        expect(r.lengthM, `gap ${gap}`).toBeLessThan(410);
      }
      const lakes = [area(BLOCKED_SOFT, rect(25, 0, 35, 20)), area(BLOCKED_SOFT, rect(25, 20.5, 35, 40))];
      expect(findRoutes(fine(lakes), from, { x: 50, y: 20.25 }, { model })[0].lengthM).toBeLessThan(410);
    });

    it("the marks are the cheapest route's and the shortest route's, after straightening too", () => {
      const routes = findRoutes(fine([area(C.slow, rect(15, 18, 45, 22))]), from, to, { model });
      const shortest = routes.filter((r) => r.shortest);
      expect(shortest).toHaveLength(1);
      expect(shortest[0].lengthM).toBeCloseTo(400, 3);
      for (const r of routes) expect(r.lengthM).toBeGreaterThanOrEqual(shortest[0].lengthM - 1e-6);
      expect(routes[0].fastest).toBe(true);
      expect(routes.filter((r) => r.fastest)).toHaveLength(1);
      for (const r of routes) expect(r.costM).toBeGreaterThanOrEqual(routes[0].costM);
    });

    it("a control beside a fence, in the fence's cell, is run to from its own side", () => {
      const fence = line(BLOCKED, [10.05, 5, 10.05, 35]);
      const [r] = findRoutes(fine([fence]), { x: 10.2, y: 20 }, to, { model });
      expect(r.lengthM).toBeLessThan(402);
      const [l] = findRoutes(fine([line(BLOCKED, [49.95, 5, 49.95, 35])]), from, { x: 49.8, y: 20 }, { model });
      expect(l.lengthM).toBeLessThan(402);
    });

    it("downhill costs what the model says: 400 m at 10 % down is 340", () => {
      const g = fine([], (p) => 100 - p.x * 10 * 0.1);
      const [r] = findRoutes(g, from, to, { model, alternatives: 0 });
      expect(r.points).toEqual([from, to]);
      expect(r.costM).toBeCloseTo(400 * defaultSlopeFactor(-0.1), 3);
      expect(segmentCost(g, model, to, from)).toBeCloseTo(400 * defaultSlopeFactor(0.1), 3);
    });

    it("a bridge stays open when the river's banks are drawn as lines too", () => {
      const g = fine([
        area(BLOCKED_SOFT, rect(28, 0, 32, 40)), line(BLOCKED_SOFT, [28, 0, 28, 40]), line(BLOCKED_SOFT, [32, 0, 32, 40]),
        line(C.path, [20, 20, 40, 20]),
      ]);
      const [r] = findRoutes(g, from, to, { model });
      expect(r.lengthM).toBeCloseTo(400, 0);
      expect(r.costM).toBeLessThan(400);
    });
  });

  it("the same input gives the same routes", () => {
    const features = [area(BLOCKED_SOFT, rect(17, 11, 23, 29)), area(C.slow, rect(5, 30, 35, 38))];
    expect(findRoutes(grid(features), A, B, { model })).toEqual(findRoutes(grid(features), A, B, { model }));
  });
});

describe("the cost field stops at its target (docs/course-elevation.md §7.7)", () => {
  const lake = () => grid([area(BLOCKED, rect(17, 8, 23, 32))]);
  const gap = () => grid([line(BLOCKED, [20.25, 0, 20.25, 30]), line(BLOCKED, [20.25, 32, 20.25, 40])]);

  it.each([["the lake", lake], ["the gap", gap]])("gives the target's cost and path as without a stop, and leaves farther cells unreached (%s)", (_n, make) => {
    const g = make();
    const a = cellOf(g, A), b = cellOf(g, B);
    for (const model of [DEFAULT_COST_MODEL, SHORTEST_COST_MODEL]) {
      const full = costField(g, model, a);
      const early = costField(g, model, a, false, b);
      expect(early.cost[b]).toBe(full.cost[b]);
      expect(tracePath(early, b)).toEqual(tracePath(full, b));
      // A cell the full search settles after b stays unreached (Infinity) or, when only relaxed, is never cheaper.
      let farther = 0;
      for (let i = 0; i < full.cost.length; i++) {
        if (full.cost[i] > full.cost[b] && early.cost[i] === Infinity) farther++;
        expect(early.cost[i]).toBeGreaterThanOrEqual(full.cost[i]);
      }
      expect(farther).toBeGreaterThan(0);
    }
  });

  it("an unreachable target still ends with nothing", () => {
    const g = grid([line(BLOCKED, [20.25, 0, 20.25, 40])]);
    expect(costField(g, DEFAULT_COST_MODEL, cellOf(g, A), false, cellOf(g, B)).cost[cellOf(g, B)]).toBe(Infinity);
  });

  it("findRoutes finds the same routes as the full fields did (no alternatives, and two alternatives)", () => {
    const features = [area(BLOCKED_SOFT, rect(17, 11, 23, 29)), area(C.slow, rect(5, 30, 35, 38))];
    const g = grid(features);
    for (const alternatives of [0, 2]) {
      const routes = findRoutes(g, A, B, { model: DEFAULT_COST_MODEL, alternatives });
      // The oracle: fastest and shortest read from untruncated fields.
      const fast = costField(g, DEFAULT_COST_MODEL, cellOf(g, A));
      const short = costField(g, SHORTEST_COST_MODEL, cellOf(g, A));
      const fastest = routes.find((r) => r.fastest)!;
      // Straightening may only improve on the cell path.
      expect(fastest.costM).toBeLessThanOrEqual(fast.cost[cellOf(g, B)] + 1e-6);
      expect(fastest.costM).toBeGreaterThan(fast.cost[cellOf(g, B)] * 0.9);
      const shortest = routes.find((r) => r.shortest)!;
      expect(shortest.lengthM).toBeLessThanOrEqual(short.cost[cellOf(g, B)] + 1e-6);
      expect(shortest.lengthM).toBeGreaterThan(short.cost[cellOf(g, B)] * 0.9);
      expect(findRoutes(g, A, B, { model: DEFAULT_COST_MODEL, alternatives })).toEqual(routes);
    }
    expect(findRoutes(g, A, B, { model: SHORTEST_COST_MODEL, alternatives: 0 }).length).toBe(1);
  });
});

describe("a corridor confines the grid (docs/course-elevation.md §7.6)", () => {
  it("cells farther than half the width from the centre line are uncrossable; obstacles inside stay; a bend is followed", () => {
    const g = grid([area(BLOCKED, rect(19, 19.5, 21, 20.5)), area(C.marsh, rect(7, 21, 9, 23))]);
    confineToCorridor(g, [{ x: 5, y: 20 }, { x: 20, y: 30 }, { x: 35, y: 20 }], 2);
    expect(at(g, 5.25, 20.25)).toBe(C.forest);
    expect(at(g, 20.25, 30.25)).toBe(C.forest);
    expect(at(g, 20.25, 26.25)).toBe(BLOCKED);
    expect(at(g, 20.25, 20.25)).toBe(BLOCKED);
    expect(at(g, 5.25, 25.25)).toBe(BLOCKED);
    // The marsh on the first stretch: inside, its class kept.
    expect(at(g, 8.25, 22.25)).toBe(C.marsh);
  });

  it("a corridor narrower than a cell still holds a way along its line, slanted too; a few cells wide it runs straight", () => {
    const centre = [{ x: 5.1, y: 5.3 }, { x: 34.7, y: 31.9 }];
    const narrow = grid([]);
    confineToCorridor(narrow, centre, 0.01);
    expect(findRoutes(narrow, centre[0], centre[1], { model: DEFAULT_COST_MODEL, alternatives: 0 })).toHaveLength(1);
    const wide = grid([]);
    confineToCorridor(wide, centre, 1.5);
    const [r] = findRoutes(wide, centre[0], centre[1], { model: DEFAULT_COST_MODEL, alternatives: 0 });
    expect(r.lengthM).toBeCloseTo(Math.hypot(29.6, 26.6) * 10, 0);
  });

  it("a crossing point's opening opens the obstacle inside the corridor and nothing outside it", () => {
    const g = grid([line(BLOCKED, [20, 5, 20, 35])]);
    confineToCorridor(g, [{ x: 5, y: 20 }, { x: 35, y: 20 }], 0.5);
    openDisc(g, { x: 20, y: 20 }, 1, C.path);
    // The fence on the line is opened; the corridor's outside within the disc's reach stays closed.
    expect(at(g, 20.25, 20.25)).toBe(C.path);
    expect(at(g, 20.25, 21.25)).toBe(BLOCKED);
    expect(at(g, 19.25, 19.25 - 0.5)).toBe(BLOCKED);
    for (let i = 0; i < g.cls.length; i++) if (g.outside![i]) expect(g.cls[i]).toBe(BLOCKED);
  });
});
