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

import { Worker } from "node:worker_threads";
import { workerBootstrap } from "../worker-bootstrap.js";
import { mapDocument, mapImport, symbolLibrary } from "@oxygen/shared";
import { loadClubDecisions, parseDecisionSnapshot, storedDocumentFollowsDecisions } from "./decisions.js";
import type { Prisma, PrismaClient } from "../generated/prisma/client.js";
import { IMPORTER_VERSIONS, type ImportStage, type MapSourceKind } from "../import/ocad.js";
import { storeImportedDocument, touchDocument } from "./documents.js";
import { deriveDocumentPreviews } from "./previews.js";
import { deriveDocumentHeightfield } from "./heightfield.js";
import { enqueueDocumentDem } from "./dem-jobs.js";
import { INSTANCE_ID } from "./instance.js";
import { writePinnedMapFileColumns } from "./event-document.js";
import { abandonPromote, completePromote, reresolveAfterPin } from "./patches.js";
import { synchronizePositionedControlCoordinates } from "../event-crs.js";
import type { ImportWorkerData, ImportWorkerMessage } from "./import-worker.js";
import { colourSettingsForJob, colourSettingsJson, documentFollowsColour, loadRecordedColours, parseColourSettings, recordDocumentColour, DEFAULT_COLOUR_SETTINGS, type MapColourSettings } from "./colour-settings.js";

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
export { INSTANCE_ID };

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
  /** The signed-in user whose request started the job; the uploader of the club version it creates. */
  startedBy: string | null;
  claimedBy: string | null;
  heartbeatAt: Date | null;
  /** The club decisions stage 6 applies, snapshotted at insert (docs/map-storage.md §6.1). */
  decisions: mapImport.SymbolDecision[];
  /** The club version's patch the store stage bakes, snapshotted at insert (docs/map-patches.md §5); `[]` = none. */
  patch: mapDocument.VersionPatch;
  /** The map's colour setting stage 7 applies, snapshotted at insert (docs/map-symbols.md §9.3 "Per map (row I6)"). */
  colour: MapColourSettings;
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

