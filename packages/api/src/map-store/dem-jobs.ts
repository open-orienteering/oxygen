/**
 * The DEM job (docs/map-storage.md §4.7 "The DEM job"; docs/map-terrain.md
 * §7). A row in `map_dem_jobs` per (document, provider, terrain version):
 * fetch the provider's tiles over the document's extent on this thread,
 * derive the ground and anchored fields in a worker, write the two
 * `map_heightfields` rows. The row is the source of truth: claimed
 * atomically, heartbeaten, re-claimed when stale, retried with back-off.
 *
 * Enqueued at import stage 10 and the dedup short-cut (never awaited),
 * by a route miss, and run by the 60 s tick. Lantmäteriet first; a
 * `no-coverage` ending enqueues the next enabled provider (§7.0 answer 4).
 * One derive at a time per instance, on the height field's queue.
 */

import { Worker } from "node:worker_threads";
import { TERRAIN_VERSION, type HeightFieldHeader } from "@oxygen/shared/src/terrain/field/types.js";
import type { Prisma, PrismaClient } from "../generated/prisma/client.js";
import { workerBootstrap } from "../worker-bootstrap.js";
import { getBlob } from "./blob-store.js";
import { DEM_CAPS, DemFetchError, type DemCap, type DemFailure } from "./dem-cog.js";
import type { DemProvider } from "./dem-providers.js";
import { demProviderById, demProviders, refreshDemProviders } from "./dem-registry.js";
import type { DemDerived, DemWorkerData, DemWorkerMessage } from "./dem-worker.js";
import { documentDemExtent, fetchDemMosaic } from "./dem.js";
import { documentPaperFrame } from "./event-document.js";
import { isOverCap, serialisedDerive } from "./heightfield.js";
import { INSTANCE_ID } from "./instance.js";

type Db = PrismaClient | Prisma.TransactionClient;

export const DEM_JOB_STATES = ["queued", "running", "done", "unavailable", "failed"] as const;
export type DemJobState = (typeof DEM_JOB_STATES)[number];
export type DemUnavailableReason = "no-georeference" | "no-coverage" | "no-contours" | "over-cap" | "misaligned";
export type DemFailedReason = Exclude<DemFailure, "over-cap"> | "derive";

export const DEM_JOB_RULES = {
  heartbeatMs: 10_000,
  staleMs: 60_000,
  /** One job, fetch and derive, at most. */
  timeoutMs: 10 * 60_000,
  /** The derive in its worker. */
  deriveTimeoutMs: 240_000,
  /** After attempt n (1-based) the next is not before `retryMs[n − 1]`; after the last, never. */
  retryMs: [60_000, 10 * 60_000, 3_600_000, 6 * 3_600_000],
  maxAttempts: 5,
  /** A refused credential is not retried sooner than this. */
  authRetryMs: 3_600_000,
  errorMaxChars: 2000,
} as const;

export interface DemJobRow {
  documentHash: string;
  provider: string;
  version: number;
  state: DemJobState;
  reason: string | null;
  error: string | null;
  attempts: number;
  nextAttemptAt: Date | null;
}

// ---- pure ---------------------------------------------------------------------

/** When a job failed after `attempts` attempts may run again; null = never. */
export function demRetryAt(attempts: number, reason: DemFailedReason, now: Date = new Date()): Date | null {
  if (attempts >= DEM_JOB_RULES.maxAttempts) return null;
  const wait = DEM_JOB_RULES.retryMs[Math.max(0, attempts - 1)] ?? DEM_JOB_RULES.retryMs[DEM_JOB_RULES.retryMs.length - 1];
  return new Date(now.getTime() + (reason === "auth" ? Math.max(wait, DEM_JOB_RULES.authRetryMs) : wait));
}

