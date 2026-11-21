/**
 * Computed route alternatives in the editor (docs/course-elevation.md
 * §7.8): the list's entries with metres, climb and estimated time, the
 * pace they are timed at, the course's out-of-bounds objects as
 * obstacles, and the map's shapes.
 */

import type { course } from "@oxygen/shared";
import { BLOCKED, boxedFeature, type BoxedRouteFeature, type RouteAlternative } from "@oxygen/shared/src/route/index.js";
import type { TerrainSampler } from "@oxygen/shared/src/terrain/profile/index.js";
import type { ToolShape } from "../../components/MapViewer";
import { routeNumbers, type RouteNumbers } from "./leg-routes";

type Pt = { x: number; y: number };

/** The pace a route's cost is timed at: seconds per kilometre of flat, runnable forest. */
export const DEFAULT_PACE_S_PER_KM = 360;
export const PACE_MIN_S_PER_KM = 120;
export const PACE_MAX_S_PER_KM = 1800;
export const paceStorageKey = (nameId: string, courseId: number): string => `oxygen.editor.routePace.${nameId}.${courseId}`;

/** `"5:30"`, `"5.5"` or `"5,5"` (minutes per km) → seconds per km; null when it is no pace. */
export function parsePace(text: string): number | null {
  const t = text.trim();
  const clock = /^(\d{1,2}):([0-5]\d)$/.exec(t);
  const s = clock ? Number(clock[1]) * 60 + Number(clock[2]) : /^\d{1,2}([.,]\d+)?$/.test(t) ? Math.round(Number(t.replace(",", ".")) * 60) : Number.NaN;
  return Number.isFinite(s) && s >= PACE_MIN_S_PER_KM && s <= PACE_MAX_S_PER_KM ? s : null;
}

/** Seconds as `m:ss` (a pace, a route's time; hours stay minutes). */
export function formatClock(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export type AlternativeKind = "fastest" | "shortest" | "fastestShortest" | "alternative";

export interface AlternativeItem extends RouteNumbers {
  index: number;
  kind: AlternativeKind;
  /** The estimated time at the pace, seconds. */
  timeS: number;
  /** The route's interior vertices, as a stored route holds them. */
  interior: Pt[];
  points: Pt[];
}

/** The list (§7.8): each alternative with its own numbers and its time at `paceSPerKm`, the fastest first. */
export function alternativeItems(routes: readonly RouteAlternative[], mapScale: number, sampler: TerrainSampler | null, paceSPerKm: number): AlternativeItem[] {
  return routes.map((r, index) => ({
    index,
    kind: r.fastest && r.shortest ? "fastestShortest" : r.fastest ? "fastest" : r.shortest ? "shortest" : "alternative",
    timeS: Number.isFinite(r.costM) ? Math.round((r.costM * paceSPerKm) / 1000) : 0,
    interior: r.points.slice(1, -1),
    points: r.points,
    ...routeNumbers(r.points, mapScale, sampler),
  }));
}

/** The course's out-of-bounds objects as uncrossable features (course-layer.md §9.3: `oob_area`, a 708 `oob_line`). */
export function oobFeatures(objects: readonly course.CourseObject[]): BoxedRouteFeature[] {
  const out: BoxedRouteFeature[] = [];
  for (const o of objects) {
    const flat = (o.geometry as readonly Pt[]).flatMap((v) => [v.x, v.y]);
    if (o.kind === "oob_area" && flat.length >= 6) out.push(boxedFeature(BLOCKED, "area", [flat]));
    else if (o.kind === "oob_line" && ((o.props as { symbol?: string }).symbol ?? "708") === "708" && flat.length >= 4) out.push(boxedFeature(BLOCKED, "line", [flat]));
  }
  return out;
}

export const ALTERNATIVE_COLOR = "#c2410c";

/** The alternatives on the map, screen only: dashed, the pointed-at one solid. */
export function alternativeShapes(items: readonly AlternativeItem[], active: number | null): ToolShape[] {
  return items.map((a): ToolShape => ({
    kind: "line", points: a.points, dashed: a.index !== active, color: ALTERNATIVE_COLOR, widthPx: a.index === active ? 3 : 2,
    testId: "editor-route-alternative", data: { index: String(a.index), kind: a.kind },
  }));
}
