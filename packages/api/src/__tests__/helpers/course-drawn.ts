/**
 * A stored course as the course layer draws it, in the GeoJSON shape the
 * dropped `courses.geometry` column held (E5): `Point` features
 * `{ symbolType, code, id }` per positioned item and `LineString` legs
 * `{ symbolType: "leg", from, to }` centre to centre, paper mm. The
 * sequence is `loadCourseSequences`' (the structure, else the columns), so
 * tests that asserted on the column assert on the same derivation.
 * Test-only: production reads the layer directly.
 */

import type { PrismaClient } from "../../generated/prisma/client.js";
import type { GeoJSONFeatureCollection } from "../../iof-course-parser.js";
import { editorCourseLayer, loadCourseSequences } from "../../course-geometry.js";

export async function drawnCourse(db: PrismaClient, eventId: bigint, courseUuid: string): Promise<GeoJSONFeatureCollection> {
  const entry = (await loadCourseSequences(db, eventId, [courseUuid])).get(courseUuid);
  const features: GeoJSONFeatureCollection["features"] = [];
  if (!entry) return { type: "FeatureCollection", features };
  const { sites, courses } = editorCourseLayer(courseUuid, entry.seq, entry.orderMode).derivation;
  const course = courses[0];
  if (!course) return { type: "FeatureCollection", features };
  const site = new Map(sites.map((s) => [s.id, s]));
  for (const e of course.sequence) {
    const s = site.get(e.siteId)!;
    features.push({ type: "Feature", geometry: { type: "Point", coordinates: [s.x, s.y] }, properties: { symbolType: e.role, code: s.code, id: s.code } });
  }
  for (const leg of course.legs) {
    features.push({
      type: "Feature",
      geometry: { type: "LineString", coordinates: leg.points.map((p) => [p.x, p.y]) },
      properties: { symbolType: "leg", from: site.get(leg.from)!.code, to: site.get(leg.to)!.code },
    });
  }
  return { type: "FeatureCollection", features };
}
