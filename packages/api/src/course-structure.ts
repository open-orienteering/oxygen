/**
 * The stored course structure and its column mirror (docs/course-layer.md
 * §6; research 08 §4.3, §4.8).
 *
 * `courses.structure` names what a course explicitly visits: an optional
 * start site, the controls, an optional finish site. The flat columns stay
 * what timing, export, the kiosk and the legacy editor read, and are a pure
 * function of the structure (`splitStructure`):
 *
 * - a leading item whose site is a start → `start_name` (else `""`: the
 *   event's lowest-seq start, completed by the readers as before);
 * - a trailing item whose site is a finish → `finish_control_id` (else NULL);
 * - a leading / trailing *control* with `role: "start"` / `"finish"` →
 *   `first_as_start` / `last_as_finish`;
 * - everything else, in order → `course_controls` (with `number_hidden`).
 *
 * `structureFromColumns` is the inverse, so a course written before D0
 * reads as the structure its columns describe, and `course.update` (the
 * linear shortcut) rewrites the structure from the columns it just wrote.
 * Label offsets live in `course_controls` only.
 */

import { course, type ReferenceUpsertPayload } from "@oxygen/shared";
import { publicControlId } from "./control-id.js";
import { basePayload, lockCourseVersion, versionConflict } from "./version-conflict.js";

type WireCourseStructure = course.WireCourseStructure;
import type { Prisma, PrismaClient } from "./generated/prisma/client.js";
import { Prisma as PrismaNs } from "./generated/prisma/client.js";

type Db = PrismaClient | Prisma.TransactionClient;
type Stored = course.StoredCourseStructure;
type ControlItem = course.StoredControlItem;

export interface StructureParts {
  /** Explicit start site, or null (the event default unless `firstAsStart`). */
  start: string | null;
  /** Explicit finish site, or null (the event default unless `lastAsFinish`). */
  finish: string | null;
  /** The `course_controls` sequence. */
  middle: ControlItem[];
  firstAsStart: boolean;
  lastAsFinish: boolean;
}

/** Split a structure's control items into the column mirror (see the module comment). */
export function splitStructure(
  items: readonly ControlItem[],
  kindOf: (siteId: string) => string | undefined,
): StructureParts {
  const middle = [...items];
  let start: string | null = null;
  let finish: string | null = null;
  let firstAsStart = false;
  let lastAsFinish = false;
  const first = middle[0];
  if (first && kindOf(first.siteId) === "start") {
    start = first.siteId;
    middle.shift();
  } else if (first?.role === "start") {
    firstAsStart = true;
  }
  const last = middle.at(-1);
  if (last && kindOf(last.siteId) === "finish") {
    finish = last.siteId;
    middle.pop();
  } else if (last?.role === "finish") {
    lastAsFinish = true;
  }
  return { start, finish, middle, firstAsStart, lastAsFinish };
}

export interface CourseColumns {
  id: string;
  orderMode: "ordered" | "free_order";
  startName: string;
  finishControlId: string | null;
  firstAsStart: boolean;
  lastAsFinish: boolean;
}

/** The explicit linear structure the columns describe (the inverse of `splitStructure`). */
export function structureFromColumns(
  c: CourseColumns,
  courseControls: ReadonlyArray<{ controlId: string; numberHidden: boolean }>,
  starts: ReadonlyArray<{ id: string; name: string }>,
): Stored {
  const items: ControlItem[] = [];
  const start = !c.firstAsStart && c.startName ? starts.find((s) => s.name === c.startName) : undefined;
  if (start) items.push({ siteId: start.id });
  courseControls.forEach((cc, index) => {
    const item: ControlItem = { siteId: cc.controlId };
    if (index === 0 && c.firstAsStart) item.role = "start";
    if (index === courseControls.length - 1 && c.lastAsFinish) item.role = "finish";
    if (cc.numberHidden) item.numberHidden = true;
    items.push(item);
  });
  if (!c.lastAsFinish && c.finishControlId) items.push({ siteId: c.finishControlId });
  return { version: 1, id: c.id, orderMode: c.orderMode, items };
}

/**
 * Carry leg props over from the previous structure to a rewritten linear
 * one: an item keeps its `leg` when it still follows the same site (the
 * leg into it is the same leg). Used by `course.update`, whose input is a
 * plain id sequence.
 */
