/**
 * The server's advisory checks of a course (docs/course-layer.md §9.4):
 * the shared `courseChecks` over the stored sequence, the event's sites,
 * the map scale, the pinned document's obstacles and the course objects
 * in scope, plus `DESCRIPTION_STALE` — an autodetected description that
 * the map no longer suggests at the site. The layout codes
 * (`CONTROL_OUTSIDE_SHEET`, `NUMBER_*`) are the editor's: they need the
 * viewer's placement and the resolved sheets.
 */

import { course, type ControlDescription } from "@oxygen/shared";
import type { PrismaClient, Prisma } from "./generated/prisma/client.js";
import { displayCode, publicControlId } from "./control-id.js";
import { loadCourseSequences } from "./course-geometry.js";
import { classesByCourse, loadCourseObjects, objectsInScope } from "./course-objects.js";
import { rowKind } from "./course-structure.js";
import { describeAt, descriptionsEqual } from "./description-autodetect.js";
import { loadEventCrs } from "./event-crs.js";
import { loadEventCheckDocument, loadEventMapObjects } from "./event-map-objects.js";

type Db = PrismaClient | Prisma.TransactionClient;

/** A check on the tRPC wire: public control ids (docs/course-editor.md "API"). */
export interface WireCourseCheck {
  code: course.CourseCheckCode;
  siteIds: number[];
  leg?: { from: number; to: number; index: number };
  at: { x: number; y: number };
  params?: Record<string, string | number>;
}

const ROLE = { Start: "start", Control: "control", Finish: "finish" } as const;

/** The checks of one course (UUID); empty for a removed or unknown course. */
export async function courseChecksFor(db: Db, eventId: bigint, courseUuid: string): Promise<WireCourseCheck[]> {
  const sequence = (await loadCourseSequences(db, eventId, [courseUuid])).get(courseUuid);
  if (!sequence) return [];
  const rows = await db.control.findMany({
    where: { eventId, removed: false },
    orderBy: { seq: "asc" },
    select: { id: true, seq: true, codes: true, name: true, kind: true, status: true, xpos: true, ypos: true, description: true, descriptionSource: true },
  });
  const publicOf = new Map(rows.map((r) => [r.id, publicControlId(r)]));
  const sites: course.CheckSite[] = rows.map((r) => ({
    id: r.id,
    code: displayCode(r),
    codes: r.codes.split(";").map((c) => parseInt(c.trim(), 10)).filter((n) => Number.isFinite(n)),
    kind: rowKind(r),
    x: r.xpos,
    y: r.ypos,
    description: (r.description as ControlDescription | null) ?? null,
  }));
  const structure: course.CourseStructure = {
    version: 1,
    id: courseUuid,
    orderMode: sequence.orderMode,
    // The leg as drawn (§9.3): through its bends (§10.1) and its crossing point (§10.3).
    items: sequence.seq.map((s) => {
      const leg: course.CourseLegProps = {};
      if (s.leg?.bends?.length) leg.bends = s.leg.bends;
      if (s.via) leg.crossing = { controlId: s.via.id };
      return { siteId: s.id, role: ROLE[s.type], ...(Object.keys(leg).length ? { leg } : {}) };
    }),
  };
  const [crs, document, objects, byCourse] = await Promise.all([
    loadEventCrs(db, eventId),
    loadEventCheckDocument(db, eventId),
    loadCourseObjects(db, eventId),
    classesByCourse(db, eventId),
  ]);
  const checks = course.courseChecks({
    structure,
    sites,
    document,
    sheets: null,
    objects: objectsInScope(objects, courseUuid, byCourse),
    derivation: null,
    mapScale: crs?.mapScale ?? null,
  });

  // DESCRIPTION_STALE: an autodetected description the map now describes differently.
  const auto = new Set(rows.filter((r) => r.descriptionSource === "auto" && r.description).map((r) => r.id));
  const candidates = [...new Set(structure.items.filter((i) => i.role === "control" && auto.has(i.siteId)).map((i) => i.siteId))];
  if (candidates.length > 0) {
    const mapObjects = await loadEventMapObjects(db, eventId);
    if (mapObjects && mapObjects.length > 0) {
      const siteById = new Map(sites.map((s) => [s.id, s]));
      const rowById = new Map(rows.map((r) => [r.id, r]));
      for (const id of candidates) {
        const s = siteById.get(id)!;
        const now = describeAt(mapObjects, s.x, s.y);
        if (!descriptionsEqual(now, rowById.get(id)!.description as ControlDescription | null)) {
          checks.push({ code: "DESCRIPTION_STALE", siteIds: [id], at: { x: s.x, y: s.y }, params: { code: s.code, ...(now?.d ? { suggested: now.d } : {}) } });
        }
      }
    }
  }

  const rank = new Map<string, number>(course.COURSE_CHECK_CODES.map((c, i) => [c, i]));
  return checks
    .map((c, i) => ({ c, i }))
    .sort((p, q) => rank.get(p.c.code)! - rank.get(q.c.code)! || p.i - q.i)
    .map(({ c }) => ({
      code: c.code,
      siteIds: c.siteIds.map((id) => publicOf.get(id)!),
      ...(c.leg ? { leg: { from: publicOf.get(c.leg.from)!, to: publicOf.get(c.leg.to)!, index: c.leg.index } } : {}),
      at: c.at,
      ...(c.params ? { params: c.params } : {}),
    }));
}