/** Whether this instance may take the job now: queued, failed and due, or running with a stale heartbeat. */
export function isDemClaimable(row: { state: string; nextAttemptAt: Date | null; heartbeatAt: Date | null }, now: Date = new Date()): boolean {
  if (row.state === "queued") return row.nextAttemptAt === null || row.nextAttemptAt <= now;
  if (row.state === "failed") return row.nextAttemptAt !== null && row.nextAttemptAt <= now;
  if (row.state === "running") return row.heartbeatAt === null || now.getTime() - row.heartbeatAt.getTime() > DEM_JOB_RULES.staleMs;
  return false;
}

/** The message stored for a failure: capped, and never the credential (§7.1). */
export function demErrorText(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw.replace(/Basic\s+[A-Za-z0-9+/=]+/g, "Basic …").slice(0, DEM_JOB_RULES.errorMaxChars);
}

/**
 * An `over-cap` ending's stored error: the cap it hit, then the message
 * (map-terrain §7.0c answer 12), capped and masked as `demErrorText`.
 * Every such ending since H13 has one; a null error marks one from
 * before, which `requeueOverCap` queues once.
 */
export function demOverCapText(cap: DemCap, message: string): string {
  return demErrorText(`${cap}: ${message}`);
}

/** The cap an `over-cap` job's error names; null for any other text. */
export function demOverCapOf(error: string | null | undefined): DemCap | null {
  const m = /^([a-z-]+): /.exec(error ?? "");
  return m && (DEM_CAPS as readonly string[]).includes(m[1]) ? (m[1] as DemCap) : null;
}

// ---- worker -------------------------------------------------------------------

export type DemDeriver = (data: DemWorkerData) => Promise<DemDerived>;

/** One derive in a worker thread of its own; the windows' buffers move to it. */
export function deriveDemInWorker(data: DemWorkerData, timeoutMs: number = DEM_JOB_RULES.deriveTimeoutMs): Promise<DemDerived> {
  return new Promise<DemDerived>((resolve, reject) => {
    const transferList = data.windows.map((w) => w.data.buffer as ArrayBuffer);
    const worker = new Worker(workerBootstrap(new URL("./dem-worker", import.meta.url), import.meta.url), { eval: true, workerData: data, transferList });
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
      void worker.terminate();
    };
    const timer = setTimeout(() => finish(() => reject(new DemFetchError("timeout", `DEM derive exceeded ${timeoutMs} ms`))), timeoutMs);
    worker.on("message", (m: DemWorkerMessage) => finish(() => (m.type === "error" ? reject(new Error(m.message)) : resolve(m))));
    worker.on("error", (err) => finish(() => reject(err)));
    worker.on("exit", (code) => finish(() => reject(new Error(`DEM worker exited with code ${code}`))));
  });
}

// ---- engine -------------------------------------------------------------------

export interface DemEngineOptions {
  /** The deriver (tests: in-process); defaults to the worker. */
  derive?: DemDeriver;
  /** Test seam: §7.2's window cap (`DEM_RULES.maxMosaicCells`), lowered so the fixture's tile crosses it. */
  maxMosaicCells?: number;
}

let engineOptions: DemEngineOptions = {};

/** Test seam. */
export function configureDemEngine(opts: DemEngineOptions): void {
  engineOptions = opts;
}

const JOB_SELECT = { documentHash: true, provider: true, version: true, state: true, reason: true, error: true, attempts: true, nextAttemptAt: true } as const;
const asRow = (r: Omit<DemJobRow, "state"> & { state: string }): DemJobRow => ({ ...r, state: r.state as DemJobState });

export async function getDemJob(db: Db, hash: string, provider: string, version: number = TERRAIN_VERSION): Promise<DemJobRow | null> {
  const r = await db.mapDemJob.findUnique({ where: { documentHash_provider_version: { documentHash: hash, provider, version } }, select: JOB_SELECT });
  return r ? asRow(r) : null;
}

