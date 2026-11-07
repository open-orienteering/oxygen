/**
 * Materialised variants (docs/course-layer.md §12; research 08 §4.3
 * "Materialisation", §4.8). A course whose stored structure has variation
 * groups — the **root** — has one child `courses` row per variant
 * (`parent_course_id` = the root, `variant_key` = the key), each an
 * ordinary linear course for every reader: `structure` the variant
 * (`course.variantStructure`), its column mirror, `legs` / `length_m`.
 *
 * `syncVariants` brings a root's children in line with the root's stored
 * structure inside the write's transaction, after the root's own
 * `persistStructure`: a new key creates a child, an existing one is
 * rewritten, a soft-deleted one is revived (same uuid — the key pair is
 * unique), a key that is gone soft-deletes its child and nulls
 * `runner.courseId` on the runners that pointed at it; the stage-0 pools
 * of the classes on the root become its live children, and every runner
 * of a class whose pool changed — the nulled ones included — is dealt a
 * variant of the new pool (F6b's invariant, `variants.ts`). It writes rows
 * only: `emitVariantSync` journals what it touched, after the root's own
 * `course.upserted` (a peer applying a child needs the parent row).
 */

import { course } from "@oxygen/shared";
import { TRPCError } from "@trpc/server";
import type { Prisma, PrismaClient } from "./generated/prisma/client.js";
import { Prisma as PrismaNs } from "./generated/prisma/client.js";
import { persistStructure } from "./course-structure.js";
import { rebuildCourseLengths } from "./course-geometry.js";
import { emitClassUpserted, emitCourseUpserted } from "./referenceJournal.js";
import { appendJournal } from "./journalEmit.js";
import { reconcileVariants, type RunnerVariantChange } from "./variants.js";

type Db = PrismaClient | Prisma.TransactionClient;
type Offsets = Record<string, { dx: number; dy: number }>;

/** What `syncVariants` wrote, for `emitVariantSync`. */
export interface VariantSync {
  /** Children written (live) in materialisation order, then those soft-deleted. */
  childIds: string[];
  /** Classes whose stage-0 pool changed. */
  classIds: string[];
  /**
   * Runners whose `course_id` changed: their variant vanished or their
   * class's pool changed. `courseId` is the variant they were dealt (a
   * course seq), or null when their class has no pool.
   */
  runners: RunnerVariantChange[];
}

export const EMPTY_SYNC: VariantSync = { childIds: [], classIds: [], runners: [] };

/** Refuse a structure whose variants collide or are too many (`PRECONDITION_FAILED`). */
export function assertMaterialisable(s: course.StoredCourseStructure): void {
  const n = course.variantCount(s);
  if (n > course.MAX_VARIANTS) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: `VARIANT_LIMIT: ${n} variants (at most ${course.MAX_VARIANTS})`,
    });
  }
  const dup = course.variantKeyDuplicates(course.materialiseVariants(s).map((v) => v.key));
  if (dup.length > 0) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: `VARIANT_KEY_DUPLICATE: ${dup.join(", ")}`,
    });
  }
}

/** Refuse a write that edits a materialised variant itself (`COURSE_IS_VARIANT`). */
export function assertNotVariant(c: { parentCourseId: string | null; name?: string }): void {
  if (c.parentCourseId) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "COURSE_IS_VARIANT: a variant is written through its root course",
    });
  }
}

/** The stored structure of a course when it is valid and has groups, else null. */
export function rootStructureOf(stored: unknown): course.StoredCourseStructure | null {
  const parsed = stored ? course.courseStructureSchema.safeParse(stored) : null;
  return parsed?.success && course.hasVariations(parsed.data) ? parsed.data : null;
}

