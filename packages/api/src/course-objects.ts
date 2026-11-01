/**
 * Course objects (docs/course-layer.md §8; research 08 §4.5, §4.8): the
 * `course_objects` rows, their wire form and their scope.
 *
 * The row stores the body as the wire carries it (`kind`, `geometry` in
 * paper mm y-up, `props`) and the scope with course / class UUIDs; the
 * wire names them by public id (seq). Objects are cloud-owned non-critical
 * data: not journaled, so the concurrency token (§7) is an HLC minted on
 * every write rather than a journal entry's.
 */

import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { course, encodeHlc } from "@oxygen/shared";
import type { Prisma, PrismaClient } from "./generated/prisma/client.js";
import { nextServerHlc } from "./serverClock.js";

type Db = PrismaClient | Prisma.TransactionClient;
type Row = { id: string; seq: number; kind: string; geometry: unknown; props: unknown; scope: unknown; z: number; version: bigint };

export type StoredScope = course.CourseObjectScope<string>;
/** A row as the layer and the snapshot read it: body + UUID scope. */
export type StoredCourseObject = course.CourseObjectBody & { id: string; seq: number; scope: StoredScope; z: number; version: bigint };

const storedScopeSchema = course.courseObjectScopeSchemaOf(z.string().uuid());

/** A fresh token: objects carry no journal entry, so the node clock mints one. */
export function nextObjectVersion(): bigint {
  return encodeHlc(nextServerHlc());
}

/** The row's body, validated on read (a row written by a newer image with an unknown kind is skipped). */
export function storedObjectOf(row: Row): StoredCourseObject | null {
  const body = course.courseObjectBodySchema.safeParse({ kind: row.kind, geometry: row.geometry, props: row.props });
  const scope = storedScopeSchema.safeParse(row.scope);
  if (!body.success || !scope.success) return null;
  return { ...body.data, id: row.id, seq: row.seq, scope: scope.data, z: row.z, version: row.version };
}

/** The event's objects in draw order (`z`, then `seq`). */
export async function loadCourseObjects(db: Db, eventId: bigint): Promise<StoredCourseObject[]> {
  const rows = await db.courseObject.findMany({ where: { eventId }, orderBy: [{ z: "asc" }, { seq: "asc" }] });
  return rows.flatMap((r) => storedObjectOf(r) ?? []);
}

/** Public ids ↔ UUIDs of the event's courses and classes. */
export interface ScopeIds {
  courseSeq: Map<string, number>;
  classSeq: Map<string, number>;
  courseUuid: Map<number, string>;
  classUuid: Map<number, string>;
}

export async function loadScopeIds(db: Db, eventId: bigint): Promise<ScopeIds> {
  const [courses, classes] = await Promise.all([
    db.course.findMany({ where: { eventId }, select: { id: true, seq: true } }),
    db.class.findMany({ where: { eventId }, select: { id: true, seq: true } }),
  ]);
  return {
    courseSeq: new Map(courses.map((c) => [c.id, c.seq])),
    classSeq: new Map(classes.map((c) => [c.id, c.seq])),
    courseUuid: new Map(courses.map((c) => [c.seq, c.id])),
    classUuid: new Map(classes.map((c) => [c.seq, c.id])),
  };
}

/** Stored → wire scope; a course or class removed since is dropped. */
export function wireScope(scope: StoredScope, ids: ScopeIds): course.CourseObjectScope<number> {
  if ("all" in scope) return { all: true };
  const pick = (list: string[], m: Map<string, number>) => list.flatMap((id) => (m.has(id) ? [m.get(id)!] : []));
  return { courses: pick(scope.courses, ids.courseSeq), classes: pick(scope.classes, ids.classSeq) };
}

/** Wire → stored scope; an unknown public id is `BAD_REQUEST` naming it. */
export function storedScope(scope: course.CourseObjectScope<number>, ids: ScopeIds): StoredScope {
  if ("all" in scope) return { all: true };
  const unknown: string[] = [];
  const map = (list: number[], m: Map<number, string>, what: string) =>
    list.flatMap((seq) => {
      const id = m.get(seq);
      if (id === undefined) unknown.push(`${what} ${seq}`);
      return id === undefined ? [] : [id];
    });
  const out = { courses: map(scope.courses, ids.courseUuid, "course"), classes: map(scope.classes, ids.classUuid, "class") };
  if (unknown.length > 0) throw new TRPCError({ code: "BAD_REQUEST", message: `Unknown in scope: ${unknown.join(", ")}` });
  return out;
}