/**
 * Queue the document's DEM: `providerId`'s job, or the first enabled
 * provider whose job has not ended `no-coverage`. No-op without enabled
 * providers or when that job exists — except that `requeueFinal` (an
 * import of the document, §4.7) queues a job that failed for good again
 * from its first attempt. Kicks the engine; never throws.
 */
export async function enqueueDocumentDem(db: Db, hash: string, providerId?: string, opts: { requeueFinal?: boolean } = {}): Promise<void> {
  try {
    await refreshDemProviders();
    const list = providerId ? [demProviderById(providerId)].filter((p): p is DemProvider => p !== null) : demProviders();
    for (const p of list) {
      const job = await getDemJob(db, hash, p.info.id);
      if (!job) {
        await db.mapDemJob.createMany({ data: [{ documentHash: hash, provider: p.info.id, version: TERRAIN_VERSION, state: "queued" }], skipDuplicates: true });
        break;
      }
      if (opts.requeueFinal && job.state === "failed" && job.nextAttemptAt === null) {
        await db.mapDemJob.updateMany({ where: { documentHash: hash, provider: p.info.id, version: TERRAIN_VERSION, state: "failed", nextAttemptAt: null }, data: { state: "queued", reason: null, error: null, attempts: 0, updatedAt: new Date() } });
        break;
      }
      if (!(job.state === "unavailable" && job.reason === "no-coverage")) break;
    }
  } catch (err: unknown) {
    console.error(`[map-dem] enqueue ${hash} failed:`, err instanceof Error ? err.message : err);
    return;
  }
  void kickDemJobs(db);
}

let running: Promise<void> | null = null;

/** Run claimable DEM jobs of enabled providers on this instance, one at a time, until none is left. Never throws. */
export function kickDemJobs(db: Db): Promise<void> {
  if (running) return running.then(() => kickDemJobs(db));
  running = (async () => {
    // the settings tab may have changed the providers (map-terrain §7.8)
    const tried = new Set<string>();
    for (;;) {
      // before every claim: a save while the loop runs is followed (map-terrain §7.8)
      await refreshDemProviders();
      if (demProviders().length === 0) break;
      const next = await nextClaimable(db, tried);
      if (!next) break;
      tried.add(`${next.documentHash}/${next.provider}`);
      const provider = demProviderById(next.provider);
      if (!provider || !(await claim(db, next))) continue;
      // the heartbeat runs from the claim, so a job waiting behind another derive is not taken as stale
      const heartbeat = startHeartbeat(db, next.documentHash, provider.info.id);
      try {
        await serialisedDerive(() => execute(db, next.documentHash, provider));
      } finally {
        clearInterval(heartbeat);
      }
    }
  })()
    .catch((err: unknown) => console.error("[map-dem] engine:", err))
    .finally(() => {
      running = null;
    });
  return running;
}

function startHeartbeat(db: Db, hash: string, provider: string): NodeJS.Timeout {
  const t = setInterval(() => {
    void db.mapDemJob.updateMany({ where: { documentHash: hash, provider, version: TERRAIN_VERSION, claimedBy: INSTANCE_ID, state: "running" }, data: { heartbeatAt: new Date() } }).catch(() => undefined);
  }, DEM_JOB_RULES.heartbeatMs);
  t.unref();
  return t;
}

/**
 * A running job went stale after its last attempt: it took its instance
 * down every time (it never reached its own failure path), so it fails
 * for good instead of being re-claimed after each restart (§4.7).
 */
async function failExhausted(db: Db, stale: Date): Promise<void> {
  const { count } = await db.mapDemJob.updateMany({
    where: { version: TERRAIN_VERSION, state: "running", attempts: { gte: DEM_JOB_RULES.maxAttempts }, OR: [{ heartbeatAt: null }, { heartbeatAt: { lt: stale } }] },
    data: { state: "failed", reason: "derive", error: `the job stopped its instance on each of ${DEM_JOB_RULES.maxAttempts} attempts`, nextAttemptAt: null, updatedAt: new Date() },
  });
  if (count > 0) console.error(`[map-dem] ${count} job(s) failed for good after ${DEM_JOB_RULES.maxAttempts} attempts that never finished`);
}

