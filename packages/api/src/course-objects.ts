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
import { publicControlId } from "./control-id.js";
import { GraphicRasterError, graphicOutline } from "./course-maps/graphics.js";

/** A stored `graphics.outline` (J19): rings of numbers; anything else reads as not traced. */
const outlineSchema = z.array(z.array(z.number().finite()));

type Db = PrismaClient | Prisma.TransactionClient;
type Row = { id: string; seq: number; kind: string; geometry: unknown; props: unknown; scope: unknown; attach?: unknown; z: number; version: bigint };

/** The stored row shape and the scope filter live in the shared course layer since G13 (the print pipeline reads them, docs/course-print.md §1). */
export type StoredScope = course.StoredScope;
/** A row as the layer and the snapshot read it: body + UUID scope. */
export type StoredCourseObject = course.StoredCourseObject;
export const { objectsInScope } = course;

const storedScopeSchema = course.courseObjectScopeSchemaOf(z.string().uuid());
const storedAttachSchema = course.courseObjectAttachSchemaOf(z.string().uuid());

/** A fresh token: objects carry no journal entry, so the node clock mints one. */
export function nextObjectVersion(): bigint {
  return encodeHlc(nextServerHlc());
}

/** The row's body, validated on read (a row written by a newer image with an unknown kind is skipped). */
export function storedObjectOf(row: Row): StoredCourseObject | null {
  const body = course.courseObjectBodySchema.safeParse({ kind: row.kind, geometry: row.geometry, props: row.props });
  const scope = storedScopeSchema.safeParse(row.scope);
  if (!body.success || !scope.success) return null;
  // J10: an attachment that does not parse reads as none (a row written by a newer image).
  const attach = row.attach == null ? null : storedAttachSchema.safeParse(row.attach);
  return { ...body.data, id: row.id, seq: row.seq, scope: scope.data, z: row.z, version: row.version, ...(attach?.success ? { attach: attach.data } : {}) };
}

/** A control as attachment reads it: its UUID, public id, position and whether it is deleted. */
export interface AttachControl { id: string; publicId: number; x: number; y: number; removed: boolean }

export async function loadAttachControls(db: Db, eventId: bigint): Promise<Map<string, AttachControl>> {
  const rows = await db.control.findMany({ where: { eventId }, select: { id: true, codes: true, seq: true, xpos: true, ypos: true, removed: true } });
  return new Map(rows.map((c) => [c.id, { id: c.id, publicId: publicControlId(c), x: c.xpos, y: c.ypos, removed: c.removed }]));
}

/**
 * An object whose control is deleted (or gone), detached where it was last drawn (J10, user answer 7;
 * docs/course-layer.md §8.1 "Attachment"): its geometry moved by the deleted control's position minus `at`, no
 * `attach`. The row is untouched, so restoring the control re-attaches it.
 */
export function detachedIfRemoved(o: StoredCourseObject, controls: ReadonlyMap<string, AttachControl>): StoredCourseObject {
  if (!o.attach) return o;
  const c = controls.get(o.attach.controlId);
  if (c && !c.removed) return o;
  const { attach, ...rest } = o;
  if (!c) return rest;
  return { ...rest, geometry: course.translateGeometry(o.geometry, c.x - attach.at.x, c.y - attach.at.y) } as StoredCourseObject;
}

/**
 * The event's objects in draw order (`z`, then `seq`); one attached to a deleted control detached where it was drawn;
 * a knockout image with its graphic's outline (J19, `withOutlines`).
 */
export async function loadCourseObjects(db: Db, eventId: bigint): Promise<StoredCourseObject[]> {
  const rows = await db.courseObject.findMany({ where: { eventId }, orderBy: [{ z: "asc" }, { seq: "asc" }] });
  const objects = await withOutlines(db, eventId, rows.flatMap((r) => storedObjectOf(r) ?? []));
  // The controls only when something is attached (most events attach nothing).
  if (!objects.some((o) => o.attach)) return objects;
  const controls = await loadAttachControls(db, eventId);
  return objects.map((o) => detachedIfRemoved(o, controls));
}

/**
 * J19 (docs/map-rendering.md §4.11): each knockout image gets its graphic's traced outline (read-only `outline`, the
 * footprint it cuts by), when it has one. A graphic not traced yet (`graphics.outline` NULL: uploaded, imported or
 * copied since) is traced here once and stored — `[]` for a whole box. Only the event's own and club graphics are
 * read (a graphic of another event cuts by the box, as a missing one). Bytes that cannot be decoded are stored as `[]`
 * (the box, not read again); a print worker that fails or times out leaves NULL, tried again on the next load.
 */