export function carryLegs(prev: Stored | null, next: Stored): Stored {
  if (!prev) return next;
  const legs = new Map<string, ControlItem["leg"]>();
  const prevItems = course.structureControlItems(prev);
  prevItems.forEach((item, i) => {
    if (item.leg && i > 0) legs.set(`${prevItems[i - 1].siteId}>${item.siteId}`, item.leg);
  });
  if (legs.size === 0) return next;
  const items = next.items.map((item, i) => {
    if (item.kind === "variation" || i === 0) return item;
    const prevItem = next.items[i - 1];
    if (prevItem.kind === "variation") return item;
    const leg = legs.get(`${prevItem.siteId}>${item.siteId}`);
    return leg ? { ...item, leg } : item;
  });
  return { ...next, items };
}

type Offsets = Record<string, { dx: number; dy: number }>;

/** Map a structure's site ids and label-offset keys through `f`. */
function mapSites<A extends string | number, B extends string | number>(
  s: { items: readonly unknown[]; labelOffsets?: Offsets },
  f: (id: A) => B,
): { items: unknown[]; labelOffsets?: Offsets } {
  type Ctl = { siteId: A };
  type Item = Ctl & { kind?: string; alternatives?: { items: Ctl[] }[] };
  const ctl = (i: Ctl) => ({ ...i, siteId: f(i.siteId) });
  const out: { items: unknown[]; labelOffsets?: Offsets } = {
    ...s,
    items: (s.items as Item[]).map((i) =>
      i.kind === "variation"
        ? { ...i, alternatives: i.alternatives!.map((a) => ({ ...a, items: a.items.map(ctl) })) }
        : ctl(i),
    ),
  };
  if (s.labelOffsets) {
    out.labelOffsets = Object.fromEntries(
      // Record keys are strings: a wire key is a public id ("31"), a stored one a UUID.
      Object.entries(s.labelOffsets).map(([k, v]) => [String(f((/^\d+$/.test(k) ? Number(k) : k) as A)), v]),
    );
  }
  return out;
}

/** Stored (UUID) form → wire form (public control ids; label offsets keyed by public id). */
export function structureToWire(s: Stored & { labelOffsets?: Offsets }, publicId: (uuid: string) => number): WireCourseStructure {
  return mapSites<string, number>(s, publicId) as unknown as WireCourseStructure;
}

/** Wire form → stored form. `uuidOf` throws NOT_FOUND for an unknown id. */
export function structureFromWire(s: WireCourseStructure, uuidOf: (publicId: number) => string): Stored & { labelOffsets?: Offsets } {
  return mapSites<number, string>(s, uuidOf) as unknown as Stored;
}

/** A site's kind from its row: `kind`, else the legacy `status` 4 / 5. */
export function rowKind(c: { kind: string; status: string }): string {
  if (c.kind !== "control") return c.kind;
  return c.status === "start" || c.status === "finish" ? c.status : "control";
}

/**
 * Write a structure and its mirror: the column (without label offsets),
 * `order_mode`, the start / finish columns and `course_controls` (label
 * offsets from `structure.labelOffsets` when given, else kept per control).
 * Call inside the write transaction, before `rebuildCourseGeometry` and the
 * emit.
 */
export async function persistStructure(db: Db, eventId: bigint, s: Stored): Promise<void> {
  const items = course.structureControlItems(s);
  const rows = await db.control.findMany({
    where: { eventId, id: { in: [...new Set(items.map((i) => i.siteId))] } },
    select: { id: true, name: true, kind: true, status: true },
  });
  const byId = new Map(rows.map((r) => [r.id, r]));
  const parts = splitStructure(items, (id) => {
    const r = byId.get(id);
    return r ? rowKind(r) : undefined;
  });

  let offsets: Map<string, { dx: number; dy: number }>;
  if (s.labelOffsets) {
    offsets = new Map(Object.entries(s.labelOffsets));
  } else {
    const existing = await db.courseControl.findMany({
      where: { courseId: s.id },
      select: { controlId: true, labelDx: true, labelDy: true },
    });
    offsets = new Map();
    for (const row of existing) {
      if (row.labelDx != null && row.labelDy != null && !offsets.has(row.controlId)) {
        offsets.set(row.controlId, { dx: row.labelDx, dy: row.labelDy });
      }
    }
  }

  const { labelOffsets: _offsets, ...column } = s;
  await db.course.update({
    where: { id: s.id },
    data: {
      structure: column as unknown as Prisma.InputJsonValue,
      orderMode: s.orderMode,
      startName: parts.start ? (byId.get(parts.start)?.name ?? "") : "",
      finishControlId: parts.finish,
      firstAsStart: parts.firstAsStart,
      lastAsFinish: parts.lastAsFinish,
    },
  });
  await db.courseControl.deleteMany({ where: { courseId: s.id } });
  if (parts.middle.length > 0) {
    await db.courseControl.createMany({
      data: parts.middle.map((item, idx) => {
        const off = offsets.get(item.siteId);
        return {
          courseId: s.id,
          position: idx + 1,
          controlId: item.siteId,
          numberHidden: item.numberHidden ?? false,
          ...(off ? { labelDx: off.dx, labelDy: off.dy } : {}),
        };
      }),
    });
  }
}