async function nextClaimable(db: Db, tried: Set<string>): Promise<{ documentHash: string; provider: string } | null> {
  const now = new Date(), stale = new Date(now.getTime() - DEM_JOB_RULES.staleMs);
  await failExhausted(db, stale);
  const rows = await db.mapDemJob.findMany({
    where: {
      version: TERRAIN_VERSION,
      provider: { in: demProviders().map((p) => p.info.id) },
      OR: [
        { state: "queued", OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }] },
        { state: "failed", nextAttemptAt: { lte: now } },
        { state: "running", OR: [{ heartbeatAt: null }, { heartbeatAt: { lt: stale } }] },
      ],
    },
    orderBy: { createdAt: "asc" },
    select: { documentHash: true, provider: true },
    take: 16,
  });
  return rows.find((r) => !tried.has(`${r.documentHash}/${r.provider}`)) ?? null;
}

/** Atomic: only a row that is still claimable flips to running and ours. */
async function claim(db: Db, key: { documentHash: string; provider: string }): Promise<boolean> {
  const now = new Date(), stale = new Date(now.getTime() - DEM_JOB_RULES.staleMs);
  const { count } = await db.mapDemJob.updateMany({
    where: {
      documentHash: key.documentHash, provider: key.provider, version: TERRAIN_VERSION,
      OR: [
        { state: "queued", OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }] },
        { state: "failed", nextAttemptAt: { lte: now } },
        { state: "running", attempts: { lt: DEM_JOB_RULES.maxAttempts }, OR: [{ heartbeatAt: null }, { heartbeatAt: { lt: stale } }] },
      ],
    },
    data: { state: "running", reason: null, claimedBy: INSTANCE_ID, heartbeatAt: now, attempts: { increment: 1 }, updatedAt: now },
  });
  return count === 1;
}

type Outcome =
  | { kind: "done"; derived: Extract<DemDerived, { type: "done" }>; tiles: number; tilesRead: number; resolutionM: number }
  | { kind: "unavailable"; reason: DemUnavailableReason; error?: string };

async function run(db: Db, hash: string, provider: DemProvider, signal: { timedOut: boolean }): Promise<Outcome | null> {
  const doc = await db.mapDocument.findUnique({ where: { hash }, select: { header: true } });
  if (!doc) return null;
  if (isOverCap(doc.header)) return { kind: "unavailable", reason: "over-cap", error: demOverCapText("field", "the map's height field is over this instance's cell cap (MAP_HEIGHTFIELD_MAX_CELLS)") };
  const frame = await documentPaperFrame(db, hash, 0);
  const extent = frame ? documentDemExtent(frame, doc.header) : null;
  if (!frame || !extent) return { kind: "unavailable", reason: "no-georeference" };
  let mosaic;
  try {
    mosaic = await fetchDemMosaic(provider, frame, extent, { maxCells: engineOptions.maxMosaicCells });
  } catch (err: unknown) {
    if (err instanceof DemFetchError && err.reason === "over-cap") return { kind: "unavailable", reason: "over-cap", error: demOverCapText(err.cap ?? "window-cells", err.message) };
    throw err;
  }
  if (mosaic === "no-coverage") return { kind: "unavailable", reason: "no-coverage" };
  // past the job's timeout the queue slot is released: start no derive outside it
  if (signal.timedOut) return null;
  const bytes = await getBlob(db, "map_documents", hash);
  if (!bytes || signal.timedOut) return null;
  // the provider block carries the level read (§7.0c answer 12): the paper grid, the anchor's stencil and both headers follow it; the id stays the chosen level
  const read = { ...provider.info, resolutionM: mosaic.resolutionM };
  const derived = await (engineOptions.derive ?? deriveDemInWorker)({ bytes: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength), frame, paper: extent.paper, windows: mosaic.windows, provider: read });
  if (derived.type === "unavailable") return { kind: "unavailable", reason: derived.reason };
  return { kind: "done", derived, tiles: mosaic.tiles, tilesRead: mosaic.tilesRead, resolutionM: mosaic.resolutionM };
}

