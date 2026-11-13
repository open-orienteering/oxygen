/**
 * Runners' variants (slice F, row F6b; docs/course-controls-and-matching.md
 * "Forked courses and variants"). A runner in a class whose course is a
 * root with variation groups runs one of the root's materialised children
 * (docs/course-layer.md §12): `runner.courseId`, set **before the race** by
 * the desk, dealt per class, or picked here. The readout never chooses one
 * (user answer 3, 2026-11-07).
 *
 * Invariant: every non-removed runner whose class has a stage-0 variant
 * pool has a `course_id` in that pool. `reconcileClassVariants` restores
 * it after anything that changed a class's pool or a runner's class; a
 * runner created without a variant gets `assignVariant`'s pick — the
 * least-populated variant of the pool, ties the first key.
 *
 * The pure half (`pickLeastPopulated`, `startOrderCompare`, `dealVariants`)
 * is unit-tested; the DB half reads and writes rows only — the callers
 * journal what changed (`runner.updated { courseId }`).
 */

import { TRPCError } from "@trpc/server";
import type { Prisma, PrismaClient } from "./generated/prisma/client.js";

type Db = PrismaClient | Prisma.TransactionClient;

// ─── Pure ───────────────────────────────────────────────────

/** A pooled variant: the child course's uuid, seq and key. */
export interface PoolVariant {
  id: string;
  seq: number;
  variantKey: string;
}

/** The least-populated entry of `pool` by `counts` (course uuid → runners); ties → first in pool order. */
export function pickLeastPopulated<T extends { id: string }>(
  pool: readonly T[],
  counts: ReadonlyMap<string, number>,
): T | null {
  let best: T | null = null;
  let bestCount = Infinity;
  for (const v of pool) {
    const n = counts.get(v.id) ?? 0;
    if (n < bestCount) {
      best = v;
      bestCount = n;
    }
  }
  return best;
}

/** A runner as the dealing sees it. */
export interface DealRunner {
  id: string;
  /** Current course uuid (a variant or null). */
  courseId: string | null;
  /** Relative start time; 0 = none (sorted last). */
  startTime: number;
  startNo: number;
  name: string;
  /** A runner who has raced keeps her variant (never re-dealt). */
  locked?: boolean;
}

/** Start order: start time ascending (none last), then start number (none last), then name. */
export function startOrderCompare(
  a: Pick<DealRunner, "startTime" | "startNo" | "name">,
  b: Pick<DealRunner, "startTime" | "startNo" | "name">,
): number {
  const key = (x: number) => (x > 0 ? x : Number.POSITIVE_INFINITY);
  for (const [x, y] of [[a.startTime, b.startTime], [a.startNo, b.startNo]] as const) {
    if (key(x) !== key(y)) return key(x) < key(y) ? -1 : 1;
  }
  return a.name.localeCompare(b.name);
}

