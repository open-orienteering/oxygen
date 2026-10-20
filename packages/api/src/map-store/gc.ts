/**
 * Storage garbage collector (docs/map-storage.md §8; research 07 §5).
 *
 * Blobs are content-addressed and never updated; every reference is a
 * foreign key, so "collectable" is "no row points at it, and it is older
 * than the grace period". The collector is the only code that deletes a
 * blob. Each deletion is its own autocommit statement that re-checks its
 * conditions, so a reference created mid-run turns that row into a no-op,
 * an interrupted run leaves a consistent state, and the next run picks up
 * the rest. `RESTRICT` on `map_files` / `club_map_versions` is the belt.
 *
 * A leader-lease singleton (docs/background-jobs-lease.md): the
 * supervisor's reconcile calls `maybeStartStorageGc`, which runs at most
 * once a day across the deployment, scheduled by timestamps in `settings`.
 */

import type { PrismaClient } from "../generated/prisma/client.js";
import { getSetting, prisma, setSetting } from "../db.js";
import { sweepImportHousekeeping } from "./jobs.js";

export const GC_GRACE_DAYS = 30;
/** A day between runs, measured from the last finish. */
export const GC_INTERVAL_MS = 24 * 3_600_000;
/** A run that started this recently and has not finished is taken to be in progress. */
export const GC_STALE_START_MS = 3_600_000;
/** How often an instance reads the schedule from `settings`. */
export const GC_CHECK_EVERY_MS = 15 * 60_000;

export const GC_SETTINGS = {
  startedAt: "map_storage_gc.started_at",
  finishedAt: "map_storage_gc.finished_at",
  lastResult: "map_storage_gc.last_result",
  graceDays: "map_storage_gc.grace_days",
} as const;

const DAY_MS = 86_400_000;

// ---- pure helpers -----------------------------------------------------------

export function gcCutoff(now: Date, graceDays: number): Date {
  return new Date(now.getTime() - graceDays * DAY_MS);
}

/** The `settings` override: a positive integer number of days; anything else falls back to 30. */
export function parseGraceDays(raw: string | null): number {
  if (raw === null) return GC_GRACE_DAYS;
  const trimmed = raw.trim();
  const n = Number(trimmed);
  if (/^\d+$/.test(trimmed) && Number.isSafeInteger(n) && n >= 1) return n;
  console.warn(`[map-gc] ignoring ${GC_SETTINGS.graceDays}=${JSON.stringify(raw)}; using ${GC_GRACE_DAYS} days`);
  return GC_GRACE_DAYS;
}

/**
 * Due when the last run finished a day ago or never, unless a run started
 * under an hour ago and has not finished (running, or crashed recently).
 */
export function isGcDue(last: { startedAt: Date | null; finishedAt: Date | null }, now: Date): boolean {
  const { startedAt, finishedAt } = last;
  const unfinished = startedAt !== null && (finishedAt === null || startedAt > finishedAt);
  if (unfinished) return now.getTime() - startedAt.getTime() >= GC_STALE_START_MS;
  if (finishedAt === null) return true;
  return now.getTime() - finishedAt.getTime() >= GC_INTERVAL_MS;
}

const FK_SQLSTATES = new Set(["23001", "23503"]);

/**
 * A delete refused by a foreign key: Postgres `23001` (`ON DELETE
 * RESTRICT`) or `23503` (`NO ACTION`), however Prisma and the driver
 * adapter wrap it (P2010 → `meta.driverAdapterError.cause.code`).
 */
export function isForeignKeyViolation(err: unknown, depth = 0): boolean {
  if (!err || typeof err !== "object" || depth > 4) return false;
  const o = err as { code?: unknown; originalCode?: unknown; meta?: { code?: unknown; driverAdapterError?: unknown }; cause?: unknown; message?: unknown };
  if (o.code === "P2003") return true;
  for (const c of [o.code, o.originalCode, o.meta?.code]) if (typeof c === "string" && FK_SQLSTATES.has(c)) return true;
  if (typeof o.message === "string" && /violates (RESTRICT setting of )?foreign key constraint/i.test(o.message)) return true;
  return isForeignKeyViolation(o.meta?.driverAdapterError, depth + 1) || isForeignKeyViolation(o.cause, depth + 1);
}

// ---- one run ----------------------------------------------------------------

export interface StorageGcOptions {
  /** Reference time; defaults to now. */
  now?: Date;
  graceDays?: number;
  /** List the candidates; touch and delete nothing. */
  dryRun?: boolean;
  /** Checked before every delete; true ends the run early. */
  shouldStop?: () => boolean | Promise<boolean>;
}