const json = (v: unknown): Prisma.InputJsonObject => JSON.parse(JSON.stringify(v)) as Prisma.InputJsonObject;

async function writeRows(db: Db, hash: string, provider: DemProvider, out: Extract<Outcome, { kind: "done" }>): Promise<void> {
  const { ground, anchored } = out.derived;
  const row = (source: string, bytes: Uint8Array, header: HeightFieldHeader, report: unknown): Prisma.MapHeightfieldCreateManyInput => ({
    documentHash: hash, source, version: TERRAIN_VERSION, bytes: new Uint8Array(bytes), sizeBytes: bytes.byteLength, header: json(header), report: json(report),
  });
  const groundReport = { dem: { provider: provider.info.id, tiles: out.tiles, tilesRead: out.tilesRead, dataShare: ground.dataShare, fetchedAt: new Date().toISOString() } };
  await db.mapHeightfield.createMany({
    data: [row(`ground.${provider.info.id}`, ground.bytes, ground.header, groundReport), row(`contours.${provider.info.id}`, anchored.bytes, anchored.header, anchored.report)],
    skipDuplicates: true,
  });
}

async function mark(db: Db, hash: string, provider: string, data: Prisma.MapDemJobUpdateManyMutationInput): Promise<void> {
  await db.mapDemJob.updateMany({ where: { documentHash: hash, provider, version: TERRAIN_VERSION, claimedBy: INSTANCE_ID }, data: { ...data, heartbeatAt: new Date(), updatedAt: new Date() } });
}

