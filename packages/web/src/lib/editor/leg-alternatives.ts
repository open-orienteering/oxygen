/**
 * Computed route alternatives in the editor (docs/course-elevation.md
 * §7.8): the list's entries with metres, climb and estimated time, the
 * pace they are timed at, the course's out-of-bounds objects as
 * obstacles, and the map's shapes.
 */

import { course as courseShared, type course } from "@oxygen/shared";
import { BLOCKED, boxedFeature, type BoxedRouteFeature, type RouteAlternative } from "@oxygen/shared/src/route/index.js";
import type { TerrainSampler } from "@oxygen/shared/src/terrain/profile/index.js";
import type { ToolShape } from "../../components/MapViewer";
import { routeNumbers, type RouteNumbers } from "./leg-routes";

type Pt = { x: number; y: number };

/** The course's expected winner pace while none is typed: seconds per kilometre of the course's length. */
export const DEFAULT_PACE_S_PER_KM = 360;
export const PACE_MIN_S_PER_KM = courseShared.WINNER_PACE_MIN_S;
export const PACE_MAX_S_PER_KM = courseShared.WINNER_PACE_MAX_S;

/**
 * The pace on flat, runnable forest that makes the course's winner time
 * come out (§7.8): the winner runs the course's length at the winner
 * pace, and that time is shared over the legs by their costs. Null
 * while the costs are not known or the course has no length.
 */
export function flatPaceSPerKm(winnerPaceSPerKm: number, courseLengthM: number, legCosts: readonly number[] | null): number | null {
  if (!legCosts || legCosts.length === 0 || !(courseLengthM > 0)) return null;
  const cost = legCosts.reduce((sum, c) => sum + c, 0);
  return cost > 0 && Number.isFinite(cost) ? (winnerPaceSPerKm * courseLengthM) / cost : null;
}

/** The course along the routes its legs are read along (§7.8): the metres on the ground and the winner's time at the pace. */
export function courseRouteTotals(legs: readonly { points: readonly Pt[]; routed: boolean }[] | null, mapScale: number | null, courseLengthM: number | null, winnerPaceSPerKm: number): { routeM: number; timeS: number | null; routed: number } | null {
  if (!legs || legs.length === 0 || !mapScale) return null;
  const mm = legs.reduce((sum, l) => sum + courseShared.routeLengthMm(l.points), 0);
  return {
    routeM: Math.round((mm * mapScale) / 1000),
    timeS: courseLengthM && courseLengthM > 0 ? Math.round((winnerPaceSPerKm * courseLengthM) / 1000) : null,
    routed: legs.filter((l) => l.routed).length,
  };
}

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
  /** The estimated time at the pace, seconds; null while the pace on flat forest is not known. */
  timeS: number | null;
  /** The route's interior vertices, as a stored route holds them. */
  interior: Pt[];
  points: Pt[];
}

/** The list (§7.8): each alternative with its own numbers and its time at `paceSPerKm` (on flat forest, `flatPaceSPerKm`), the fastest first. */
export function alternativeItems(routes: readonly RouteAlternative[], mapScale: number, sampler: TerrainSampler | null, paceSPerKm: number | null): AlternativeItem[] {
  return routes.map((r, index) => ({
    index,
    kind: r.fastest && r.shortest ? "fastestShortest" : r.fastest ? "fastest" : r.shortest ? "shortest" : "alternative",
    timeS: paceSPerKm !== null && Number.isFinite(r.costM) ? Math.round((r.costM * paceSPerKm) / 1000) : null,
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
/** One colour per alternative, in the list's order: told apart from each other, from the course purple and from the stored routes' cyan. */
export const ALTERNATIVE_COLORS = ["#c2410c", "#1d4ed8", "#15803d", "#854d0e"] as const;
export const alternativeColor = (index: number): string => ALTERNATIVE_COLORS[index % ALTERNATIVE_COLORS.length];

/** The alternatives on the map, screen only: solid over a white casing; with one active, it is wider and the others fade. */
export function alternativeShapes(items: readonly AlternativeItem[], active: number | null): ToolShape[] {
  const shape = (a: AlternativeItem): ToolShape => ({
    kind: "line", points: a.points, color: alternativeColor(a.index), widthPx: a.index === active ? 6 : 4, casingPx: 3,
    ...(active !== null && a.index !== active ? { opacity: 0.45 } : {}),
    testId: "editor-route-alternative", data: { index: String(a.index), kind: a.kind, active: a.index === active ? "true" : "false" },
  });
  // The active one last: over the others.
  return [...items.filter((a) => a.index !== active), ...items.filter((a) => a.index === active)].map(shape);
}

/** "412 m · ↑ 18 m · ~3:05": what a route is, on the map; climb and time only when known. */
export function alternativeLabelText(a: Pick<AlternativeItem, "lengthM" | "climbM" | "approx" | "timeS">): string {
  return [`${a.lengthM} m`, a.climbM !== null ? `${a.approx ? "≈ " : ""}↑ ${a.climbM} m` : null, a.timeS !== null ? `~${formatClock(a.timeS)}` : null].filter(Boolean).join(" · ");
}

/**
 * Where each alternative's label sits (paper mm): the point of its middle part (20–80 % along) farthest from every
 * other alternative, so the labels of routes that share their ends stand apart; alone, its midpoint.
 */
export function alternativeLabelAnchors(items: readonly Pick<AlternativeItem, "points">[]): Pt[] {
  const along = (pts: readonly Pt[], n: number): Pt[] => {
    const seg = pts.slice(1).map((q, i) => Math.hypot(q.x - pts[i].x, q.y - pts[i].y));
    const total = seg.reduce((s, d) => s + d, 0);
    if (total === 0) return [pts[0]];
    const out: Pt[] = [];
    for (let k = 0; k < n; k++) {
      let left = total * (0.2 + (0.6 * k) / Math.max(1, n - 1));
      let i = 0;
      while (i < seg.length - 1 && left > seg[i]) { left -= seg[i]; i++; }
      const f = seg[i] > 0 ? Math.min(1, left / seg[i]) : 0;
      out.push({ x: pts[i].x + (pts[i + 1].x - pts[i].x) * f, y: pts[i].y + (pts[i + 1].y - pts[i].y) * f });
    }
    return out;
  };
  const toSegment = (p: Pt, a: Pt, b: Pt): number => {
    const dx = b.x - a.x, dy = b.y - a.y, len = dx * dx + dy * dy;
    const f = len > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len)) : 0;
    return Math.hypot(p.x - (a.x + dx * f), p.y - (a.y + dy * f));
  };
  const toLine = (p: Pt, pts: readonly Pt[]): number => pts.slice(1).reduce((m, q, i) => Math.min(m, toSegment(p, pts[i], q)), Infinity);
  return items.map((item, k) => {
    if (item.points.length < 2) return item.points[0] ?? { x: 0, y: 0 };
    const cands = along(item.points, 13);
    const others = items.filter((_, j) => j !== k && items[j].points.length >= 2);
    if (others.length === 0) return cands[Math.floor(cands.length / 2)];
    let best = cands[0], bestD = -1;
    for (const c of cands) {
      const d = Math.min(...others.map((o) => toLine(c, o.points)));
      if (d > bestD) { best = c; bestD = d; }
    }
    return best;
  });
}