/** mulberry32: a small seeded PRNG, so a `random` deal is reproducible from its seed. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher–Yates over a copy, seeded. */
export function seededShuffle<T>(xs: readonly T[], seed: number): T[] {
  const out = [...xs];
  const next = rng(seed);
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export interface DealOptions {
  mode: "startOrder" | "random";
  /** Keep every runner who already has a pooled variant; deal only the others. */
  onlyUnassigned: boolean;
  /** The `random` mode's seed. */
  seed?: number;
}

/**
 * Deal a class's pool over its runners. Returns the changes only
 * (`{ runnerId, courseId }`, course uuids). Round-robin in pool (key)
 * order over the runners in start order, so consecutive starters get
 * different variants; `random` shuffles the order first. With
 * `onlyUnassigned` the assigned runners keep theirs and each unassigned
 * one, in start order, gets the least-populated variant. A `locked`
 * runner (she has raced) is never changed; she counts toward the balance
 * of `onlyUnassigned` only.
 */
export function dealVariants(
  runners: readonly DealRunner[],
  pool: readonly PoolVariant[],
  opts: DealOptions,
): { runnerId: string; courseId: string }[] {
  if (pool.length === 0) return [];
  const inPool = new Set(pool.map((v) => v.id));
  const sorted = [...runners].sort(startOrderCompare);
  const order = opts.mode === "random" ? seededShuffle(sorted, opts.seed ?? Date.now()) : sorted;
  const changes: { runnerId: string; courseId: string }[] = [];

  if (opts.onlyUnassigned) {
    const counts = new Map<string, number>();
    for (const r of runners) {
      if (r.courseId && inPool.has(r.courseId)) counts.set(r.courseId, (counts.get(r.courseId) ?? 0) + 1);
    }
    for (const r of order) {
      if (r.locked || (r.courseId && inPool.has(r.courseId))) continue;
      const v = pickLeastPopulated(pool, counts)!;
      counts.set(v.id, (counts.get(v.id) ?? 0) + 1);
      if (r.courseId !== v.id) changes.push({ runnerId: r.id, courseId: v.id });
    }
    return changes;
  }

  let i = 0;
  for (const r of order) {
    if (r.locked) continue;
    const v = pool[i % pool.length];
    i++;
    if (r.courseId !== v.id) changes.push({ runnerId: r.id, courseId: v.id });
  }
  return changes;
}

// ─── DB ─────────────────────────────────────────────────────

/** The stage-0 variant pool of a class: its live variant children, key order. */
export async function poolOf(db: Db, classId: string): Promise<PoolVariant[]> {
  const rows = await db.classCoursePool.findMany({
    where: { classId, stage: 0, course: { parentCourseId: { not: null }, removed: false } },
    select: { course: { select: { id: true, seq: true, variantKey: true } } },
  });
  return rows
    .map((r) => ({ id: r.course.id, seq: r.course.seq, variantKey: r.course.variantKey ?? "" }))
    .sort((a, b) => (a.variantKey < b.variantKey ? -1 : a.variantKey > b.variantKey ? 1 : 0));
}

/** Refuse a course that is not in the class's pool (`VARIANT_NOT_IN_POOL`); returns the pooled variant. */
export function assertInPool(pool: readonly PoolVariant[], courseSeq: number): PoolVariant {
  const v = pool.find((p) => p.seq === courseSeq);
  if (!v) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message:
        pool.length === 0
          ? "VARIANT_NOT_IN_POOL: the runner's class runs no course with variants"
          : `VARIANT_NOT_IN_POOL: course ${courseSeq} is not a variant of the runner's class`,
    });
  }
  return v;
}

/** Runners per variant among a class's non-removed runners (course uuid → count), `exceptRunnerId` left out. */
async function countsOf(db: Db, classId: string, exceptRunnerId?: string): Promise<Map<string, number>> {
  const groups = await db.runner.groupBy({
    by: ["courseId"],
    where: { classId, removed: false, ...(exceptRunnerId ? { id: { not: exceptRunnerId } } : {}) },
    _count: { _all: true },
  });
  const out = new Map<string, number>();
  for (const g of groups) if (g.courseId) out.set(g.courseId, g._count._all);
  return out;
}

/**
 * Give one runner the least-populated variant of her class's pool and
 * write it; returns the variant, or null when the class has no pool (the
 * runner's course is then left alone — a caller clearing a stale variant
 * uses `reconcileClassVariants`).
 */
export async function assignVariant(db: Db, classId: string, runnerId: string): Promise<PoolVariant | null> {
  const pool = await poolOf(db, classId);
  if (pool.length === 0) return null;
  const v = pickLeastPopulated(pool, await countsOf(db, classId, runnerId))!;
  await db.runner.update({ where: { id: runnerId }, data: { courseId: v.id } });
  return v;
}

/** A runner whose `course_id` a reconcile changed: `courseId` is the new course seq, or null. */
export interface RunnerVariantChange {
  seq: number;
  cardNo: number | null;
  courseId: number | null;
}

/**
 * Restore the invariant for one class: every non-removed runner whose
 * course is not in the pool gets the least-populated variant (start order,
 * so a fresh pool deals evenly); with no pool, a runner left on a variant
 * is cleared (a plain per-runner course is kept). Returns the changes.
 */
