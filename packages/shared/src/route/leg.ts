/**
 * Route alternatives for a leg of a course (docs/course-elevation.md
 * §7.6–7.7): the map document's objects as classified features, the
 * window of the map a leg is searched in, and the search itself.
 */

import { OBJECT_TYPE } from "../map-document/index.js";
import type { EffectiveDocument } from "../map-document/patch.js";
import { isAppliedMatch } from "../map-document/render-bridge.js";
import { flattenObject } from "../terrain/graph/flatten.js";
import { findRoutes, polylineCost, routeCost, segmentCost, type RouteAlternative } from "./alternatives.js";
import { SHORTEST_COST_MODEL, costClassOfCode, costModelNote, type CostModel, type CostModelNote } from "./cost-model.js";
import { buildRouteGrid, confineToCorridor, type RouteFeature, type RoutePoint } from "./grid.js";

/** A feature with its bounds, paper mm. */
export interface BoxedRouteFeature extends RouteFeature {
  box: readonly [minX: number, minY: number, maxX: number, maxY: number];
}

function boxOf(parts: readonly ArrayLike<number>[]): [number, number, number, number] {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of parts) {
    for (let i = 0; i + 1 < p.length; i += 2) {
      if (p[i] < minX) minX = p[i];
      if (p[i] > maxX) maxX = p[i];
      if (p[i + 1] < minY) minY = p[i + 1];
      if (p[i + 1] > maxY) maxY = p[i + 1];
    }
  }
  return [minX, minY, maxX, maxY];
}

export const boxedFeature = (cls: number, kind: "area" | "line", parts: readonly ArrayLike<number>[]): BoxedRouteFeature => ({ cls, kind, parts, box: boxOf(parts) });

/**
 * The document's line and area objects whose symbol has a cost class —
 * the applied match's code, else the source code, as the checks read
 * it (course-layer.md §9.3) — with curves cut into chords and an area's
 * holes kept. Hidden symbols and objects a patch hides are skipped.
 */
export function routeFeaturesOfDocument(doc: Pick<EffectiveDocument, "header" | "attrs" | "coords" | "flags" | "coordStart" | "hidden">): BoxedRouteFeature[] {
  const classes = doc.header.symbols.map((s): number | null => {
    if (s.hidden) return null;
    return costClassOfCode(isAppliedMatch(s.match) ? s.match!.canonicalId!.slice(s.match!.canonicalId!.indexOf(":") + 1) : s.code);
  });
  const out: BoxedRouteFeature[] = [];
  for (let i = 0; i < doc.attrs.symbolIdx.length; i++) {
    const type = doc.attrs.type[i];
    if ((type !== OBJECT_TYPE.line && type !== OBJECT_TYPE.area) || doc.hidden?.[i]) continue;
    const cls = classes[doc.attrs.symbolIdx[i]];
    if (cls === null || cls === undefined) continue;
    const parts = flattenObject(doc as Parameters<typeof flattenObject>[0], i).filter((p) => p.length >= 4);
    if (parts.length > 0) out.push(boxedFeature(cls, type === OBJECT_TYPE.area ? "area" : "line", parts));
  }
  return out;
}

export interface LegRouteRequest {
  from: RoutePoint;
  to: RoutePoint;
  /** The leg's crossing point, when it has one. */
  via?: readonly RoutePoint[];
  groundMPerMm: number;
  /** Features beside the document's: the course's out-of-bounds objects. */
  extra?: readonly BoxedRouteFeature[];
  /** The leg's corridor (§7.6): its centre line (the drawn leg, bends flattened) and half its width, paper mm. Routes stay inside. */
  corridor?: LegCorridor;
  alternatives?: number;
}

/** A corridor as the search reads it: the inside is every point within `halfMm` of `line`. */
export interface LegCorridor {
  line: readonly RoutePoint[];
  halfMm: number;
}

/** A corridor's half width in paper mm from its width in metres on the ground; null for a width that is not positive. */
export const corridorHalfMm = (widthM: number, groundMPerMm: number): number | null =>
  Number.isFinite(widthM) && widthM > 0 && groundMPerMm > 0 ? widthM / groundMPerMm / 2 : null;

export interface LegRouteResult {
  routes: RouteAlternative[];
  cellMm: number;
  cells: number;
  /** The model the routes were found under, and how much of it is measured (§7.9). */
  model: CostModelNote;
}

/** The finest cell, paper mm. */
export const ROUTE_CELL_MM = 0.25;
/** The window's cell count is kept under this by coarser cells. */
export const ROUTE_MAX_CELLS = 1_200_000;
/** The window reaches this share of the leg's length beyond its ends, and at least `ROUTE_MIN_PAD_MM`. */
export const ROUTE_PAD_SHARE = 0.5;
export const ROUTE_MIN_PAD_MM = 10;

/** Beyond a corridor's edge the window reaches this far, paper mm: nothing outside is searched. */
export const ROUTE_CORRIDOR_PAD_MM = 1;