async function execute(db: Db, hash: string, provider: DemProvider): Promise<void> {
  const id = provider.info.id;
  const started = Date.now();
  const signal = { timedOut: false };
  let timer: NodeJS.Timeout | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        signal.timedOut = true;
        reject(new DemFetchError("timeout", `the DEM job exceeded ${DEM_JOB_RULES.timeoutMs} ms`));
      }, DEM_JOB_RULES.timeoutMs);
    });
    const out = await Promise.race([run(db, hash, provider, signal), timeout]);
    if (out === null) return; // the document went away (its job row with it)
    if (out.kind === "unavailable") {
      await mark(db, hash, id, { state: "unavailable", reason: out.reason, error: out.error ?? null, nextAttemptAt: null });
      console.log(`[map-dem] ${hash} ${id}: unavailable (${out.reason})${out.error ? `: ${out.error}` : ""}`);
      if (out.reason === "no-coverage") void enqueueDocumentDem(db, hash);
      return;
    }
    await writeRows(db, hash, provider, out);
    await mark(db, hash, id, { state: "done", reason: null, error: null, nextAttemptAt: null });
    const g = out.derived.ground.header;
    console.log(`[map-dem] ${hash} ${id}: ${out.tilesRead} tile(s) read at ${out.resolutionM} m, ${g.width}×${g.height} at ${g.cellMm} mm in ${Date.now() - started} ms`);
  } catch (err: unknown) {
    const reason: DemFailedReason = err instanceof DemFetchError && err.reason !== "over-cap" ? err.reason : "derive";
    const job = await getDemJob(db, hash, id).catch(() => null);
    const retry = demRetryAt(job?.attempts ?? DEM_JOB_RULES.maxAttempts, reason);
    const text = demErrorText(err);
    // a new account saved while this ran: the refusal was the old one's (map-terrain §7.8)
    if (reason === "auth") {
      await refreshDemProviders();
      if (demProviderById(id) !== provider) {
        console.log(`[map-dem] ${hash} ${id}: refused on the account that was replaced while it ran; queued again`);
        await mark(db, hash, id, { state: "queued", reason: null, error: null, attempts: 0, nextAttemptAt: null }).catch((e: unknown) => console.error(`[map-dem] requeueing ${hash} ${id}:`, e));
        // this loop has tried it already: the next kick takes it
        setTimeout(() => void kickDemJobs(db), 0).unref();
        return;
      }
    }
    console.error(`[map-dem] ${hash} ${id} failed (${reason}${retry ? `, retry after ${retry.toISOString()}` : ", final"}): ${text}`);
    await mark(db, hash, id, { state: "failed", reason, error: text, nextAttemptAt: retry }).catch((e: unknown) => console.error(`[map-dem] marking ${hash} ${id} failed:`, e));
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Jobs that failed on a refused credential, queued again from their first
 * attempt (§4.7 "Recovery"). At startup, for the enabled Lantmäteriet
 * provider: a changed environment secret reaches an instance only through
 * a new revision or restart. With `allLantmateriet` (an account saved in
 * Settings → Height data, map-terrain §7.8), every `lantmateriet-*` job,
 * whether the provider is on or not. Never throws.
 */
export async function requeueAuthFailures(db: Db, opts: { allLantmateriet?: boolean } = {}): Promise<number> {
  const lm = demProviders().filter((p) => p.name === "lantmateriet").map((p) => p.info.id);
  if (lm.length === 0 && !opts.allLantmateriet) return 0;
  try {
    const provider = opts.allLantmateriet ? { startsWith: "lantmateriet-" } : { in: lm };
    const { count } = await db.mapDemJob.updateMany({ where: { version: TERRAIN_VERSION, provider, state: "failed", reason: "auth" }, data: { state: "queued", reason: null, error: null, attempts: 0, nextAttemptAt: null, updatedAt: new Date() } });
    if (count > 0) console.log(`[map-dem] queued ${count} job(s) that had failed on the credential again`);
    return count;
  } catch (err: unknown) {
    console.error("[map-dem] requeue auth failures:", err instanceof Error ? err.message : err);
    return 0;
  }
}

/**
 * Jobs that ended `unavailable: over-cap` before H13, queued again from
 * their first attempt (map-terrain §7.0c answer 12: the coarser overview
 * can change their result). They are the over-cap endings without an
 * error: every ending since stores the cap it hit, so each is taken once.
 * At engine start, every provider. Never throws.
 */
export async function requeueOverCap(db: Db): Promise<number> {
  try {
    const { count } = await db.mapDemJob.updateMany({
      where: { version: TERRAIN_VERSION, state: "unavailable", reason: "over-cap", error: null },
      data: { state: "queued", reason: null, attempts: 0, nextAttemptAt: null, updatedAt: new Date() },
    });
    if (count > 0) console.log(`[map-dem] queued ${count} job(s) that had ended over the cap again, for the coarser overview`);
    return count;
  } catch (err: unknown) {
    console.error("[map-dem] requeue over-cap endings:", err instanceof Error ? err.message : err);
    return 0;
  }
}

let ticker: NodeJS.Timeout | null = null;

/**
 * The 60 s tick: resumes queued, due and stale jobs nobody kicked, and
 * (through the kick) re-reads the settings, so it runs with no provider
 * on too — one turned on in the tab needs no restart (map-terrain §7.8).
 */
export function startDemJobEngine(db: Db, intervalMs: number = DEM_JOB_RULES.staleMs): void {
  if (ticker) return;
  void refreshDemProviders().then(() => Promise.all([requeueAuthFailures(db), requeueOverCap(db)]));
  ticker = setInterval(() => void kickDemJobs(db), intervalMs);
  ticker.unref();
  setTimeout(() => void kickDemJobs(db), 7_000).unref();
}

export function stopDemJobEngine(): void {
  if (ticker) clearInterval(ticker);
  ticker = null;
}
