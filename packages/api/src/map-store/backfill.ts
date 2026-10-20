/**
 * Backfill of pre-pipeline map rows into the document store
 * (docs/map-storage.md §6.7; research 09 slice A).
 *
 * Rows written before the import pipeline existed have bytes but no
 * document: `club_map_files` without a `club_maps` series (or a series
 * without a version), and `map_files` without `document_hash`. The
 * backfill walks them one at a time — club rows first, so event rows can
 * be pinned to the club version they came from — dedups the bytes into
 * `map_sources`, runs the ordinary import job for each, and lets the job
 * apply the pins. Everything is keyed by content hash, so a re-run only
 * touches what the previous run left undone.
 *
 * Exposed twice: the Maintenance tab drives `startBackfill` /
 * `backfillStatus` (one run per instance, in-process state), and
 * `pnpm map:backfill` (`src/cli/map-backfill.ts`) calls `runBackfill`
 * directly.
 */

import { createHash } from "node:crypto";
import type { Prisma, PrismaClient } from "../generated/prisma/client.js";
import { awaitImportJob, startImportJob, type ImportJobRow } from "./jobs.js";
import { sniffMapKind } from "./uploads.js";

type Db = PrismaClient;

export type BackfillKind = "club" | "event";

export interface BackfillItem {
  kind: BackfillKind;
  /** `club_map_files.id` or `map_files.id`. */
  id: string;
  name: string;
  eventId: string | null;
}

export type BackfillOutcome = "done" | "failed";

export interface BackfillItemResult extends BackfillItem {
  outcome: BackfillOutcome;
  jobId: string | null;
  documentHash: string | null;
  /** True when the bytes already had a document (no worker run). */
  deduplicated: boolean;
  error: string | null;
}

export interface BackfillPlan {
  clubRows: number;
  eventRows: number;
}

export interface BackfillRun {
  state: "running" | "done" | "failed";
  startedAt: Date;
  finishedAt: Date | null;
  dryRun: boolean;
  total: number;
  processed: number;
  done: number;
  failed: number;
  current: BackfillItem | null;
  /** Failed items of this run (capped at `MAX_RECORDED_FAILURES`). */
  failures: BackfillItemResult[];
  /** Set when the run itself aborted (not an item failure). */
  error: string | null;
}

export interface BackfillOptions {
  /** Restrict event rows to one event; club rows are still processed. */
  eventId?: bigint | null;
  /** Stop after this many items. */
  limit?: number;
  /** Plan and list only; write nothing. */
  dryRun?: boolean;
  /** Called after each item. */
  onItem?: (result: BackfillItemResult, run: BackfillRun) => void;
  /** Called with the plan before any item runs. */
  onPlan?: (plan: BackfillPlan, items: BackfillItem[]) => void;
  /** Per-item wall-clock cap. */
  itemTimeoutMs?: number;
  /** Mutate this object instead of allocating one, so a caller can read live progress. */
  run?: BackfillRun;
}

export const MAX_RECORDED_FAILURES = 100;

const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

// ---- selection ----------------------------------------------------------------

const CLUB_WHERE: Prisma.ClubMapFileWhereInput = {
  OR: [{ clubMapId: null }, { clubMap: { versions: { none: {} } } }],
};

function eventWhere(eventId: bigint | null | undefined): Prisma.MapFileWhereInput {
  return {
    documentHash: null,
    // Soft-deleted events are purged from Maintenance; importing their
    // maps would only create documents for the collector to remove.
    event: { removed: false },
    ...(eventId ? { eventId } : {}),
  };
}

export async function planBackfill(db: Db, opts: Pick<BackfillOptions, "eventId"> = {}): Promise<BackfillPlan> {
  const [clubRows, eventRows] = await Promise.all([
    db.clubMapFile.count({ where: CLUB_WHERE }),
    db.mapFile.count({ where: eventWhere(opts.eventId) }),
  ]);
  return { clubRows, eventRows };
}