export async function withOutlines<O extends StoredCourseObject>(db: Db, eventId: bigint, objects: O[]): Promise<O[]> {
  const ids = [...new Set(objects.flatMap((o) => (o.kind === "image" && o.props.knockout ? [o.props.graphicId] : [])))];
  if (ids.length === 0) return objects;
  const rows = await db.graphic.findMany({
    where: { id: { in: ids.map(BigInt) }, OR: [{ eventId }, { eventId: null }] },
    select: { id: true, outline: true, mime: true, widthPx: true, heightPx: true },
  });
  const outlines = new Map<number, course.GraphicOutline>();
  for (const r of rows) {
    const parsed = r.outline == null ? null : outlineSchema.safeParse(r.outline);
    let outline: course.GraphicOutline | null = parsed?.success ? parsed.data : null;
    if (outline === null) {
      const held = await db.graphic.findUnique({ where: { id: r.id }, select: { data: true } });
      if (!held) continue;
      try {
        outline = await graphicOutline(held.data, r.mime, r.widthPx, r.heightPx);
      } catch (error) {
        if (error instanceof GraphicRasterError) {
          console.warn(`graphic ${r.id}: outline not traced this time (${error.message})`);
          continue;
        }
        console.warn(`graphic ${r.id}: outline cannot be traced, cut by its box (${error instanceof Error ? error.message : String(error)})`);
        outline = [];
      }
      await db.graphic.update({ where: { id: r.id }, data: { outline: outline as unknown as Prisma.InputJsonValue } });
    }
    if (outline.length) outlines.set(Number(r.id), outline);
  }
  if (outlines.size === 0) return objects;
  return objects.map((o) => (o.kind === "image" && o.props.knockout && outlines.has(o.props.graphicId) ? { ...o, outline: outlines.get(o.props.graphicId) } : o));
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
  /** Every control of the event by UUID, deleted ones included (J10). */
  controls: ReadonlyMap<string, AttachControl>;
}

export async function loadWireContext(db: Db, eventId: bigint): Promise<WireContext> {
  const [ids, byCourse, controls] = await Promise.all([loadScopeIds(db, eventId), classesByCourse(db, eventId), loadAttachControls(db, eventId)]);
  return { ids, byCourse, controls };
}

/**
 * Wire → stored attachment (J10): the public control id among the event's live controls (the control endpoints'
 * id space: the first code, else the seq). An unknown or deleted control is `BAD_REQUEST` naming it; a kind that
 * cannot attach (`toner_saver`, `inset_frame`) too.
 */
export function storedAttach(kind: course.CourseObjectKind, attach: course.CourseObjectAttach<number>, w: WireContext): course.CourseObjectAttach<string> {
  if (course.UNATTACHABLE_KINDS.includes(kind)) throw new TRPCError({ code: "BAD_REQUEST", message: `A ${kind} object cannot be attached to a control` });
  const live = [...w.controls.values()].filter((c) => !c.removed);
  const c = live.find((x) => x.publicId === attach.controlId);
  if (!c) throw new TRPCError({ code: "BAD_REQUEST", message: `Unknown control ${attach.controlId}` });
  return { controlId: c.id, at: { x: attach.at.x, y: attach.at.y } };
}

/** The courses (UUIDs) a scope draws with: the named ones and every course a named class runs. */
export function scopeCourses(scope: StoredScope, byCourse: ReadonlyMap<string, string[]>): string[] | null {
  if ("all" in scope) return null;
  const out = new Set(scope.courses);
  for (const [courseId, classes] of byCourse) if (classes.some((c) => scope.classes.includes(c))) out.add(courseId);
  return [...out];
}

export function toWire(stored: StoredCourseObject, w: WireContext): course.CourseObject {
  const o = detachedIfRemoved(stored, w.controls);
  const { id: _uuid, seq, scope, version, attach, ...body } = o;
  const courses = scopeCourses(scope, w.byCourse);
  const inCourses = courses === null ? null : courses.flatMap((id) => (w.ids.courseSeq.has(id) ? [w.ids.courseSeq.get(id)!] : [])).sort((a, b) => a - b);
  const control = attach ? w.controls.get(attach.controlId) : undefined;
  return {
    ...body, id: seq, scope: wireScope(scope, w.ids), version: version.toString(), inCourses,
    ...(attach && control ? { attach: { controlId: control.publicId, at: attach.at } } : {}),
  } as course.CourseObject;
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
  data: { body: course.CourseObjectBody; scope: StoredScope; z?: number; source?: "import"; attach?: course.CourseObjectAttach<string> },
): Promise<StoredCourseObject> {
  assertWritableKind(data.body.kind);
  if (data.attach && course.UNATTACHABLE_KINDS.includes(data.body.kind)) {
    throw new TRPCError({ code: "BAD_REQUEST", message: `A ${data.body.kind} object cannot be attached to a control` });
  }
  const row = await db.courseObject.create({
    data: {
      eventId,
      kind: data.body.kind,
      geometry: data.body.geometry as Prisma.InputJsonValue,
      props: data.body.props as Prisma.InputJsonValue,
      scope: data.scope as Prisma.InputJsonValue,
      ...(data.attach ? { attach: data.attach as unknown as Prisma.InputJsonValue } : {}),
      z: data.z ?? 0,
      ...(data.source ? { source: data.source } : {}),
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