/** What the wire form needs besides the row: public ids and which classes run which course. */
export interface WireContext {
  ids: ScopeIds;
  byCourse: ReadonlyMap<string, string[]>;
}

export async function loadWireContext(db: Db, eventId: bigint): Promise<WireContext> {
  const [ids, byCourse] = await Promise.all([loadScopeIds(db, eventId), classesByCourse(db, eventId)]);
  return { ids, byCourse };
}

/** The courses (UUIDs) a scope draws with: the named ones and every course a named class runs. */
export function scopeCourses(scope: StoredScope, byCourse: ReadonlyMap<string, string[]>): string[] | null {
  if ("all" in scope) return null;
  const out = new Set(scope.courses);
  for (const [courseId, classes] of byCourse) if (classes.some((c) => scope.classes.includes(c))) out.add(courseId);
  return [...out];
}

export function toWire(o: StoredCourseObject, w: WireContext): course.CourseObject {
  const { id: _uuid, seq, scope, version, ...body } = o;
  const courses = scopeCourses(scope, w.byCourse);
  const inCourses = courses === null ? null : courses.flatMap((id) => (w.ids.courseSeq.has(id) ? [w.ids.courseSeq.get(id)!] : [])).sort((a, b) => a - b);
  return { ...body, id: seq, scope: wireScope(scope, w.ids), version: version.toString(), inCourses } as course.CourseObject;
}

/** `inset_frame` is typed for micro insets and refused until they exist (§8.1). */
export function assertWritableKind(kind: course.CourseObjectKind): void {
  if (kind === "inset_frame") {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: "inset_frame objects are reserved (micro insets) and cannot be written yet" });
  }
}

/**
 * Insert one object with a fresh token. The writer the API and the
 * importers (D1) share; `scope` holds UUIDs.
 */
export async function writeCourseObject(
  db: Db,
  eventId: bigint,
  data: { body: course.CourseObjectBody; scope: StoredScope; z?: number },
): Promise<StoredCourseObject> {
  assertWritableKind(data.body.kind);
  const row = await db.courseObject.create({
    data: {
      eventId,
      kind: data.body.kind,
      geometry: data.body.geometry as Prisma.InputJsonValue,
      props: data.body.props as Prisma.InputJsonValue,
      scope: data.scope as Prisma.InputJsonValue,
      z: data.z ?? 0,
      version: nextObjectVersion(),
    },
  });
  return storedObjectOf(row)!;
}

/**
 * Which courses each class runs (`classes.course_id` and the forking pool),
 * for the scope rule: an object scoped to a class is drawn with them.
 */
export async function classesByCourse(db: Db, eventId: bigint): Promise<Map<string, string[]>> {
  const [classes, pools] = await Promise.all([
    db.class.findMany({ where: { eventId, courseId: { not: null } }, select: { id: true, courseId: true } }),
    db.classCoursePool.findMany({ where: { class: { eventId } }, select: { classId: true, courseId: true } }),
  ]);
  const out = new Map<string, string[]>();
  const add = (courseId: string, classId: string) => {
    const list = out.get(courseId) ?? [];
    if (!list.includes(classId)) list.push(classId);
    out.set(courseId, list);
  };
  for (const c of classes) add(c.courseId!, c.id);
  for (const p of pools) add(p.courseId, p.classId);
  return out;
}

/** The objects drawn with a course (UUID), or with no course (`null`: `all`-scoped only). */
export function objectsInScope(objects: readonly StoredCourseObject[], courseId: string | null, byCourse: ReadonlyMap<string, string[]>): StoredCourseObject[] {
  const drawn = courseId === null ? null : { courses: [courseId], classes: byCourse.get(courseId) ?? [] };
  return objects.filter((o) => course.courseObjectInScope(o.scope, drawn));
}