export function runImportInWorker(
  bytes: Uint8Array,
  fileName: string,
  opts: { kind?: MapSourceKind; decisions?: mapImport.SymbolDecision[]; patch?: mapDocument.VersionPatch; colour?: MapColourSettings; onStage?: (stage: ImportStage) => void; timeoutMs?: number } = {},
): Promise<WorkerResult> {
  const workerData: ImportWorkerData = { bytes, fileName, kind: opts.kind ?? "ocad", decisions: opts.decisions ?? [], patch: opts.patch ?? [], colour: opts.colour ?? DEFAULT_COLOUR_SETTINGS };
  return new Promise<WorkerResult>((resolve, reject) => {
    const worker = new Worker(workerBootstrap(new URL("./import-worker", import.meta.url), import.meta.url), { eval: true, workerData });
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
  eventId: true, clubMapId: true, startedBy: true, claimedBy: true, heartbeatAt: true, decisions: true, patch: true, colour: true, createdAt: true, updatedAt: true,
} as const;

function asRow(r: { state: string; decisions: Prisma.JsonValue; patch: Prisma.JsonValue; colour: Prisma.JsonValue } & Omit<ImportJobRow, "state" | "decisions" | "patch" | "colour">): ImportJobRow {
  return { ...r, state: r.state as JobState, decisions: parseDecisionSnapshot(r.decisions), patch: mapDocument.parseVersionPatch(r.patch), colour: parseColourSettings(r.colour) };
}

/** A version patch as a JSON column value. */
export const patchJson = (patch: mapDocument.VersionPatch): Prisma.InputJsonArray => patch as unknown as Prisma.InputJsonArray;

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

    const result = await runImportInWorker(source.bytes, source.fileName, { kind: source.kind, decisions: job.decisions, patch: job.patch, colour: job.colour, onStage: (stage) => void progress(db, job.id, stage) });
    await progress(db, job.id, "store");
    const stored = await storeImportedDocument(db, {
      source: { bytes: source.bytes, fileHash: job.sourceHash, kind: source.kind, fileName: source.fileName, uploadedBy: source.uploadedBy },
      document: { bytes: result.bytes, hash: result.documentHash, libraryVersion: result.libraryVersion, patch: job.patch },
      report: result.report,
    });
    // An existing row may be old and unreferenced: touch it before pinning so a racing GC skips it (§8.2).
    if (stored.deduplicated) await touchDocument(db, stored.documentHash);
    // The setting this import was asked for gave this document (row I7): a deduplicated one keeps its first report.
    await recordDocumentColour(db, stored.documentHash, job.colour);
    await applyJobResult(db, { ...job, documentHash: stored.documentHash });
    // Stage 10: previews and the height field are cache, so a failure is logged inside and never fails the job.
    await progress(db, job.id, "derive");
    await deriveDocumentArtifacts(db, stored.documentHash);
    await db.mapImportJob.updateMany({
      where: { id: job.id, claimedBy: INSTANCE_ID },
      data: { state: "done", stage: "done", progress: 1, documentHash: stored.documentHash, heartbeatAt: new Date() },
    });
  } catch (err: unknown) {
    const message = (err instanceof Error ? err.message : String(err)).slice(0, 2000);
    console.error(`[map-import] job ${job.id} failed:`, message);
    const { count } = await db.mapImportJob.updateMany({ where: { id: job.id, claimedBy: INSTANCE_ID }, data: { state: "failed", error: message, heartbeatAt: new Date() } })
      .catch((e: unknown) => {
        console.error(`[map-import] marking ${job.id} failed:`, e);
        return { count: 0 };
      });
    // A failed promote leaves no version behind (docs/map-patches.md §5); the event's patch was never touched.
    if (count === 1 && isPromoteJob(job)) {
      await abandonPromote(db, { clubMapId: job.clubMapId, sourceHash: job.sourceHash, patch: job.patch })
        .catch((e: unknown) => console.error(`[map-import] removing the pending version of ${job.id}:`, e));
    }
  } finally {
    clearInterval(heartbeat);
    const row = await db.mapImportJob.findUnique({ where: { id: job.id }, select: JOB_SELECT }).catch(() => null);
    if (row) notify(asRow(row));
  }
}

/**
 * Import stage 10 (docs/map-storage.md §6.1): the thumbnail (§4.5), then
 * the height field (§4.7), then the DEM job is queued, not awaited
 * (§4.7 "The DEM job"; a no-op without enabled providers). Never throws.
 */
export async function deriveDocumentArtifacts(db: Db, hash: string): Promise<void> {
  await deriveDocumentPreviews(db, hash);
  await deriveDocumentHeightfield(db, hash);
  void enqueueDocumentDem(db, hash, undefined, { requeueFinal: true });
}

/**
 * Pin the finished document where the job's target points: the event's
 * `map_files` row(s) carrying this source — with their quick-access
 * columns recomputed from the document — or the club map's version for
 * this source — a new `club_map_versions` row, or the existing one's
 * `document_hash` moved to the new document. Idempotent. A job without a
 * target (a review round) pins nothing; `finalise` pins it later.
 */
/** A promote's job (docs/map-patches.md §5): it targets the event and the club map, and bakes a version patch. */
export function isPromoteJob<J extends Pick<ImportJobRow, "eventId" | "clubMapId"> & { patch?: mapDocument.VersionPatch }>(
  job: J,
): job is J & { eventId: bigint; clubMapId: string; patch: mapDocument.VersionPatch } {
  return job.eventId !== null && job.clubMapId !== null && (job.patch?.length ?? 0) > 0;
}

