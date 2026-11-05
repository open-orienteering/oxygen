/**
 * The course layer projected onto today's `courses.geometry` shape
 * (docs/course-layer.md §4) — the compatibility artifact C5 writes for
 * consumers not yet ported: `Point` features `{ symbolType, code, id }`
 * (+ `cuts` on controls), `LineString` legs `{ symbolType: "leg", from,
 * to }` centre to centre (+ `gaps`). Course-level lines and areas are course objects (§8), not in this artifact. Paper mm.
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
    const properties: Record<string, unknown> = { symbolType: "leg", from, to };
    if (leg.gaps.length > 0) properties.gaps = leg.gaps.map((g) => ({ from: g.from, to: g.to }));
    features.push({ type: "Feature", geometry: { type: "LineString", coordinates: leg.points.map(xy) }, properties });
  }
  return { type: "FeatureCollection", features };
}