/** Read the explicit structure of a course: stored, else from its columns. */
export async function loadExplicitStructure(
  db: Db,
  eventId: bigint,
  courseUuid: string,
): Promise<{ structure: Stored; stored: boolean }> {
  const c = await db.course.findUniqueOrThrow({
    where: { id: courseUuid },
    select: {
      id: true, orderMode: true, startName: true, finishControlId: true,
      firstAsStart: true, lastAsFinish: true, structure: true,
    },
  });
  const parsed = c.structure ? course.courseStructureSchema.safeParse(c.structure) : null;
  if (parsed?.success) return { structure: { ...parsed.data, id: c.id, orderMode: c.orderMode }, stored: true };
  const ccs = await db.courseControl.findMany({
    where: { courseId: courseUuid },
    orderBy: { position: "asc" },
    select: { controlId: true, numberHidden: true },
  });
  const starts = c.startName
    ? await db.control.findMany({
        where: { eventId, removed: false, OR: [{ kind: "start" }, { status: "start" }] },
        orderBy: { seq: "asc" },
        select: { id: true, name: true },
      })
    : [];
  return { structure: structureFromColumns(c, ccs, starts), stored: false };
}

/** Rewrite a course's structure column from its columns (after `course.update`), keeping leg props. */
export async function rewriteStructureFromColumns(db: Db, eventId: bigint, courseUuid: string): Promise<void> {
  const before = await db.course.findUniqueOrThrow({ where: { id: courseUuid }, select: { structure: true } });
  const prev = before.structure ? course.courseStructureSchema.safeParse(before.structure) : null;
  // Read from the columns, ignoring the (now stale) stored structure.
  await db.course.update({ where: { id: courseUuid }, data: { structure: PrismaNs.DbNull } });
  const { structure } = await loadExplicitStructure(db, eventId, courseUuid);
  const next = carryLegs(prev?.success ? prev.data : null, structure);
  await db.course.update({
    where: { id: courseUuid },
    data: { structure: next as unknown as Prisma.InputJsonValue },
  });
}

/** A course's label offsets by control UUID (first visit wins), from `course_controls`. */
async function courseLabelOffsets(db: Db, courseUuid: string): Promise<Offsets> {
  const ccs = await db.courseControl.findMany({
    where: { courseId: courseUuid },
    orderBy: { position: "asc" },
    select: { controlId: true, labelDx: true, labelDy: true },
  });
  const out: Offsets = {};
  for (const cc of ccs) {
    if (cc.labelDx != null && cc.labelDy != null) out[cc.controlId] ??= { dx: cc.labelDx, dy: cc.labelDy };
  }
  return out;
}

/**
 * Resolve public control ids (first code, else seq) of active controls to
 * UUIDs in one query. Unknown ids are absent from the map.
 */
export async function uuidsOfPublicIds(db: Db, eventId: bigint, ids: Iterable<number>): Promise<Map<number, string>> {
  const rows = await db.control.findMany({
    where: { eventId, removed: false },
    select: { id: true, codes: true, seq: true },
  });
  const byCode = new Map<number, string>();
  const bySeq = new Map<number, string>();
  for (const r of rows) {
    const code = parseInt(r.codes.split(";")[0]?.trim() ?? "", 10);
    if (Number.isFinite(code) && !byCode.has(code)) byCode.set(code, r.id);
    bySeq.set(r.seq, r.id);
  }
  const out = new Map<number, string>();
  for (const id of ids) {
    const uuid = byCode.get(id) ?? bySeq.get(id);
    if (uuid) out.set(id, uuid);
  }
  return out;
}

/**
 * Re-write the column mirror of the given courses' stored structures — after
 * a site's kind changed, `splitStructure` reads the course differently
 * (§6.2). Returns the courses re-mirrored (those with a stored structure).
 */
export async function remirrorStoredStructures(db: Db, eventId: bigint, courseUuids: readonly string[]): Promise<string[]> {
  const out: string[] = [];
  for (const id of courseUuids) {
    const row = await db.course.findUnique({ where: { id }, select: { structure: true, orderMode: true } });
    const parsed = row?.structure ? course.courseStructureSchema.safeParse(row.structure) : null;
    if (!parsed?.success) continue;
    await persistStructure(db, eventId, { ...parsed.data, id, orderMode: row!.orderMode });
    out.push(id);
  }
  return out;
}