export interface StorageGcResult {
  graceDays: number;
  dryRun: boolean;
  /** The run ended early on `shouldStop`. */
  stopped: boolean;
  /** Referenced documents whose `last_referenced_at` was bumped. */
  touched: number;
  /** Deleted (or, on a dry run, collectable) document hashes. */
  documents: string[];
  /** Deleted (or collectable) source hashes. */
  sources: string[];
  /** Candidates that gained a reference before their delete ran. */
  skipped: number;
  /** Rows removed by the housekeeping pass. */
  uploads: number;
  jobs: number;
}

const DOCUMENT_UNREFERENCED = `
      NOT EXISTS (SELECT 1 FROM oxygen.map_files f WHERE f.document_hash = d.hash)
  AND NOT EXISTS (SELECT 1 FROM oxygen.club_map_versions v WHERE v.document_hash = d.hash)
  AND NOT EXISTS (SELECT 1 FROM oxygen.map_import_jobs j WHERE j.document_hash = d.hash)`;

const DOCUMENT_REFERENCED = `
      EXISTS (SELECT 1 FROM oxygen.map_files f WHERE f.document_hash = d.hash)
   OR EXISTS (SELECT 1 FROM oxygen.club_map_versions v WHERE v.document_hash = d.hash)
   OR EXISTS (SELECT 1 FROM oxygen.map_import_jobs j WHERE j.document_hash = d.hash)`;

/** `$ignore` lists documents to treat as already gone (a dry run's document candidates). */
const SOURCE_UNREFERENCED = (ignore: string) => `
      NOT EXISTS (SELECT 1 FROM oxygen.map_documents d WHERE d.source_hash = s.file_hash${ignore ? ` AND NOT (d.hash = ANY(${ignore}::text[]))` : ""})
  AND NOT EXISTS (SELECT 1 FROM oxygen.club_map_versions v WHERE v.source_hash = s.file_hash)
  AND NOT EXISTS (SELECT 1 FROM oxygen.map_files f WHERE f.source_hash = s.file_hash)
  AND NOT EXISTS (SELECT 1 FROM oxygen.map_import_jobs j WHERE j.source_hash = s.file_hash)`;

/**
 * One collection run (§8.2): touch referenced documents, delete
 * collectable documents, then sources, then sweep uploads and jobs.
 */
export async function runStorageGc(db: PrismaClient, opts: StorageGcOptions = {}): Promise<StorageGcResult> {
  const now = opts.now ?? new Date();
  const graceDays = opts.graceDays ?? GC_GRACE_DAYS;
  const dryRun = opts.dryRun === true;
  const shouldStop = opts.shouldStop ?? (() => false);
  const cutoff = gcCutoff(now, graceDays);
  const result: StorageGcResult = { graceDays, dryRun, stopped: false, touched: 0, documents: [], sources: [], skipped: 0, uploads: 0, jobs: 0 };

  // 1. Touch: the grace runs from the last pass that saw a reference.
  if (!dryRun) {
    result.touched = await db.$executeRawUnsafe(
      `UPDATE oxygen.map_documents d SET last_referenced_at = $1 WHERE d.last_referenced_at < $1 AND (${DOCUMENT_REFERENCED})`,
      now,
    );
  }

  // 2. Documents.
  const docCandidates = await db.$queryRawUnsafe<{ hash: string }[]>(
    `SELECT d.hash FROM oxygen.map_documents d WHERE d.last_referenced_at < $1 AND ${DOCUMENT_UNREFERENCED} ORDER BY d.last_referenced_at, d.hash`,
    cutoff,
  );
  if (dryRun) {
    result.documents = docCandidates.map((r) => r.hash);
  } else {
    for (const { hash } of docCandidates) {
      if (await shouldStop()) return finishStopped(result);
      try {
        const deleted = await db.$queryRawUnsafe<{ hash: string; source_hash: string; size_bytes: number; last_referenced_at: Date }[]>(
          `DELETE FROM oxygen.map_documents d WHERE d.hash = $1 AND d.last_referenced_at < $2 AND ${DOCUMENT_UNREFERENCED}
           RETURNING d.hash, d.source_hash, d.size_bytes, d.last_referenced_at`,
          hash,
          cutoff,
        );
        const row = deleted[0];
        if (!row) {
          result.skipped++;
          continue;
        }
        result.documents.push(row.hash);
        console.log(`[map-gc] deleted document ${row.hash} (source ${row.source_hash}, ${row.size_bytes} B, last referenced ${row.last_referenced_at.toISOString()})`);
      } catch (err: unknown) {
        if (!isForeignKeyViolation(err)) throw err;
        result.skipped++;
      }
    }
  }

  // 3. Sources, after the documents so a source freed above goes in this run.
  const ignore = dryRun ? result.documents : [];
  const srcCandidates = await db.$queryRawUnsafe<{ file_hash: string }[]>(
    `SELECT s.file_hash FROM oxygen.map_sources s WHERE s.created_at < $1 AND ${SOURCE_UNREFERENCED(ignore.length ? "$2" : "")} ORDER BY s.created_at, s.file_hash`,
    cutoff,
    ...(ignore.length ? [ignore] : []),
  );
  if (dryRun) {
    result.sources = srcCandidates.map((r) => r.file_hash);
  } else {
    for (const { file_hash: hash } of srcCandidates) {
      if (await shouldStop()) return finishStopped(result);
      try {
        const deleted = await db.$queryRawUnsafe<{ file_hash: string; kind: string; size_bytes: number; file_name: string }[]>(
          `DELETE FROM oxygen.map_sources s WHERE s.file_hash = $1 AND s.created_at < $2 AND ${SOURCE_UNREFERENCED("")}
           RETURNING s.file_hash, s.kind, s.size_bytes, s.file_name`,
          hash,
          cutoff,
        );
        const row = deleted[0];
        if (!row) {
          result.skipped++;
          continue;
        }
        result.sources.push(row.file_hash);
        console.log(`[map-gc] deleted source ${row.file_hash} (${row.kind}, ${row.size_bytes} B, ${JSON.stringify(row.file_name)})`);
      } catch (err: unknown) {
        if (!isForeignKeyViolation(err)) throw err;
        result.skipped++;
      }
    }
  }

  // 4. Expired uploads and job rows (§6.6).
  if (!dryRun) {
    if (await shouldStop()) return finishStopped(result);
    const swept = await sweepImportHousekeeping(db, now);
    result.uploads = swept.uploads;
    result.jobs = swept.jobs;
  }

  console.log(`[map-gc] ${dryRun ? "dry run" : "run"} done: ${summaryLine(result)}`);
  return result;
}