/** Everything a run would touch, in processing order; bytes are not loaded here. */
export async function listBackfillItems(db: Db, opts: Pick<BackfillOptions, "eventId" | "limit"> = {}): Promise<BackfillItem[]> {
  const clubs = await db.clubMapFile.findMany({ where: CLUB_WHERE, orderBy: { id: "asc" }, select: { id: true, name: true } });
  const events = await db.mapFile.findMany({
    where: eventWhere(opts.eventId),
    orderBy: { id: "asc" },
    select: { id: true, fileName: true, eventId: true, event: { select: { nameId: true } } },
  });
  const items: BackfillItem[] = [
    ...clubs.map((c) => ({ kind: "club" as const, id: c.id.toString(), name: c.name, eventId: null })),
    ...events.map((e) => ({ kind: "event" as const, id: e.id.toString(), name: `${e.event.nameId}: ${e.fileName || "map"}`, eventId: e.eventId.toString() })),
  ];
  return opts.limit !== undefined ? items.slice(0, Math.max(0, opts.limit)) : items;
}

// ---- items --------------------------------------------------------------------

/** Make sure `map_sources` has these bytes under `fileHash`. */
async function ensureSource(
  db: Db,
  fileHash: string,
  bytes: Uint8Array,
  meta: { fileName: string; uploadedBy: string | null; createdAt: Date },
): Promise<void> {
  await db.mapSource.createMany({
    data: [{
      fileHash,
      kind: sniffMapKind(bytes.subarray(0, 512)) ?? "ocad",
      bytes: Uint8Array.from(bytes),
      sizeBytes: bytes.byteLength,
      fileName: meta.fileName,
      uploadedBy: meta.uploadedBy,
      createdAt: meta.createdAt,
    }],
    skipDuplicates: true,
  });
}

async function settle(db: Db, job: ImportJobRow, timeoutMs: number | undefined): Promise<ImportJobRow> {
  if (job.state === "done" || job.state === "failed") return job;
  const final = await awaitImportJob(db, job.id, { timeoutMs });
  return final ?? job;
}

async function backfillClubRow(db: Db, id: bigint, timeoutMs?: number): Promise<Omit<BackfillItemResult, keyof BackfillItem>> {
  const row = await db.clubMapFile.findUniqueOrThrow({
    where: { id },
    select: {
      name: true, fileName: true, fileData: true, fileHash: true, colorProfile: true, colorOverrides: true,
      northLinesBelow: true, rotationCorrection: true, uploadedBy: true, uploadedAt: true, clubMapId: true,
    },
  });
  const sourceHash = row.fileHash ?? sha256(row.fileData);
  const hadDocument = await hasDocumentFor(db, sourceHash);
  await ensureSource(db, sourceHash, row.fileData, { fileName: row.fileName, uploadedBy: row.uploadedBy, createdAt: row.uploadedAt });
  if (row.fileHash !== sourceHash) await db.clubMapFile.update({ where: { id }, data: { fileHash: sourceHash } });

  let clubMapId = row.clubMapId;
  if (!clubMapId) {
    const series = await db.clubMap.create({
      data: {
        name: row.name,
        colourProfile: row.colorProfile,
        colourOverrides: row.colorOverrides as Prisma.InputJsonValue,
        northLinesBelow: row.northLinesBelow,
        rotationCorrection: row.rotationCorrection,
        createdBy: row.uploadedBy,
        createdAt: row.uploadedAt,
      },
      select: { id: true },
    });
    clubMapId = series.id;
    await db.clubMapFile.update({ where: { id }, data: { clubMapId } });
  }

  const job = await settle(db, await startImportJob(db, { sourceHash, clubMapId, holdMs: 0 }), timeoutMs);
  if (job.state === "done") {
    // The job labels the version from the source row; the legacy row is
    // the authority for this map's name, uploader and upload time.
    await db.clubMapVersion.updateMany({
      where: { clubMapId, sourceHash },
      data: { label: row.fileName, uploadedBy: row.uploadedBy, uploadedAt: row.uploadedAt },
    });
  }
  return outcome(job, hadDocument);
}

async function backfillEventRow(db: Db, id: bigint, timeoutMs?: number): Promise<Omit<BackfillItemResult, keyof BackfillItem>> {
  const row = await db.mapFile.findUniqueOrThrow({
    where: { id },
    select: { eventId: true, fileName: true, fileData: true, fileHash: true, uploadedAt: true, sourceHash: true, clubMapVersionId: true },
  });
  const sourceHash = row.sourceHash ?? row.fileHash ?? sha256(row.fileData);
  const hadDocument = await hasDocumentFor(db, sourceHash);
  await ensureSource(db, sourceHash, row.fileData, { fileName: row.fileName || "map.ocd", uploadedBy: null, createdAt: row.uploadedAt });
  const patch: Prisma.MapFileUpdateInput = {};
  if (row.fileHash !== sourceHash) patch.fileHash = sourceHash;
  if (row.sourceHash !== sourceHash) patch.source = { connect: { fileHash: sourceHash } };
  if (Object.keys(patch).length) await db.mapFile.update({ where: { id }, data: patch });

  const job = await settle(db, await startImportJob(db, { sourceHash, eventId: row.eventId, holdMs: 0 }), timeoutMs);
  if (job.state === "done" && !row.clubMapVersionId) {
    // 09 slice A: an event map whose bytes are a club edition is pinned
    // to that edition, as `course.useClubMap` does for new adoptions.
    const version = await db.clubMapVersion.findFirst({ where: { sourceHash }, orderBy: { uploadedAt: "asc" }, select: { id: true } });
    if (version) await db.mapFile.update({ where: { id }, data: { clubMapVersionId: version.id } });
  }
  return outcome(job, hadDocument);
}