/** A course's label offsets by control (first visit wins). */
async function offsetsOf(db: Db, courseUuid: string): Promise<Offsets> {
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

export interface SyncOptions {
  /** The label offsets of the write (the wire form's), applied to every child; else a child keeps its own. */
  labelOffsets?: Offsets;
}

/**
 * Bring the root's children in line with its stored structure (see the
 * module comment). A root that is removed, or whose structure has no
 * groups, ends with no live child. Writes rows only; journal with
 * `emitVariantSync`.
 */
export async function syncVariants(
  db: Db,
  eventId: bigint,
  rootId: string,
  opts: SyncOptions = {},
): Promise<VariantSync> {
  const root = await db.course.findUniqueOrThrow({
    where: { id: rootId },
    select: {
      id: true, name: true, removed: true, structure: true, orderMode: true,
      climbM: true, numberOfMaps: true, shorten: true, descriptionInstructions: true,
    },
  });
  const structure = root.removed ? null : rootStructureOf(root.structure);
  const variants = structure ? course.materialiseVariants({ ...structure, orderMode: root.orderMode }) : [];
  const existing = await db.course.findMany({
    where: { parentCourseId: rootId },
    select: { id: true, variantKey: true, removed: true },
  });
  const byKey = new Map(existing.map((c) => [c.variantKey ?? "", c]));
  const rootOffsets = variants.length > 0 ? await offsetsOf(db, rootId) : {};

  const live: string[] = [];
  for (const v of variants) {
    const fields = {
      name: `${root.name} ${v.key}`,
      removed: false,
      climbM: root.climbM,
      numberOfMaps: root.numberOfMaps,
      shorten: root.shorten,
      descriptionInstructions:
        root.descriptionInstructions === null
          ? PrismaNs.DbNull
          : (root.descriptionInstructions as Prisma.InputJsonValue),
    };
    const prev = byKey.get(v.key);
    const child = prev
      ? await db.course.update({ where: { id: prev.id }, data: fields, select: { id: true } })
      : await db.course.create({
          data: { ...fields, eventId, parentCourseId: rootId, variantKey: v.key },
          select: { id: true },
        });
    const offsets = opts.labelOffsets ?? (prev && !prev.removed ? undefined : rootOffsets);
    await persistStructure(db, eventId, {
      version: 1,
      id: child.id,
      orderMode: root.orderMode,
      items: v.items,
      ...(offsets ? { labelOffsets: offsets } : {}),
    });
    live.push(child.id);
  }
  const keys = new Set(variants.map((v) => v.key));
  const dropped = existing.filter((c) => !c.removed && !keys.has(c.variantKey ?? ""));
  const droppedIds = dropped.map((c) => c.id);
  if (droppedIds.length > 0) {
    await db.course.updateMany({ where: { id: { in: droppedIds } }, data: { removed: true } });
  }
  if (live.length > 0) await rebuildCourseLengths(db, eventId, live);

  // A runner whose variant vanished loses it, then is dealt one of the
  // class's new pool below (null when her class has none).
  const nulled = droppedIds.length ? await nullRunnersOn(db, eventId, droppedIds) : [];
  const classIds = await syncPoolsOfRoot(db, eventId, rootId, live, droppedIds);
  return {
    childIds: [...live, ...droppedIds],
    classIds,
    runners: await reconcileAfter(db, eventId, nulled, classIds),
  };
}

/** Null `course_id` on the runners of `courseIds`; returns them with their class. */
async function nullRunnersOn(
  db: Db,
  eventId: bigint,
  courseIds: readonly string[],
): Promise<{ seq: number; cardNo: number | null; classId: string | null }[]> {
  const runners = await db.runner.findMany({
    where: { eventId, courseId: { in: [...courseIds] } },
    select: { id: true, seq: true, cardNo: true, classId: true },
    orderBy: { seq: "asc" },
  });
  if (runners.length > 0) {
    await db.runner.updateMany({ where: { id: { in: runners.map((r) => r.id) } }, data: { courseId: null } });
  }
  return runners;
}

/**
 * F6b's invariant after a pool change: reconcile the changed classes and
 * the nulled runners' classes; a nulled runner the reconcile did not deal
 * (no class, or a class without a pool) stays null. One change per runner.
 */
async function reconcileAfter(
  db: Db,
  eventId: bigint,
  nulled: readonly { seq: number; cardNo: number | null; classId: string | null }[],
  classIds: readonly string[],
): Promise<RunnerVariantChange[]> {
  const classes = [...classIds, ...nulled.flatMap((r) => (r.classId ? [r.classId] : []))];
  const dealt = classes.length > 0 ? await reconcileVariants(db, eventId, classes) : [];
  const out = new Map<number, RunnerVariantChange>();
  for (const r of nulled) out.set(r.seq, { seq: r.seq, cardNo: r.cardNo, courseId: null });
  for (const r of dealt) out.set(r.seq, r);
  return [...out.values()].sort((a, b) => a.seq - b.seq);
}

/** Live children of a root, key order. */
async function liveChildren(db: Db, rootId: string): Promise<string[]> {
  const rows = await db.course.findMany({
    where: { parentCourseId: rootId, removed: false },
    orderBy: { variantKey: "asc" },
    select: { id: true },
  });
  return rows.map((r) => r.id);
}

/** Replace a class's stage-0 variant pool with `childIds`; true when it changed. Pool rows of plain courses are left alone. */
async function writeClassPool(db: Db, classId: string, childIds: readonly string[]): Promise<boolean> {
  const current = await db.classCoursePool.findMany({
    where: { classId, stage: 0, course: { parentCourseId: { not: null } } },
    select: { courseId: true },
  });
  const now = new Set(current.map((p) => p.courseId));
  const next = new Set(childIds);
  if (now.size === next.size && [...now].every((id) => next.has(id))) return false;
  await db.classCoursePool.deleteMany({ where: { classId, stage: 0, courseId: { in: [...now] } } });
  if (childIds.length > 0) {
    await db.classCoursePool.createMany({
      data: childIds.map((courseId) => ({ classId, stage: 0, courseId })),
      skipDuplicates: true,
    });
  }
  return true;
}

/** The pools after a root's materialisation: classes on the root get its live children; a dropped child leaves every pool. */
async function syncPoolsOfRoot(
  db: Db,
  eventId: bigint,
  rootId: string,
  live: readonly string[],
  droppedIds: readonly string[],
): Promise<string[]> {
  const onRoot = await db.class.findMany({ where: { eventId, courseId: rootId, removed: false }, select: { id: true } });
  const changed = new Set<string>();
  for (const cl of onRoot) if (await writeClassPool(db, cl.id, live)) changed.add(cl.id);
  if (droppedIds.length > 0) {
    const stale = await db.classCoursePool.findMany({
      where: { courseId: { in: [...droppedIds] } },
      select: { classId: true },
    });
    if (stale.length > 0) {
      await db.classCoursePool.deleteMany({ where: { courseId: { in: [...droppedIds] } } });
      for (const p of stale) changed.add(p.classId);
    }
  }
  return [...changed];
}

/**
 * A class's stage-0 variant pool after its course changed (`class.create` /
 * `update` / `bulkUpdate`, an import's class mapping): the live children of
 * its course when that is a root, else none; then its runners are dealt
 * the new pool's variants (or cleared off the old one's — F6b). Writes rows
 * only: the caller's `class.upserted` carries the pool, `emitVariantSync`
 * (or `emitRunnerVariants`) journals the runners after it.
 */
export async function syncClassPool(db: Db, classId: string): Promise<VariantSync> {
  const cl = await db.class.findUniqueOrThrow({
    where: { id: classId },
    select: { courseId: true, eventId: true },
  });
  const children = cl.courseId ? await liveChildren(db, cl.courseId) : [];
  const changed = await writeClassPool(db, classId, children);
  return {
    childIds: [],
    classIds: changed ? [classId] : [],
    runners: await reconcileVariants(db, cl.eventId, [classId]),
  };
}

/**
 * Clear what still points at a removed variant (a bulk soft delete that
 * bypassed `syncVariants` — `importCourses { replaceAll }`'s wipe): every
 * runner whose `course_id` is a removed variant gets NULL, every pool row
 * of a removed variant goes. Writes rows only; journal with
 * `emitVariantSync` (`childIds` empty: the courses travel with the caller).
 */
export async function clearRemovedVariants(db: Db, eventId: bigint): Promise<VariantSync> {
  const removed = await db.course.findMany({
    where: { eventId, removed: true, parentCourseId: { not: null } },
    select: { id: true },
  });
  const ids = removed.map((c) => c.id);
  if (ids.length === 0) return { childIds: [], classIds: [], runners: [] };
  const nulled = await nullRunnersOn(db, eventId, ids);
  const stale = await db.classCoursePool.findMany({ where: { courseId: { in: ids } }, select: { classId: true } });
  if (stale.length > 0) await db.classCoursePool.deleteMany({ where: { courseId: { in: ids } } });
  const classIds = [...new Set(stale.map((p) => p.classId))];
  return { childIds: [], classIds, runners: await reconcileAfter(db, eventId, nulled, classIds) };
}

/**
 * Journal a sync, after the root's own `course.upserted`: one
 * `course.upserted` per child (removed ones with `removed: true`), one
 * `class.upserted` per class whose pool changed, one `runner.updated
 * { courseId }` per runner whose variant changed (the seq dealt, or null).
 */
export async function emitVariantSync(db: Db, eventId: bigint, sync: VariantSync): Promise<void> {
  for (const id of sync.childIds) await emitCourseUpserted(db, eventId, id);
  for (const id of sync.classIds) await emitClassUpserted(db, eventId, id);
  await emitRunnerVariants(db, eventId, sync.runners);
}

/** One `runner.updated { courseId }` per change (a peer replays the seq, never re-picks). */
export async function emitRunnerVariants(
  db: Db,
  eventId: bigint,
  runners: readonly RunnerVariantChange[],
): Promise<void> {
  for (const r of runners) {
    await appendJournal(db, {
      eventId,
      type: "runner.updated",
      payload: { cardNo: r.cardNo, runnerId: r.seq, fields: { courseId: r.courseId } },
    });
  }
}

/** Merge several syncs (a write touching more than one root). */
export function mergeSyncs(syncs: readonly VariantSync[]): VariantSync {
  const uniq = <T>(xs: T[], key: (x: T) => string) => [...new Map(xs.map((x) => [key(x), x])).values()];
  return {
    childIds: uniq(syncs.flatMap((s) => s.childIds), (x) => x),
    classIds: uniq(syncs.flatMap((s) => s.classIds), (x) => x),
    runners: uniq(syncs.flatMap((s) => s.runners), (r) => String(r.seq)),
  };
}