function finishStopped(result: StorageGcResult): StorageGcResult {
  result.stopped = true;
  console.log(`[map-gc] run stopped early: ${summaryLine(result)}`);
  return result;
}

function summaryLine(r: StorageGcResult): string {
  return `grace ${r.graceDays} d, touched ${r.touched}, documents ${r.documents.length}, sources ${r.sources.length}, skipped ${r.skipped}, uploads ${r.uploads}, jobs ${r.jobs}`;
}

/** What the schedule stores in `settings`: counts, not hashes. */
export function storedSummary(r: StorageGcResult, finishedAt: Date): Record<string, unknown> {
  return {
    finishedAt: finishedAt.toISOString(),
    graceDays: r.graceDays,
    stopped: r.stopped,
    touched: r.touched,
    documents: r.documents.length,
    sources: r.sources.length,
    skipped: r.skipped,
    uploads: r.uploads,
    jobs: r.jobs,
  };
}

// ---- daily schedule on the lease holder -------------------------------------

let running: Promise<StorageGcResult | null> | null = null;
let stopRequested = false;
let nextCheckAt = 0;

function parseDate(raw: string | null): Date | null {
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Called from the leader's reconcile (§8.3). Reads the schedule at most
 * every 15 minutes; when a run is due, records the start and runs it in
 * the background so the reconcile loop is not held up. Returns whether a
 * run was started. Never throws.
 */
export async function maybeStartStorageGc(now: Date = new Date()): Promise<boolean> {
  if (running || now.getTime() < nextCheckAt) return false;
  nextCheckAt = now.getTime() + GC_CHECK_EVERY_MS;
  try {
    const [startedAt, finishedAt] = await Promise.all([getSetting(GC_SETTINGS.startedAt), getSetting(GC_SETTINGS.finishedAt)]);
    if (!isGcDue({ startedAt: parseDate(startedAt), finishedAt: parseDate(finishedAt) }, now)) return false;
    const graceDays = parseGraceDays(await getSetting(GC_SETTINGS.graceDays));
    await setSetting(GC_SETTINGS.startedAt, now.toISOString());
    stopRequested = false;
    running = runStorageGc(prisma(), { graceDays, shouldStop: () => stopRequested })
      .then(async (r) => {
        const at = new Date();
        await setSetting(GC_SETTINGS.lastResult, JSON.stringify(storedSummary(r, at)));
        // A stopped run (lease lost) clears its start so the next leader
        // need not wait out the in-progress window.
        if (r.stopped) await setSetting(GC_SETTINGS.startedAt, null);
        else await setSetting(GC_SETTINGS.finishedAt, at.toISOString());
        return r;
      })
      .catch((err: unknown) => {
        console.error("[map-gc] run failed:", err);
        return null;
      })
      .finally(() => {
        running = null;
      });
    return true;
  } catch (err: unknown) {
    console.error("[map-gc] schedule check failed:", err);
    return false;
  }
}

/** Ask a running scheduled GC to stop after its current row (lease lost). */
export function stopStorageGc(): void {
  stopRequested = true;
}

/** The scheduled run in progress on this instance, if any. */
export function currentStorageGc(): Promise<StorageGcResult | null> | null {
  return running;
}

/** Test seam: forget the in-process schedule state. */
export function _resetStorageGcSchedule(): void {
  running = null;
  stopRequested = false;
  nextCheckAt = 0;
}