export async function applyJobResult(db: Db, job: Pick<ImportJobRow, "eventId" | "clubMapId" | "sourceHash" | "documentHash"> & { startedBy?: string | null; patch?: mapDocument.VersionPatch }): Promise<void> {
  if (!job.documentHash) return;
  const promote = isPromoteJob(job);
  if (job.eventId !== null && !promote) {
    await db.mapFile.updateMany({ where: { eventId: job.eventId, sourceHash: job.sourceHash }, data: { documentHash: job.documentHash } });
    // Quick-access columns from the pinned document (docs/map-storage.md §6.4).
    await writePinnedMapFileColumns(db, job.eventId, job.sourceHash, job.documentHash);
    // Positioned controls' lat/lng from the pinned frame (§6.4).
    await synchronizePositionedControlCoordinates(db, job.eventId);
    // The event's map patch follows the pin (docs/map-patches.md §4.4); a failure leaves it dormant, never fails the pin.
    await reresolveAfterPin(db, job.eventId);
  }
  if (job.clubMapId !== null) {
    // A version is its file and its patch (docs/map-patches.md §5 answer 1): two versions of one source differ by patch.
    const patch = job.patch ?? [];
    const candidates = await db.clubMapVersion.findMany({ where: { clubMapId: job.clubMapId, sourceHash: job.sourceHash }, select: { id: true, documentHash: true, patch: true } });
    const existing = candidates.filter((v) => mapDocument.sameVersionPatch(v.patch, patch));
    if (existing.length) {
      // The edition is the file; its document is the file's latest import (a review, a re-match) — §6.4.
      for (const v of existing) if (v.documentHash !== job.documentHash) await db.clubMapVersion.update({ where: { id: v.id }, data: { documentHash: job.documentHash } });
    } else if (patch.length) {
      // Promoted versions are created by promote, never by a pin (§6.4).
      console.warn(`[map-import] club map ${job.clubMapId}: no version of ${job.sourceHash} with this patch; nothing pinned`);
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
          // Whoever started the import proved possession of the bytes
          // (source-possession.ts); the source row's uploader is only the
          // first uploader and may be someone else.
          uploadedBy: job.startedBy ?? source?.uploadedBy ?? null,
        },
      });
    }
  }
  // The promote's event half (§6.4): after its version holds the document, under the patch row lock.
  if (promote) await completePromote(db, { eventId: job.eventId, clubMapId: job.clubMapId, sourceHash: job.sourceHash, documentHash: job.documentHash, patch: job.patch });
  await touchDocument(db, job.documentHash);
}

export interface InsertImportJobInput {
  sourceHash: string;
  eventId: bigint | null;
  clubMapId: string | null;
  startedBy: string | null;
  decisions: mapImport.SymbolDecision[];
  patch: mapDocument.VersionPatch;
  /** Default: the target's setting (`colourSettingsForJob`). */
  colour?: MapColourSettings;
}

/** A queued job row, in the caller's transaction (promote inserts its version and job together, §5); run it with `holdImportJob`. */
export async function insertQueuedImportJob(db: Db, input: InsertImportJobInput): Promise<ImportJobRow> {
  const { decisions, patch, colour, ...target } = input;
  const settings = colour ?? (await colourSettingsForJob(db, target));
  return asRow(await db.mapImportJob.create({
    data: { ...target, decisions: decisions.map((d) => ({ ...d })) as Prisma.InputJsonArray, patch: patchJson(patch), colour: colourSettingsJson(settings), state: "queued" },
    select: JOB_SELECT,
  }));
}

/** Kick the engine for `row` and hold up to `holdMs` for its terminal state; the freshest row either way. */
export async function holdImportJob(db: Db, row: ImportJobRow, holdMs = DEFAULT_HOLD_MS): Promise<ImportJobRow> {
  const finished = waitFor(row.id, holdMs);
  void kickImportJobs(db);
  const result = holdMs > 0 ? await finished : null;
  if (result) return result;
  const fresh = await db.mapImportJob.findUnique({ where: { id: row.id }, select: JOB_SELECT });
  return fresh ? asRow(fresh) : row;
}

