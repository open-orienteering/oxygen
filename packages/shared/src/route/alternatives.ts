/**
 * Route alternatives between two points (docs/course-elevation.md §7.7):
 * the fastest route under a cost model, up to a few others that are
 * nearly as fast and run somewhere else, and the shortest legal route.
 */

import { CLASS_INDEX, SHORTEST_COST_MODEL, isBlockedClass, type CostModel } from "./cost-model.js";
import { cellOf, centreOf, heightAtPoint, nearestPassable, openDisc, type RouteGrid, type RoutePoint } from "./grid.js";
import { costField, tracePath, type CostField } from "./search.js";

export interface RouteAlternative {
  /** The whole polyline, `from` first and `to` last, paper mm. */
  points: RoutePoint[];
  lengthM: number;
  /** Flat-forest metres under the model the search ran with; times a pace it is the time. */
  costM: number;
  /** The fastest route under the model. */
  fastest: boolean;
  /** The shortest route that crosses nothing uncrossable. */
  shortest: boolean;
}

export interface RouteSearchOptions {
  model: CostModel;
  /** Others besides the fastest (default 2). */
  alternatives?: number;
  /** An alternative costs at most this times the fastest (default 1.3). */
  maxCostRatio?: number;
  /** An alternative shares at most this much of its length with the routes already kept (default 0.5). */
  maxShared?: number;
  /** Points the route must pass in order — a leg's crossing point: the obstacle is opened around each. */
  via?: readonly RoutePoint[];
  /** Radius opened around a `via` point, paper mm (default 1). */
  viaReachMm?: number;
}

const TRIES = 40;

/**
 * The cost of a straight run a → b sampled every half cell: each step's
 * ground length × the mean class factor of the cells at its ends × the
 * slope factor of the height difference over that step. Infinity when
 * it touches an uncrossable cell or passes between two at a corner.
 */
export function segmentCost(g: RouteGrid, model: CostModel, a: RoutePoint, b: RoutePoint): number {
  const lenMm = Math.hypot(b.x - a.x, b.y - a.y);
  const steps = Math.max(1, Math.ceil(lenMm / (g.cellMm / 2)));
  const stepM = (lenMm / steps) * g.groundMPerMm;
  let cost = 0;
  let prev = cellOf(g, a);
  if (isBlockedClass(g.cls[prev])) return Infinity;
  let prevZ = heightAtPoint(g, a);
  for (let s = 1; s <= steps; s++) {
    const p = { x: a.x + ((b.x - a.x) * s) / steps, y: a.y + ((b.y - a.y) * s) / steps };
    const cell = cellOf(g, p);
    if (isBlockedClass(g.cls[cell])) return Infinity;
    if (cell !== prev) {
      const pc = prev % g.cols, pr = (prev - pc) / g.cols, cc = cell % g.cols, cr = (cell - cc) / g.cols;
      if (pc !== cc && pr !== cr && (isBlockedClass(g.cls[pr * g.cols + cc]) || isBlockedClass(g.cls[cr * g.cols + pc]))) return Infinity;
    }
    const z = heightAtPoint(g, p);
    if (stepM > 0) {
      const dz = z - prevZ;
      cost += stepM * ((model.classFactor[g.cls[prev]] + model.classFactor[g.cls[cell]]) / 2) * (Number.isNaN(dz) ? 1 : model.slopeFactor(dz / stepM));
    }
    prev = cell;
    prevZ = z;
  }
  return cost;
}

/** A polyline's cost under a model, vertex to vertex. */
export function polylineCost(g: RouteGrid, model: CostModel, points: readonly RoutePoint[]): number {
  let cost = 0;
  for (let i = 1; i < points.length; i++) cost += segmentCost(g, model, points[i - 1], points[i]);
  return cost;
}

/**
 * A grid path as a polyline with the grid's staircase taken out: from
 * each kept vertex the straight run to the farthest later one that costs
 * no more than the path between them. The path's ends are `from` and
 * `to` where they lie in the path's end cells; an end standing on an
 * uncrossable cell stays out of the smoothing (`stubs`).
 */
