/**
 * Leg routes on the server (docs/course-elevation.md §7): the event's
 * chosen routes, the polylines a course's climb is read along, and the
 * courses a pair's route change reaches.
 */

import type { Prisma, PrismaClient } from "./generated/prisma/client.js";
import { course } from "@oxygen/shared";
import { editorCourseLayer, legCorridorHalfMm, loadCourseSequences, type GeometrySeqControl } from "./course-geometry.js";

type Db = PrismaClient | Prisma.TransactionClient;

/** The event's chosen routes by `legPairKey(from control id, to control id)`. */
export async function chosenLegRoutes(db: Db, eventId: bigint): Promise<Map<string, course.RoutePoint[]>> {
  const rows = await db.legRoute.findMany({ where: { eventId, chosen: true }, select: { fromControlId: true, toControlId: true, points: true } });
  const out = new Map<string, course.RoutePoint[]>();
  for (const r of rows) {
    const points = course.legRoutePointsSchema.safeParse(r.points);
    if (points.success) out.set(course.legPairKey(r.fromControlId, r.toControlId), points.data);
  }
  return out;
}

/**
 * The polylines an ordered course's climb is read along (§7.3): its
 * derived legs, each along its pair's chosen route when it has one. A
 * leg stored as a marked route keeps its line; a corridor leg keeps it
 * where the route leaves the corridor (`mapScale` reads its width).
 */
export function climbLegsOf(courseUuid: string, seq: GeometrySeqControl[], chosen: ReadonlyMap<string, readonly course.RoutePoint[]>, mapScale?: number | null): course.RoutedLeg[] {
  const legs = editorCourseLayer(courseUuid, seq, "ordered", { legStyle: true, legCorridor: true }).derivation.courses[0]?.legs ?? [];
  if (chosen.size === 0) return legs.map((l) => ({ points: l.points, routed: false }));
  // The style and the corridor are the leg's own: a control run to twice may have one marked leg and one that is not.
  return course.routedLegs(legs.map((l) => ({ from: l.from, to: l.to, points: l.points, style: l.style, corridorHalfMm: legCorridorHalfMm(l, mapScale) })), chosen);
}

/** A stamp of the event's chosen routes (their count and latest write): it differs when a route was chosen, changed or removed. */
export async function chosenRoutesStamp(db: Db, eventId: bigint): Promise<string> {
  const a = await db.legRoute.aggregate({ where: { eventId, chosen: true }, _count: true, _max: { updatedAt: true } });
  return `${a._count}/${a._max.updatedAt?.getTime() ?? 0}`;
}

/** The live ordered courses of the event by the directed pairs they run as a leg: `legPairKey(from, to)` → course ids. */
export async function coursesByPair(db: Db, eventId: bigint): Promise<Map<string, string[]>> {
  const courses = await db.course.findMany({ where: { eventId, removed: false, orderMode: "ordered" }, select: { id: true } });
  const sequences = await loadCourseSequences(db, eventId, courses.map((c) => c.id));
  const out = new Map<string, string[]>();
  for (const [id, { seq, orderMode }] of sequences) {
    if (orderMode !== "ordered") continue;
    const legs = editorCourseLayer(id, seq, orderMode).derivation.courses[0]?.legs ?? [];
    for (const key of new Set(legs.map((l) => course.legPairKey(l.from, l.to)))) {
      const ids = out.get(key);
      if (ids) ids.push(id);
      else out.set(key, [id]);
    }
  }
  return out;
}

/** The live ordered courses of the event that run `from` → `to` as a leg. */
export async function coursesRunningPair(db: Db, eventId: bigint, from: string, to: string): Promise<string[]> {
  return (await coursesByPair(db, eventId)).get(course.legPairKey(from, to)) ?? [];
}