export interface StartImportJobInput {
  sourceHash: string;
  eventId?: bigint | null;
  clubMapId?: string | null;
  /** The signed-in user whose request starts the job (docs/map-storage.md §4.2); omitted for the backfill. */
  startedBy?: string | null;
  /** The club version's patch to bake (docs/map-patches.md §5); default none. */
  patch?: mapDocument.VersionPatch;
  /**
   * The colour setting to import with (docs/map-symbols.md §9.3 "Per map (row I6)"); default the target's — a club
   * map's series', else the event's for this source — and the defaults for a job without a target.
   */
  colour?: MapColourSettings;
  /** Wait this long for the job to finish before returning (0 = return at once). */
  holdMs?: number;
}

/**
 * A stored document of the source that importing it now would reproduce:
 * current importer (a source hash has one kind, so the current version of
 * either importer), current library release (the library id follows the
 * map scale), the same decisions applied (docs/map-symbols.md §8.5), the
 * same corrections baked and the same colour setting (§9.3, row I6).
 */
export async function currentDocumentFor(db: Db, sourceHash: string, decisions: readonly mapImport.SymbolDecision[], patch: mapDocument.VersionPatch = [], colour: MapColourSettings = DEFAULT_COLOUR_SETTINGS): Promise<{ hash: string } | null> {
  const candidates = await db.mapDocument.findMany({
    where: { sourceHash, importerVersion: { in: [...IMPORTER_VERSIONS] }, libraryVersion: { endsWith: `@${symbolLibrary.SYMBOL_LIBRARY_VERSION}` } },
    orderBy: { createdAt: "desc" },
    select: { hash: true, report: true, patch: true },
  });
  const recorded = await loadRecordedColours(db, candidates.map((c) => c.hash));
  for (const c of candidates) {
    // The same version patch baked (docs/map-patches.md §5 answer 1); null and [] are none.
    if (!mapDocument.sameVersionPatch(c.patch, patch)) continue;
    if (!documentFollowsColour({ report: c.report, recorded: recorded.get(c.hash) }, colour)) continue;
    if (await storedDocumentFollowsDecisions(db, c, decisions)) return { hash: c.hash };
  }
  return null;
}

/**
 * Insert the job and run it. The club decisions for the source's kind and
 * the map's colour setting are snapshotted into the row, so a re-claim
 * imports with the same input. A
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
  const patch = input.patch ?? [];
  const colour = input.colour ?? (await colourSettingsForJob(db, { ...target, sourceHash: input.sourceHash }));
  const colourJson = colourSettingsJson(colour);
  const existing = await currentDocumentFor(db, input.sourceHash, decisions, patch, colour);
  if (existing) {
    // Touch before the job row references it, so a GC run racing this insert skips the document (§8.2).
    await touchDocument(db, existing.hash);
    const row = asRow(await db.mapImportJob.create({
      data: { ...target, sourceHash: input.sourceHash, decisions: snapshot, patch: patchJson(patch), colour: colourJson, state: "done", stage: "done", progress: 1, documentHash: existing.hash, claimedBy: INSTANCE_ID, heartbeatAt: new Date() },
      select: JOB_SELECT,
    }));
    await applyJobResult(db, row);
    // The thumbnail is awaited as before; the height field is not, so a document stored
    // before H4 does not hold this request for a derive (docs/map-storage.md §6.1).
    await deriveDocumentPreviews(db, existing.hash);
    void deriveDocumentHeightfield(db, existing.hash);
    void enqueueDocumentDem(db, existing.hash, undefined, { requeueFinal: true });
    return row;
  }

  const row = asRow(await db.mapImportJob.create({ data: { ...target, sourceHash: input.sourceHash, decisions: snapshot, patch: patchJson(patch), colour: colourJson, state: "queued" }, select: JOB_SELECT }));
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