export function smoothPath(g: RouteGrid, model: CostModel, cells: readonly number[], from: RoutePoint, to: RoutePoint): RoutePoint[] {
  const pts = cells.map((c) => centreOf(g, c));
  if (cellOf(g, from) === cells[0]) pts[0] = from;
  if (cellOf(g, to) === cells[cells.length - 1]) pts[pts.length - 1] = to;
  // Cost along the path up to each vertex.
  const upTo = new Float64Array(pts.length);
  for (let i = 1; i < pts.length; i++) upTo[i] = upTo[i - 1] + segmentCost(g, model, pts[i - 1], pts[i]);
  const shortcut = (i: number, j: number): boolean => {
    const c = segmentCost(g, model, pts[i], pts[j]);
    return Number.isFinite(c) && c <= (upTo[j] - upTo[i]) * 1.0005 + 1e-9;
  };
  const out: RoutePoint[] = [pts[0]];
  let i = 0;
  while (i < pts.length - 1) {
    let j = i + 1;
    // Doubling, then stepping back: far shortcuts are tried first where they hold.
    let span = 2;
    while (i + span < pts.length && shortcut(i, i + span)) {
      j = i + span;
      span *= 2;
    }
    for (let k = Math.min(pts.length - 1, i + span - 1); k > j; k--) {
      if (shortcut(i, k)) { j = k; break; }
    }
    out.push(pts[j]);
    i = j;
  }
  return out;
}

/** A route's cost: the model's along the polyline; a stretch that touches an uncrossable cell — the stub to a control standing on one — counts its length. */
export function routeCost(g: RouteGrid, model: CostModel, points: readonly RoutePoint[]): number {
  let cost = 0;
  for (let i = 1; i < points.length; i++) {
    const c = segmentCost(g, model, points[i - 1], points[i]);
    cost += Number.isFinite(c) ? c : Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y) * g.groundMPerMm;
  }
  return cost;
}

function lengthM(g: RouteGrid, points: readonly RoutePoint[]): number {
  let mm = 0;
  for (let i = 1; i < points.length; i++) mm += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
  return mm * g.groundMPerMm;
}

/** Marks every cell within `radius` cells of the path's cells. */
function markCorridor(g: RouteGrid, cells: readonly number[], radius: number, into: Uint8Array): void {
  for (const cell of cells) {
    const c0 = cell % g.cols, r0 = (cell - c0) / g.cols;
    for (let r = Math.max(0, r0 - radius); r <= Math.min(g.rows - 1, r0 + radius); r++) {
      for (let c = Math.max(0, c0 - radius); c <= Math.min(g.cols - 1, c0 + radius); c++) into[r * g.cols + c] = 1;
    }
  }
}

const sharedShare = (cells: readonly number[], taken: Uint8Array): number => cells.reduce((n, c) => n + taken[c], 0) / Math.max(1, cells.length);

interface Found { cells: number[]; fastest: boolean; shortest: boolean }

/** One stretch a → b: the fastest path, the alternatives, the shortest. Empty when b cannot be reached. */
function searchStretch(g: RouteGrid, a: number, b: number, o: Required<Pick<RouteSearchOptions, "model" | "alternatives" | "maxCostRatio" | "maxShared">>): Found[] {
  const fwd = costField(g, o.model, a);
  if (!Number.isFinite(fwd.cost[b])) return [];
  const best = tracePath(fwd, b).reverse();
  const found: Found[] = [{ cells: best, fastest: true, shortest: false }];
  const ac = a % g.cols, ar = (a - ac) / g.cols, bc = b % g.cols, br = (b - bc) / g.cols;
  // "Somewhere else" is measured against the leg: a corridor of 6 % of its straight length, at least 3 cells.
  const radius = Math.max(3, Math.round(Math.hypot(bc - ac, br - ar) * 0.06));
  const taken = new Uint8Array(g.cols * g.rows);
  markCorridor(g, best, radius, taken);
  if (o.alternatives > 0) {
    const back: CostField = costField(g, o.model, b, true);
    const tried = taken.slice();
    const limit = fwd.cost[b] * o.maxCostRatio;
    for (let t = 0; t < TRIES && found.length < 1 + o.alternatives; t++) {
      // The cheapest cell to run through that no route tried so far comes near.
      let via = -1, viaCost = limit;
      for (let i = 0; i < tried.length; i++) {
        if (tried[i]) continue;
        const c = fwd.cost[i] + back.cost[i];
        if (c <= viaCost) { via = i; viaCost = c; }
      }
      if (via < 0) break;
      const cells = [...tracePath(fwd, via).reverse(), ...tracePath(back, via).slice(1)];
      if (sharedShare(cells, taken) <= o.maxShared) {
        found.push({ cells, fastest: false, shortest: false });
        markCorridor(g, cells, radius, taken);
      }
      markCorridor(g, cells, radius, tried);
    }
  }
  // The shortest legal route: distance only.
  const shortField = costField(g, SHORTEST_COST_MODEL, a);
  const shortest = tracePath(shortField, b).reverse();
  const same = found.find((f) => {
    const own = new Uint8Array(g.cols * g.rows);
    markCorridor(g, f.cells, Math.max(2, Math.round(radius / 2)), own);
    return sharedShare(shortest, own) >= 0.9;
  });
  if (same) same.shortest = true;
  else found.push({ cells: shortest, fastest: false, shortest: true });
  return found;
}