/** The window a leg is searched in and its cell size; a corridor leg's is the corridor's, so its cells are finer. */
export function legWindow(req: Pick<LegRouteRequest, "from" | "to" | "via" | "corridor">): { bounds: { minX: number; minY: number; maxX: number; maxY: number }; cellMm: number } {
  const pts = [req.from, ...(req.via ?? []), req.to, ...(req.corridor?.line ?? [])];
  const pad = req.corridor
    ? req.corridor.halfMm + ROUTE_CORRIDOR_PAD_MM
    : Math.max(ROUTE_MIN_PAD_MM, Math.hypot(req.to.x - req.from.x, req.to.y - req.from.y) * ROUTE_PAD_SHARE);
  const bounds = {
    minX: Math.min(...pts.map((p) => p.x)) - pad, minY: Math.min(...pts.map((p) => p.y)) - pad,
    maxX: Math.max(...pts.map((p) => p.x)) + pad, maxY: Math.max(...pts.map((p) => p.y)) + pad,
  };
  const area = (bounds.maxX - bounds.minX) * (bounds.maxY - bounds.minY);
  return { bounds, cellMm: Math.max(ROUTE_CELL_MM, Math.sqrt(area / ROUTE_MAX_CELLS)) };
}

/**
 * The grid a leg is searched and costed on: `legWindow`'s cell size, its
 * bounds grown to hold `cover` (a GPS track of the leg, §7.9) with 2 mm
 * to spare. Without `cover` it is the leg's window.
 */
export function legGridCovering(
  features: readonly BoxedRouteFeature[],
  heightAt: ((p: RoutePoint) => number | null) | null,
  req: Pick<LegRouteRequest, "from" | "to" | "via" | "groundMPerMm" | "extra" | "corridor">,
  cover?: { minX: number; minY: number; maxX: number; maxY: number },
) {
  const { bounds: window, cellMm } = legWindow(req);
  const bounds = cover
    ? { minX: Math.min(window.minX, cover.minX - 2), minY: Math.min(window.minY, cover.minY - 2), maxX: Math.max(window.maxX, cover.maxX + 2), maxY: Math.max(window.maxY, cover.maxY + 2) }
    : window;
  const inWindow = (f: BoxedRouteFeature) => f.box[2] >= bounds.minX && f.box[0] <= bounds.maxX && f.box[3] >= bounds.minY && f.box[1] <= bounds.maxY;
  const grid = buildRouteGrid({ bounds, cellMm, groundMPerMm: req.groundMPerMm, features: [...features, ...(req.extra ?? [])].filter(inWindow), heightAt });
  if (req.corridor && req.corridor.line.length > 0) confineToCorridor(grid, req.corridor.line, req.corridor.halfMm);
  return grid;
}

const legGrid = (features: readonly BoxedRouteFeature[], heightAt: ((p: RoutePoint) => number | null) | null, req: LegRouteRequest) => legGridCovering(features, heightAt, req);

/**
 * The shortest legal route of a leg (docs/course-elevation.md §7.5): its
 * interior vertices — none when the straight line crosses nothing
 * uncrossable, the line being that route — or null when there is no way.
 * Heights are not read: the shortest route is the same on any slope.
 * A corridor leg (§7.6) follows its centre: where the centre line crosses
 * nothing uncrossable it is the route (no vertices); else the shortest way
 * inside the corridor; null when the corridor holds no way.
 */
export function shortestLegRoute(features: readonly BoxedRouteFeature[], req: Omit<LegRouteRequest, "alternatives">): RoutePoint[] | null {
  const grid = legGrid(features, null, req);
  const stops = [req.from, ...(req.via ?? []), req.to];
  if (req.corridor && req.corridor.line.length >= 2 && Number.isFinite(polylineCost(grid, SHORTEST_COST_MODEL, req.corridor.line))) return [];
  // The line itself, where it is legal: no search. Through a crossing point the obstacle is opened by the search.
  if (stops.length === 2 && Number.isFinite(segmentCost(grid, SHORTEST_COST_MODEL, req.from, req.to))) return [];
  const routes = findRoutes(grid, req.from, req.to, { model: SHORTEST_COST_MODEL, alternatives: 0, via: req.via });
  const route = routes.find((r) => r.shortest) ?? routes[0];
  return route ? route.points.slice(1, -1) : null;
}

/**
 * What a leg costs along a given polyline (its drawn line or its chosen
 * route), in the model's flat-forest metres (§7.7); a stretch over an
 * uncrossable cell counts its length. The window is the polyline's.
 */
export function legPolylineCost(
  features: readonly BoxedRouteFeature[],
  heightAt: ((p: RoutePoint) => number | null) | null,
  leg: { points: readonly RoutePoint[]; groundMPerMm: number; extra?: readonly BoxedRouteFeature[] },
  model: CostModel,
): number {
  if (leg.points.length < 2) return 0;
  const req = { from: leg.points[0], to: leg.points[leg.points.length - 1], via: leg.points.slice(1, -1), groundMPerMm: leg.groundMPerMm, extra: leg.extra };
  return routeCost(legGrid(features, heightAt, req), model, leg.points);
}

export function findLegRoutes(
  features: readonly BoxedRouteFeature[],
  heightAt: ((p: RoutePoint) => number | null) | null,
  req: LegRouteRequest,
  model: CostModel,
): LegRouteResult {
  const grid = legGrid(features, heightAt, req);
  const routes = findRoutes(grid, req.from, req.to, { model, alternatives: req.alternatives, via: req.via });
  return { routes, cellMm: grid.cellMm, cells: grid.cols * grid.rows, model: costModelNote(model) };
}