async function hasDocumentFor(db: Db, sourceHash: string): Promise<boolean> {
  return (await db.mapDocument.count({ where: { sourceHash } })) > 0;
}

function outcome(job: ImportJobRow, deduplicated: boolean): Omit<BackfillItemResult, keyof BackfillItem> {
  if (job.state === "done") return { outcome: "done", jobId: job.id, documentHash: job.documentHash, deduplicated, error: null };
  const error = job.state === "failed" ? (job.error ?? "import failed") : `import still ${job.state} when the wait ended`;
  return { outcome: "failed", jobId: job.id, documentHash: null, deduplicated: false, error };
}

// ---- run ----------------------------------------------------------------------

export function newBackfillRun(dryRun = false): BackfillRun {
  return { state: "running", startedAt: new Date(), finishedAt: null, dryRun, total: 0, processed: 0, done: 0, failed: 0, current: null, failures: [], error: null };
}

export async function runBackfill(db: Db, opts: BackfillOptions = {}): Promise<BackfillRun> {
  const run = opts.run ?? newBackfillRun(opts.dryRun);
  const items = await listBackfillItems(db, opts);
  run.total = items.length;
  opts.onPlan?.(await planBackfill(db, opts), items);
  if (run.dryRun) {
    run.state = "done";
    run.finishedAt = new Date();
    return run;
  }
  try {
    for (const item of items) {
      run.current = item;
      const id = BigInt(item.id);
      let result: BackfillItemResult;
      try {
        const r = item.kind === "club" ? await backfillClubRow(db, id, opts.itemTimeoutMs) : await backfillEventRow(db, id, opts.itemTimeoutMs);
        result = { ...item, ...r };
      } catch (err: unknown) {
        result = { ...item, outcome: "failed", jobId: null, documentHash: null, deduplicated: false, error: (err instanceof Error ? err.message : String(err)).slice(0, 2000) };
      }
      run.processed += 1;
      if (result.outcome === "done") run.done += 1;
      else {
        run.failed += 1;
        if (run.failures.length < MAX_RECORDED_FAILURES) run.failures.push(result);
      }
      opts.onItem?.(result, run);
    }
    run.state = "done";
  } catch (err: unknown) {
    run.state = "failed";
    run.error = (err instanceof Error ? err.message : String(err)).slice(0, 2000);
  } finally {
    run.current = null;
    run.finishedAt = new Date();
  }
  return run;
}

// ---- in-process run for the Maintenance tab -----------------------------------

let current: { run: BackfillRun; promise: Promise<BackfillRun> } | null = null;

/** The run in progress or the last one finished on this instance. */
export function backfillStatus(): BackfillRun | null {
  return current?.run ?? null;
}

export function isBackfillRunning(): boolean {
  return current?.run.state === "running";
}

/**
 * Start a run in the background. `runBackfill` mutates the run object it
 * is given, so `backfillStatus()` reads live progress. Returns null when
 * a run is already in progress.
 */
export function startBackfill(db: Db, opts: Omit<BackfillOptions, "onItem" | "onPlan" | "run"> = {}): BackfillRun | null {
  if (isBackfillRunning()) return null;
  const run = newBackfillRun(opts.dryRun);
  const promise = runBackfill(db, { ...opts, run }).catch((err: unknown) => {
    run.state = "failed";
    run.finishedAt = new Date();
    run.error = err instanceof Error ? err.message : String(err);
    return run;
  });
  current = { run, promise };
  return run;
}

/** Wait for the background run (tests, graceful shutdown). */
export async function finishBackfill(): Promise<BackfillRun | null> {
  return current ? current.promise : null;
}

export function resetBackfillState(): void {
  current = null;
}