/** The cells a polyline passes, sampled every half cell. */
function polylineCells(g: RouteGrid, points: readonly RoutePoint[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / (g.cellMm / 2)));
    for (let s = i === 1 ? 0 : 1; s <= steps; s++) out.push(cellOf(g, { x: a.x + ((b.x - a.x) * s) / steps, y: a.y + ((b.y - a.y) * s) / steps }));
  }
  return out;
}

/**
 * The routes as they are after straightening: an alternative that now
 * runs where a kept route runs is dropped, a shortest route that does
 * hands its mark to that route.
 */
function distinctRoutes(g: RouteGrid, routes: RouteAlternative[], from: RoutePoint, to: RoutePoint, maxShared: number): RouteAlternative[] {
  const radius = Math.max(3, Math.round((Math.hypot(to.x - from.x, to.y - from.y) / g.cellMm) * 0.06));
  const kept: { route: RouteAlternative; near: Uint8Array }[] = [];
  for (const route of routes) {
    const cells = polylineCells(g, route.points);
    const twin = kept.find((k) => sharedShare(cells, k.near) > (route.shortest && !route.fastest ? 0.9 : maxShared));
    if (twin && !route.fastest) {
      if (route.shortest) twin.route.shortest = true;
      continue;
    }
    const near = new Uint8Array(g.cols * g.rows);
    markCorridor(g, cells, radius, near);
    kept.push({ route, near });
  }
  return kept.map((k) => k.route);
}

/**
 * The route alternatives from `from` to `to` on the grid; empty when
 * there is no way. An end on an uncrossable cell starts from the
 * nearest passable one. With `via` points the fastest and the shortest
 * through them are returned, without other alternatives.
 */
export function findRoutes(grid: RouteGrid, from: RoutePoint, to: RoutePoint, options: RouteSearchOptions): RouteAlternative[] {
  const o = { model: options.model, alternatives: options.alternatives ?? 2, maxCostRatio: options.maxCostRatio ?? 1.3, maxShared: options.maxShared ?? 0.5 };
  const via = options.via ?? [];
  const g: RouteGrid = via.length > 0 ? { ...grid, cls: grid.cls.slice() } : grid;
  for (const p of via) openDisc(g, p, options.viaReachMm ?? 1, CLASS_INDEX.path);
  const stops = [from, ...via, to];
  const cells = stops.map((p) => nearestPassable(g, cellOf(g, p)));
  if (cells.some((c) => c < 0)) return [];
  const finish = (parts: { cells: number[]; from: RoutePoint; to: RoutePoint; model: CostModel }[], fastest: boolean, shortest: boolean): RouteAlternative => {
    const points: RoutePoint[] = [];
    const add = (p: RoutePoint) => { const last = points[points.length - 1]; if (!last || last.x !== p.x || last.y !== p.y) points.push(p); };
    for (const part of parts) {
      // A control on an uncrossable cell: the stub between it and the path's first passable cell is added as it is.
      add(part.from);
      for (const p of smoothPath(g, part.model, part.cells, part.from, part.to)) add(p);
      add(part.to);
    }
    return { points, lengthM: lengthM(g, points), costM: routeCost(g, o.model, points), fastest, shortest };
  };
  if (via.length === 0) {
    const routes = searchStretch(g, cells[0], cells[1], o).map((f) =>
      finish([{ cells: f.cells, from, to, model: f.fastest || !f.shortest ? o.model : SHORTEST_COST_MODEL }], f.fastest, f.shortest));
    return distinctRoutes(g, routes, from, to, o.maxShared);
  }
  // Through the crossing points: the fastest of each stretch joined, and the shortest of each stretch joined.
  const stretches = cells.slice(1).map((b, i) => searchStretch(g, cells[i], b, { ...o, alternatives: 0 }));
  if (stretches.some((s) => s.length === 0)) return [];
  const pick = (want: "fastest" | "shortest") => stretches.map((s, i) => {
    const f = s.find((x) => x[want])!;
    return { cells: f.cells, from: stops[i], to: stops[i + 1], model: want === "shortest" && !f.fastest ? SHORTEST_COST_MODEL : o.model };
  });
  const allSame = stretches.every((s) => s.length === 1);
  const fastest = finish(pick("fastest"), true, allSame);
  return allSame ? [fastest] : [fastest, finish(pick("shortest"), false, true)];
}
