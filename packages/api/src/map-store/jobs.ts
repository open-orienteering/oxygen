/**
 * Map import jobs (docs/map-storage.md §6; research 07 §8).
 *
 * A job is a row in `map_import_jobs`: `start` inserts it and begins
 * executing it on this instance's single worker, writing stage, progress
 * and a heartbeat to the row. The row — not the process — is the source
 * of truth, so any instance can report it and the poll can re-claim one
 * whose heartbeat went stale. Stages 3–8 are deterministic, so a re-run
 * yields the same hashes and the content-addressed inserts are no-ops.
 */

import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import { extname } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { mapImport, symbolLibrary } from "@oxygen/shared";
import { loadClubDecisions, storedDocumentFollowsDecisions, symbolDecisionsSchema } from "./decisions.js";
import type { Prisma, PrismaClient } from "../generated/prisma/client.js";
import { IMPORTER_VERSIONS, type ImportStage, type MapSourceKind } from "../import/ocad.js";
import { storeImportedDocument, touchDocument } from "./documents.js";
import { deriveDocumentPreviews } from "./previews.js";
import type { ImportWorkerData, ImportWorkerMessage } from "./import-worker.js";

type Db = PrismaClient | Prisma.TransactionClient;

export const JOB_STATES = ["queued", "running", "done", "failed"] as const;
export type JobState = (typeof JOB_STATES)[number];
export type JobStage = ImportStage | "store" | "derive" | "done";

/** Heartbeat written while running; a job silent for `STALE_MS` may be re-claimed. */
export const HEARTBEAT_MS = 10_000;
export const STALE_MS = 60_000;
/** How long `start` waits for the common case to finish inside the request. */
export const DEFAULT_HOLD_MS = Number(process.env.MAP_IMPORT_HOLD_MS ?? 30_000);
/** Wall-clock cap for one import before it is failed. */
export const JOB_TIMEOUT_MS = 10 * 60_000;
/** Housekeeping thresholds (07 §4.4). */
export const UPLOAD_TTL_MS = 24 * 3_600_000;
export const JOB_TTL_MS = 7 * 24 * 3_600_000;