/** Courses whose stored structure names the control (any item, start and finish included). */
export async function coursesNamingInStructure(db: Db, eventId: bigint, controlUuid: string): Promise<string[]> {
  const rows = await db.course.findMany({
    where: { eventId, removed: false, NOT: { structure: { equals: PrismaNs.DbNull } } },
    select: { id: true, structure: true },
  });
  return rows
    .filter((r) => {
      const parsed = course.courseStructureSchema.safeParse(r.structure);
      return parsed.success && course.structureControlIds(parsed.data).includes(controlUuid);
    })
    .map((r) => r.id);
}

/** Public ids of the given controls (the structure's wire form). */
export async function publicIdsOf(db: Db, eventId: bigint, uuids: Iterable<string>): Promise<Map<string, number>> {
  const rows = await db.control.findMany({
    where: { eventId, id: { in: [...new Set(uuids)] } },
    select: { id: true, codes: true, seq: true },
  });
  return new Map(rows.map((r) => [r.id, publicControlId(r)]));
}

/** Every site id a structure references (label-offset keys included). */
function siteIdsOf(s: Stored & { labelOffsets?: Offsets }): string[] {
  return [...course.structureControlIds(s), ...Object.keys(s.labelOffsets ?? {})];
}

/** A course's explicit structure in wire form, with label offsets from `course_controls`. */
export async function loadWireStructure(
  db: Db,
  eventId: bigint,
  courseUuid: string,
): Promise<{ structure: WireCourseStructure; stored: boolean }> {
  const { structure, stored } = await loadExplicitStructure(db, eventId, courseUuid);
  const labelOffsets = await courseLabelOffsets(db, courseUuid);
  const withOffsets = Object.keys(labelOffsets).length > 0 ? { ...structure, labelOffsets } : structure;
  const ids = await publicIdsOf(db, eventId, siteIdsOf(withOffsets));
  return { structure: structureToWire(withOffsets, (id) => ids.get(id) ?? 0), stored };
}

/** The explicit structure a `course.upserted` payload describes (its column, else its columns' mirror). */
async function structureOfPayload(db: Db, eventId: bigint, p: ReferenceUpsertPayload): Promise<Stored> {
  const f = p.fields as Record<string, unknown>;
  const parsed = f.structure ? course.courseStructureSchema.safeParse(f.structure) : null;
  if (parsed?.success) return parsed.data;
  const starts = f.startName
    ? await db.control.findMany({
        where: { eventId, OR: [{ kind: "start" }, { status: "start" }] },
        orderBy: { seq: "asc" },
        select: { id: true, name: true },
      })
    : [];
  return structureFromColumns(
    {
      id: p.id,
      orderMode: f.orderMode === "free_order" ? "free_order" : "ordered",
      startName: String(f.startName ?? ""),
      finishControlId: (f.finishControlId as string | null) ?? null,
      firstAsStart: f.firstAsStart === true,
      lastAsFinish: f.lastAsFinish === true,
    },
    (p.courseControls ?? []).map((cc) => ({ controlId: cc.controlId, numberHidden: cc.numberHidden ?? false })),
    starts,
  );
}

/**
 * Lock the course row and refuse a stale `baseVersion` (docs/course-layer.md
 * §7). No-op without one. Call first inside the write transaction.
 */
export async function assertCourseVersion(
  db: Db,
  eventId: bigint,
  c: { id: string; seq: number },
  baseVersion: string | undefined,
): Promise<void> {
  if (baseVersion === undefined) return;
  const version = await lockCourseVersion(db, c.id);
  if (version === BigInt(baseVersion)) return;
  const current = await loadWireStructure(db, eventId, c.id);
  const { structure: now } = await loadExplicitStructure(db, eventId, c.id);
  const base = await basePayload(db, eventId, "course.upserted", c.id, baseVersion);
  let differing: string[] | null = null;
  if (base) {
    // Label offsets live in course_controls on both sides: diff them too.
    const nowOffsets = await courseLabelOffsets(db, c.id);
    const baseOffsets: Offsets = {};
    for (const cc of base.courseControls ?? []) {
      if (cc.labelDx != null && cc.labelDy != null) baseOffsets[cc.controlId] ??= { dx: cc.labelDx, dy: cc.labelDy };
    }
    const diff = course.structureDiff(
      { ...(await structureOfPayload(db, eventId, base)), labelOffsets: baseOffsets },
      { ...now, labelOffsets: nowOffsets },
    );
    const ids = await publicIdsOf(db, eventId, diff);
    differing = diff.map((id) => String(ids.get(id) ?? id));
  }
  throw versionConflict({
    kind: "course",
    id: c.seq,
    version: version.toString(),
    current: current.structure,
    differing,
  });
}