export async function reconcileClassVariants(db: Db, classId: string): Promise<RunnerVariantChange[]> {
  const pool = await poolOf(db, classId);
  const runners = await db.runner.findMany({
    where: { classId, removed: false },
    select: {
      id: true, seq: true, cardNo: true, courseId: true, startTime: true, startNo: true, name: true,
      course: { select: { parentCourseId: true } },
    },
  });
  const changes: RunnerVariantChange[] = [];
  if (pool.length === 0) {
    const stale = runners.filter((r) => r.courseId && r.course?.parentCourseId);
    if (stale.length > 0) {
      await db.runner.updateMany({ where: { id: { in: stale.map((r) => r.id) } }, data: { courseId: null } });
    }
    for (const r of stale) changes.push({ seq: r.seq, cardNo: r.cardNo, courseId: null });
    return changes.sort((a, b) => a.seq - b.seq);
  }
  const dealt = dealVariants(
    runners.map((r) => ({ id: r.id, courseId: r.courseId, startTime: r.startTime, startNo: r.startNo, name: r.name })),
    pool,
    { mode: "startOrder", onlyUnassigned: true },
  );
  const bySeq = new Map(pool.map((v) => [v.id, v.seq]));
  for (const d of dealt) {
    await db.runner.update({ where: { id: d.runnerId }, data: { courseId: d.courseId } });
    const r = runners.find((x) => x.id === d.runnerId)!;
    changes.push({ seq: r.seq, cardNo: r.cardNo, courseId: bySeq.get(d.courseId)! });
  }
  return changes.sort((a, b) => a.seq - b.seq);
}

/** `reconcileClassVariants` over several classes (or every class of the event when `classIds` is omitted). */
export async function reconcileVariants(
  db: Db,
  eventId: bigint,
  classIds?: readonly string[],
): Promise<RunnerVariantChange[]> {
  const ids =
    classIds ??
    (await db.class.findMany({ where: { eventId, removed: false }, select: { id: true } })).map((c) => c.id);
  const out: RunnerVariantChange[] = [];
  for (const id of new Set(ids)) out.push(...(await reconcileClassVariants(db, id)));
  return out;
}

/** Statuses that mean the runner has raced: her variant is never re-dealt. */
const RACED = new Set(["ok", "no_timing", "missing_punch", "dnf", "dq", "over_max_time", "out_of_competition"]);

/**
 * `class.distributeVariants`: deal the class's pool over its non-removed
 * runners (`dealVariants`) and write the changes. A runner who has raced
 * (a finish time, or a result status) is skipped and keeps her variant —
 * the desk changes it by hand. Throws `CLASS_NOT_POOLED` when the class
 * has no pool. Rows only; the caller journals `changes`.
 */
export async function distributeClassVariants(
  db: Db,
  classId: string,
  opts: DealOptions,
): Promise<{ changes: RunnerVariantChange[]; skipped: number; pool: PoolVariant[] }> {
  const pool = await poolOf(db, classId);
  if (pool.length === 0) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "CLASS_NOT_POOLED: the class's course has no variants",
    });
  }
  const runners = await db.runner.findMany({
    where: { classId, removed: false },
    select: {
      id: true, seq: true, cardNo: true, courseId: true, startTime: true, startNo: true, name: true,
      finishTime: true, status: true,
    },
  });
  const deal = runners.map((r) => ({
    id: r.id,
    courseId: r.courseId,
    startTime: r.startTime,
    startNo: r.startNo,
    name: r.name,
    locked: r.finishTime > 0 || RACED.has(r.status),
  }));
  const dealt = dealVariants(deal, pool, opts);
  const seqOf = new Map(pool.map((v) => [v.id, v.seq]));
  const changes: RunnerVariantChange[] = [];
  for (const d of dealt) {
    await db.runner.update({ where: { id: d.runnerId }, data: { courseId: d.courseId } });
    const r = runners.find((x) => x.id === d.runnerId)!;
    changes.push({ seq: r.seq, cardNo: r.cardNo, courseId: seqOf.get(d.courseId)! });
  }
  return { changes: changes.sort((a, b) => a.seq - b.seq), skipped: deal.filter((r) => r.locked).length, pool };
}
