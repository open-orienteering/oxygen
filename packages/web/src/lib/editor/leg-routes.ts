/**
 * Leg routes in the editor (docs/course-elevation.md §7.4): the selected
 * leg's routes with their numbers, the chosen routes the course's
 * profile is read along, and the shapes the map draws for them.
 */

import { course } from "@oxygen/shared";
import { profileAlong, type TerrainSampler } from "@oxygen/shared/src/terrain/profile/index.js";
import type { ToolShape } from "../../components/MapViewer";
import { ELEVATION_CONFIDENT_MIN, shownM } from "./elevation";

type Pt = { x: number; y: number };

/** `legRoute.list`'s row. */
export interface LegRouteRow {
  id: string;
  fromControlId: number;
  toControlId: number;
  points: Pt[];
  source: "drawn" | "computed";
  model: string | null;
  chosen: boolean;
}

/** The chosen routes by the canvas's leg key (`"<from id>><to id>"`), for `course.routedLegs`. */
export function chosenRouteMap(routes: readonly LegRouteRow[] | undefined): Map<string, Pt[]> {
  const out = new Map<string, Pt[]>();
  for (const r of routes ?? []) if (r.chosen && r.points.length > 0) out.set(course.legPairKey(r.fromControlId, r.toControlId), r.points);
  return out;
}

/** The routes of one directed pair, as listed. */
export const pairRoutes = (routes: readonly LegRouteRow[] | undefined, from: number, to: number): LegRouteRow[] =>
  (routes ?? []).filter((r) => r.fromControlId === from && r.toControlId === to);

/** A polyline's numbers (§7.4): metres on the ground, and climb and descent on its own when a field is read. */
export interface RouteNumbers {
  lengthM: number;
  climbM: number | null;
  descentM: number | null;
  approx: boolean;
}

export function routeNumbers(points: readonly Pt[], mapScale: number, sampler: TerrainSampler | null): RouteNumbers {
  const lengthM = shownM((course.routeLengthMm(points) * mapScale) / 1000);
  if (!sampler || points.length < 2) return { lengthM, climbM: null, descentM: null, approx: false };
  const p = profileAlong(points, sampler);
  if (p.coverage <= 0) return { lengthM, climbM: null, descentM: null, approx: false };
  return { lengthM, climbM: shownM(p.climbM), descentM: shownM(p.descentM), approx: p.coverage < 0.995 || p.confidence < ELEVATION_CONFIDENT_MIN };
}

/** One entry of the leg's Routes list: the drawn line (`id` null) or a stored route. */
export interface RouteItem extends RouteNumbers {
  id: string | null;
  source: "line" | "drawn" | "computed";
  /** The one the leg's climb is read along. */
  chosen: boolean;
}

/** The list: the drawn line first — chosen while no route is — then the pair's routes. */
export function routeItems(o: { line: readonly Pt[]; routes: readonly LegRouteRow[]; mapScale: number; sampler: TerrainSampler | null }): RouteItem[] {
  if (o.line.length < 2) return [];
  const [from, to] = [o.line[0], o.line[o.line.length - 1]];
  return [
    { id: null, source: "line", chosen: !o.routes.some((r) => r.chosen), ...routeNumbers(o.line, o.mapScale, o.sampler) },
    ...o.routes.map((r): RouteItem => ({ id: r.id, source: r.source, chosen: r.chosen, ...routeNumbers(course.routePolyline(from, r.points, to), o.mapScale, o.sampler) })),
  ];
}

export const ROUTE_COLOR = "#0e7490";

/** A route being drawn: its vertices so far, between the leg's ends. */
export interface RouteDraft {
  from: number;
  to: number;
  fromPt: Pt;
  toPt: Pt;
  points: Pt[];
}

/**
 * The map's shapes for the selected leg (§7.4), screen only: each stored
 * route (the chosen one solid, the others dashed), or — while one is
 * drawn — the draft alone: what is placed solid, the rest through the
 * pointer to the leg's end dashed, a handle on every vertex.
 */
export function routeShapes(o: { from: Pt; to: Pt; routes: readonly LegRouteRow[]; draft: RouteDraft | null; hover: Pt | null }): ToolShape[] {
  if (o.draft) {
    const d = o.draft;
    const placed = [d.fromPt, ...d.points];
    const rest = [placed[placed.length - 1], ...(o.hover ? [o.hover] : []), d.toPt];
    return [
      ...(placed.length >= 2 ? [{ kind: "line", points: placed, color: ROUTE_COLOR, widthPx: 2.5, testId: "editor-route-draft" } as ToolShape] : []),
      { kind: "line", points: rest, dashed: true, color: ROUTE_COLOR, widthPx: 1.5, testId: "editor-route-draft-rest" },
      ...d.points.map((p, i): ToolShape => ({ kind: "handle", x: p.x, y: p.y, testId: "editor-route-draft-point", data: { index: String(i) } })),
    ];
  }
  return o.routes.map((r): ToolShape => ({
    kind: "line", points: course.routePolyline(o.from, r.points, o.to), dashed: !r.chosen, color: ROUTE_COLOR, widthPx: r.chosen ? 2.5 : 1.5,
    testId: "editor-route-line", data: { id: r.id, chosen: r.chosen ? "true" : "false" },
  }));
}