/** Stable per-process identity written to `claimed_by`. */
export const INSTANCE_ID = process.env.NODE_ID ?? `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;

export interface ImportJobRow {
  id: string;
  state: JobState;
  stage: string | null;
  progress: number;
  sourceHash: string;
  documentHash: string | null;
  error: string | null;
  eventId: bigint | null;
  clubMapId: string | null;
  claimedBy: string | null;
  heartbeatAt: Date | null;
  /** The club decisions stage 6 applies, snapshotted at insert (docs/map-storage.md §6.1). */
  decisions: mapImport.SymbolDecision[];
  createdAt: Date;
  updatedAt: Date;
}

// ---- pure helpers -----------------------------------------------------------

/** Whether a poller may take this job over now (07 §8: queued, or running with a stale heartbeat). */
export function isClaimable(row: Pick<ImportJobRow, "state" | "heartbeatAt">, now: Date = new Date(), staleMs = STALE_MS): boolean {
  if (row.state === "queued") return true;
  if (row.state !== "running") return false;
  return row.heartbeatAt === null || now.getTime() - row.heartbeatAt.getTime() > staleMs;
}

/** Coarse progress per stage; the worker reports boundaries, not percentages. */
export function stageProgress(stage: JobStage): number {
  switch (stage) {
    case "parse": return 0.1;
    case "normalise": return 0.4;
    case "match": return 0.55;
    case "encode": return 0.7;
    case "store": return 0.9;
    case "derive": return 0.95;
    case "done": return 1;
  }
}

export function isTerminal(state: JobState): boolean {
  return state === "done" || state === "failed";
}

// ---- worker -------------------------------------------------------------------

export interface WorkerResult {
  bytes: Uint8Array;
  documentHash: string;
  fileHash: string;
  libraryVersion: string;
  report: mapImport.ImportReport;
}

/**
 * The worker entry sits next to this module: `import-worker.ts` under
 * tsx (dev, E2E, vitest) and `import-worker.js` from `dist/` (Docker).
 * tsx's loader does not reach worker threads on Node 20, so a TypeScript
 * entry is started through an eval'd bootstrap that registers tsx inside
 * the worker before importing it; the compiled entry is imported as is.
 */
function workerBootstrap(): string {
  const ext = extname(fileURLToPath(import.meta.url));
  const entry = new URL(`./import-worker${ext}`, import.meta.url).href;
  if (ext !== ".ts") return `import(${JSON.stringify(entry)})`;
  const tsxApi = import.meta.resolve("tsx/esm/api");
  return `import(${JSON.stringify(tsxApi)}).then(({ register }) => { register(); return import(${JSON.stringify(entry)}); })`;
}

export function runImportInWorker(
  bytes: Uint8Array,
  fileName: string,
  opts: { kind?: MapSourceKind; decisions?: mapImport.SymbolDecision[]; onStage?: (stage: ImportStage) => void; timeoutMs?: number } = {},
): Promise<WorkerResult> {
  const workerData: ImportWorkerData = { bytes, fileName, kind: opts.kind ?? "ocad", decisions: opts.decisions ?? [] };
  return new Promise<WorkerResult>((resolve, reject) => {
    const worker = new Worker(workerBootstrap(), { eval: true, workerData });
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
      void worker.terminate();
    };
    const timer = setTimeout(
      () => finish(() => reject(new Error(`import exceeded ${opts.timeoutMs ?? JOB_TIMEOUT_MS} ms`))),
      opts.timeoutMs ?? JOB_TIMEOUT_MS,
    );
    worker.on("message", (m: ImportWorkerMessage) => {
      if (m.type === "stage") opts.onStage?.(m.stage);
      else if (m.type === "done") finish(() => resolve({ bytes: m.bytes, documentHash: m.documentHash, fileHash: m.fileHash, libraryVersion: m.libraryVersion, report: m.report }));
      else finish(() => reject(new Error(m.message)));
    });
    worker.on("error", (err) => finish(() => reject(err)));
    worker.on("exit", (code) => finish(() => reject(new Error(`import worker exited with code ${code}`))));
  });
}

// ---- engine -------------------------------------------------------------------

const JOB_SELECT = {
  id: true, state: true, stage: true, progress: true, sourceHash: true, documentHash: true, error: true,
  eventId: true, clubMapId: true, claimedBy: true, heartbeatAt: true, decisions: true, createdAt: true, updatedAt: true,
} as const;

function asRow(r: { state: string; decisions: Prisma.JsonValue } & Omit<ImportJobRow, "state" | "decisions">): ImportJobRow {
  // The column is ours; a malformed value (hand-edited row) imports without decisions rather than failing the job.
  const decisions = symbolDecisionsSchema.safeParse(r.decisions);
  return { ...r, state: r.state as JobState, decisions: decisions.success ? decisions.data : [] };
}

/** Jobs finishing on this instance resolve these so `start` can hold without polling. */
const waiters = new Map<string, Array<(row: ImportJobRow) => void>>();
function notify(row: ImportJobRow): void {
  const list = waiters.get(row.id);
  if (!list) return;
  waiters.delete(row.id);
  for (const fn of list) fn(row);
}
function waitFor(id: string, ms: number): Promise<ImportJobRow | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      const list = waiters.get(id);
      if (list) waiters.set(id, list.filter((f) => f !== done));
      resolve(null);
    }, ms);
    const done = (row: ImportJobRow) => {
      clearTimeout(timer);
      resolve(row);
    };
    waiters.set(id, [...(waiters.get(id) ?? []), done]);
  });
}

let running: Promise<void> | null = null;

/**
 * Run claimable jobs on this instance, one at a time, until none is left.
 * A call while a loop is running schedules one more pass after it, so a
 * job inserted as the loop was ending is not left for the next tick.
 * Never throws.
 */
export function kickImportJobs(db: Db): Promise<void> {
  if (running) return running.then(() => kickImportJobs(db));
  running = (async () => {
    for (;;) {
      const next = await nextClaimable(db);
      if (!next) break;
      const claimed = await claim(db, next.id);
      if (!claimed) continue;
      await execute(db, claimed);
    }
  })()
    .catch((err: unknown) => console.error("[map-import] engine:", err))
    .finally(() => { running = null; });
  return running;
}

async function nextClaimable(db: Db): Promise<{ id: string } | null> {
  const stale = new Date(Date.now() - STALE_MS);
  return db.mapImportJob.findFirst({
    where: { OR: [{ state: "queued" }, { state: "running", OR: [{ heartbeatAt: null }, { heartbeatAt: { lt: stale } }] }] },
    orderBy: { createdAt: "asc" },
    select: { id: true },
  });
}

/** Atomic claim: only a queued job or a running one with a stale heartbeat flips to ours. */
async function claim(db: Db, id: string): Promise<ImportJobRow | null> {
  const stale = new Date(Date.now() - STALE_MS);
  const { count } = await db.mapImportJob.updateMany({
    where: { id, OR: [{ state: "queued" }, { state: "running", OR: [{ heartbeatAt: null }, { heartbeatAt: { lt: stale } }] }] },
    data: { state: "running", claimedBy: INSTANCE_ID, heartbeatAt: new Date(), stage: "parse", progress: stageProgress("parse"), error: null },
  });
  if (count !== 1) return null;
  const row = await db.mapImportJob.findUnique({ where: { id }, select: JOB_SELECT });
  return row ? asRow(row) : null;
}

/** Writes guarded by `claimedBy` so a job re-claimed elsewhere ignores our late updates. */
async function progress(db: Db, id: string, stage: JobStage): Promise<void> {
  await db.mapImportJob.updateMany({ where: { id, claimedBy: INSTANCE_ID }, data: { stage, progress: stageProgress(stage), heartbeatAt: new Date() } });
}

async function execute(db: Db, job: ImportJobRow): Promise<void> {
  const heartbeat = setInterval(() => {
    db.mapImportJob.updateMany({ where: { id: job.id, claimedBy: INSTANCE_ID }, data: { heartbeatAt: new Date() } })
      .catch((err: unknown) => console.error(`[map-import] heartbeat ${job.id}:`, err));
  }, HEARTBEAT_MS);
  try {
    const source = await db.mapSource.findUnique({ where: { fileHash: job.sourceHash }, select: { kind: true, fileName: true, bytes: true, uploadedBy: true } });
    if (!source) throw new Error(`source ${job.sourceHash} not found`);
    if (source.kind !== "ocad" && source.kind !== "omap") throw new Error(`UNSUPPORTED_FORMAT: ${source.kind} import is not available`);

    const result = await runImportInWorker(source.bytes, source.fileName, { kind: source.kind, decisions: job.decisions, onStage: (stage) => void progress(db, job.id, stage) });
    await progress(db, job.id, "store");
    const stored = await storeImportedDocument(db, {
      source: { bytes: source.bytes, fileHash: job.sourceHash, kind: source.kind, fileName: source.fileName, uploadedBy: source.uploadedBy },
      document: { bytes: result.bytes, hash: result.documentHash, libraryVersion: result.libraryVersion },
      report: result.report,
    });
    // An existing row may be old and unreferenced: touch it before pinning so a racing GC skips it (§8.2).
    if (stored.deduplicated) await touchDocument(db, stored.documentHash);
    await applyJobResult(db, { ...job, documentHash: stored.documentHash });
    // Stage 10: previews are cache, so a failure is logged inside and never fails the job.
    await progress(db, job.id, "derive");
    await deriveDocumentPreviews(db, stored.documentHash);
    await db.mapImportJob.updateMany({
      where: { id: job.id, claimedBy: INSTANCE_ID },
      data: { state: "done", stage: "done", progress: 1, documentHash: stored.documentHash, heartbeatAt: new Date() },
    });
  } catch (err: unknown) {
    const message = (err instanceof Error ? err.message : String(err)).slice(0, 2000);
    console.error(`[map-import] job ${job.id} failed:`, message);
    await db.mapImportJob.updateMany({ where: { id: job.id, claimedBy: INSTANCE_ID }, data: { state: "failed", error: message, heartbeatAt: new Date() } })
      .catch((e: unknown) => console.error(`[map-import] marking ${job.id} failed:`, e));
  } finally {
    clearInterval(heartbeat);
    const row = await db.mapImportJob.findUnique({ where: { id: job.id }, select: JOB_SELECT }).catch(() => null);
    if (row) notify(asRow(row));
  }
}

/**
 * Pin the finished document where the job's target points: the event's
 * `map_files` row(s) carrying this source, or the club map's version for
 * this source — a new `club_map_versions` row, or the existing one's
 * `document_hash` moved to the new document. Idempotent. A job without a
 * target (a review round) pins nothing; `finalise` pins it later.
 */
export async function applyJobResult(db: Db, job: Pick<ImportJobRow, "eventId" | "clubMapId" | "sourceHash" | "documentHash">): Promise<void> {
  if (!job.documentHash) return;
  if (job.eventId !== null) {
    await db.mapFile.updateMany({ where: { eventId: job.eventId, sourceHash: job.sourceHash }, data: { documentHash: job.documentHash } });
  }
  if (job.clubMapId !== null) {
    const existing = await db.clubMapVersion.findFirst({ where: { clubMapId: job.clubMapId, sourceHash: job.sourceHash }, select: { id: true, documentHash: true } });
    if (existing) {
      // The edition is the file; its document is the file's latest import (a review, a re-match) — §6.4.
      if (existing.documentHash !== job.documentHash) await db.clubMapVersion.update({ where: { id: existing.id }, data: { documentHash: job.documentHash } });
    } else {
      const source = await db.mapSource.findUnique({ where: { fileHash: job.sourceHash }, select: { fileName: true, uploadedBy: true } });
      const last = await db.clubMapVersion.aggregate({ where: { clubMapId: job.clubMapId }, _max: { seq: true } });
      await db.clubMapVersion.create({
        data: {
          clubMapId: job.clubMapId,
          seq: (last._max.seq ?? 0) + 1,
          label: source?.fileName ?? "",
          sourceHash: job.sourceHash,
          documentHash: job.documentHash,
          uploadedBy: source?.uploadedBy ?? null,
        },
      });
    }
  }
  await touchDocument(db, job.documentHash);
}

export interface StartImportJobInput {
  sourceHash: string;
  eventId?: bigint | null;
  clubMapId?: string | null;
  /** The signed-in user whose request starts the job (docs/map-storage.md §4.2); omitted for the backfill. */
  startedBy?: string | null;
  /** Wait this long for the job to finish before returning (0 = return at once). */
  holdMs?: number;
}

/**
 * A stored document of the source that importing it now would reproduce:
 * current importer (a source hash has one kind, so the current version of
 * either importer), current library release (the library id follows the
 * map scale) and the same decisions applied (docs/map-symbols.md §8.5).
 */
export async function currentDocumentFor(db: Db, sourceHash: string, decisions: readonly mapImport.SymbolDecision[]): Promise<{ hash: string } | null> {
  const candidates = await db.mapDocument.findMany({
    where: { sourceHash, importerVersion: { in: [...IMPORTER_VERSIONS] }, libraryVersion: { endsWith: `@${symbolLibrary.SYMBOL_LIBRARY_VERSION}` } },
    orderBy: { createdAt: "desc" },
    select: { hash: true, report: true },
  });
  for (const c of candidates) if (await storedDocumentFollowsDecisions(db, c, decisions)) return { hash: c.hash };
  return null;
}

/**
 * Insert the job and run it. The club decisions for the source's kind are
 * snapshotted into the row, so a re-claim imports with the same input. A
 * source whose current document already exists skips the worker entirely
 * (06 §8 dedup): the job is recorded as done against the existing
 * document and the pins applied.
 */
export async function startImportJob(db: Db, input: StartImportJobInput): Promise<ImportJobRow> {
  const target = { eventId: input.eventId ?? null, clubMapId: input.clubMapId ?? null, startedBy: input.startedBy ?? null };
  const source = await db.mapSource.findUnique({ where: { fileHash: input.sourceHash }, select: { kind: true } });
  const decisions = source ? await loadClubDecisions(db, source.kind) : [];
  // Plain JSON for the column; optional fields that are absent stay absent.
  const snapshot = decisions.map((d) => ({ ...d })) as Prisma.InputJsonArray;
  const existing = await currentDocumentFor(db, input.sourceHash, decisions);
  if (existing) {
    // Touch before the job row references it, so a GC run racing this insert skips the document (§8.2).
    await touchDocument(db, existing.hash);
    const row = asRow(await db.mapImportJob.create({
      data: { ...target, sourceHash: input.sourceHash, decisions: snapshot, state: "done", stage: "done", progress: 1, documentHash: existing.hash, claimedBy: INSTANCE_ID, heartbeatAt: new Date() },
      select: JOB_SELECT,
    }));
    await applyJobResult(db, row);
    await deriveDocumentPreviews(db, existing.hash);
    return row;
  }

  const row = asRow(await db.mapImportJob.create({ data: { ...target, sourceHash: input.sourceHash, decisions: snapshot, state: "queued" }, select: JOB_SELECT }));
  const holdMs = input.holdMs ?? DEFAULT_HOLD_MS;
  const finished = waitFor(row.id, holdMs);
  void kickImportJobs(db);
  const result = holdMs > 0 ? await finished : null;
  if (result) return result;
  const fresh = await db.mapImportJob.findUnique({ where: { id: row.id }, select: JOB_SELECT });
  return fresh ? asRow(fresh) : row;
}

export async function getImportJob(db: Db, id: string): Promise<ImportJobRow | null> {
  const row = await db.mapImportJob.findUnique({ where: { id }, select: JOB_SELECT });
  return row ? asRow(row) : null;
}

/**
 * Wait for a job to reach a terminal state, however it gets there: the
 * local waiter fires when this instance finishes it, and a DB poll
 * covers a job executed by another instance (the CLI next to a running
 * API) or one that went stale and needs re-claiming. Returns the last
 * row seen when `timeoutMs` elapses first.
 */
export async function awaitImportJob(db: Db, id: string, opts: { timeoutMs?: number; pollMs?: number } = {}): Promise<ImportJobRow | null> {
  const until = Date.now() + (opts.timeoutMs ?? JOB_TIMEOUT_MS + STALE_MS);
  const pollMs = opts.pollMs ?? 1_000;
  let row = await getImportJob(db, id);
  while (row && !isTerminal(row.state) && Date.now() < until) {
    if (isClaimable(row)) void kickImportJobs(db);
    const local = await waitFor(id, pollMs);
    row = local ?? (await getImportJob(db, id));
  }
  return row;
}

export async function latestImportJobForEvent(db: Db, eventId: bigint): Promise<ImportJobRow | null> {
  const row = await db.mapImportJob.findFirst({ where: { eventId }, orderBy: { createdAt: "desc" }, select: JOB_SELECT });
  return row ? asRow(row) : null;
}

/**
 * Housekeeping (07 §4.4): uploads after 24 h — abandoned, or finalised
 * (the client holds the hash; a finalised row is not a GC reference,
 * docs/map-storage.md §8.1) — and finished job rows after 7 days.
 */
export async function sweepImportHousekeeping(db: Db, now: Date = new Date()): Promise<{ uploads: number; jobs: number }> {
  const uploads = await db.mapUpload.deleteMany({ where: { createdAt: { lt: new Date(now.getTime() - UPLOAD_TTL_MS) } } });
  const jobs = await db.mapImportJob.deleteMany({ where: { state: { in: ["done", "failed"] }, updatedAt: { lt: new Date(now.getTime() - JOB_TTL_MS) } } });
  return { uploads: uploads.count, jobs: jobs.count };
}

let sweeper: NodeJS.Timeout | null = null;

/**
 * Periodic engine tick for an API instance: resumes queued or stale jobs
 * nobody is polling for, and runs housekeeping. The status poll remains
 * the primary engine (07 §8); this covers unattended instances.
 */
export function startImportJobEngine(db: Db, intervalMs = STALE_MS): void {
  if (sweeper) return;
  const tick = () => {
    void kickImportJobs(db);
    sweepImportHousekeeping(db).catch((err: unknown) => console.error("[map-import] housekeeping:", err));
  };
  sweeper = setInterval(tick, intervalMs);
  sweeper.unref();
  setTimeout(tick, 5_000).unref();
}

export function stopImportJobEngine(): void {
  if (sweeper) clearInterval(sweeper);
  sweeper = null;
}
