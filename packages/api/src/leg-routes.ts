/**
 * Leg routes on the server (docs/course-elevation.md §7): the event's
 * chosen routes, the polylines a course's climb is read along, and the
 * courses a pair's route change reaches.
 */

import type { Prisma, PrismaClient } from "./generated/prisma/client.js";
import { course } from "@oxygen/shared";
import { editorCourseLayer, loadCourseSequences, type GeometrySeqControl } from "./course-geometry.js";

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
 * leg stored as a marked route keeps its line.
 */
export function climbLegsOf(courseUuid: string, seq: GeometrySeqControl[], chosen: ReadonlyMap<string, readonly course.RoutePoint[]>): course.RoutedLeg[] {
  const legs = editorCourseLayer(courseUuid, seq, "ordered", { legStyle: true }).derivation.courses[0]?.legs ?? [];
  if (chosen.size === 0) return legs.map((l) => ({ points: l.points, routed: false }));
  // The style is the leg's own: a control run to twice may have one marked leg and one that is not.
  return course.routedLegs(legs.map((l) => ({ from: l.from, to: l.to, points: l.points, style: l.style })), chosen);
}

/** The live ordered courses of the event that run `from` → `to` as a leg. */
export async function coursesRunningPair(db: Db, eventId: bigint, from: string, to: string): Promise<string[]> {
  const courses = await db.course.findMany({ where: { eventId, removed: false, orderMode: "ordered" }, select: { id: true } });
  const sequences = await loadCourseSequences(db, eventId, courses.map((c) => c.id));
  const out: string[] = [];
  for (const [id, { seq, orderMode }] of sequences) {
    if (orderMode !== "ordered") continue;
    const legs = editorCourseLayer(id, seq, orderMode).derivation.courses[0]?.legs ?? [];
    if (legs.some((l) => l.from === from && l.to === to)) out.push(id);
  }
  return out;
}
