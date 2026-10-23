/**
 * The course layer projected onto today's `courses.geometry` shape
 * (docs/course-layer.md §4) — the compatibility artifact C5 writes for
 * consumers not yet ported: `Point` features `{ symbolType, code, id }`
 * (+ `cuts` on controls), `LineString` legs `{ symbolType: "leg", from,
 * to }` centre to centre (+ `gaps`; authored pieces as `preclipped`),
 * course-level lines and areas under their imported names. Paper mm.
 */

import type { CourseLayer } from "./types.js";

export interface CourseGeoJsonFeature {
  type: "Feature";
  geometry: { type: "Point"; coordinates: [number, number] } | { type: "LineString"; coordinates: [number, number][] } | { type: "Polygon"; coordinates: [number, number][][] };
  properties: Record<string, unknown>;
}

export interface CourseGeoJson {
  type: "FeatureCollection";
  features: CourseGeoJsonFeature[];
}

const EXTRA_TYPE = { marked_route: "marked_route", restricted_line: "restricted_line", forbidden_route: "forbidden_route", oob_area: "restricted_area" } as const;

/** One course of the layer (by id; default the first) as a FeatureCollection. */
export function courseLayerGeoJson(layer: Pick<CourseLayer, "derivation">, courseId?: string): CourseGeoJson {
  const { sites, courses } = layer.derivation;
  const course = courseId === undefined ? courses[0] : courses.find((c) => c.id === courseId);
  const features: CourseGeoJsonFeature[] = [];
  if (!course) return { type: "FeatureCollection", features };
  const site = new Map(sites.map((s) => [s.id, s]));
  const xy = (p: { x: number; y: number }): [number, number] => [p.x, p.y];

  for (const e of course.sequence) {
    const s = site.get(e.siteId)!;
    const properties: Record<string, unknown> = { symbolType: e.role, code: s.code, id: s.code };
    if (e.role === "control" && s.cuts.length > 0) properties.cuts = s.cuts.map((g) => ({ start: g.start, end: g.end }));
    features.push({ type: "Feature", geometry: { type: "Point", coordinates: xy(s) }, properties });
  }
  for (const leg of course.legs) {
    const from = site.get(leg.from)!.code, to = site.get(leg.to)!.code;
    if (leg.preclipped) {
      for (const piece of leg.pieces) {
        features.push({ type: "Feature", geometry: { type: "LineString", coordinates: piece.map(xy) }, properties: { symbolType: "leg", from, to, preclipped: true } });
      }
      continue;
    }
    const properties: Record<string, unknown> = { symbolType: "leg", from, to };
    if (leg.gaps.length > 0) properties.gaps = leg.gaps.map((g) => ({ from: g.from, to: g.to }));
    features.push({ type: "Feature", geometry: { type: "LineString", coordinates: leg.points.map(xy) }, properties });
  }
  for (const x of course.extras) {
    const geometry: CourseGeoJsonFeature["geometry"] = x.kind === "oob_area"
      ? { type: "Polygon", coordinates: [[...x.points.map(xy), xy(x.points[0])]] }
      : { type: "LineString", coordinates: x.points.map(xy) };
    features.push({ type: "Feature", geometry, properties: { symbolType: EXTRA_TYPE[x.kind] } });
  }
  return { type: "FeatureCollection", features };
}
