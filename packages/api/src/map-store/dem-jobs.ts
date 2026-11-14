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
import { DemFetchError, type DemFailure } from "./dem-cog.js";
import type { DemProvider } from "./dem-providers.js";
import { demProviderById, demProviders } from "./dem-registry.js";
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
 * providers or when that job exists. Kicks the engine; never throws.
 */
export async function enqueueDocumentDem(db: Db, hash: string, providerId?: string): Promise<void> {
  try {
    const list = providerId ? [demProviderById(providerId)].filter((p): p is DemProvider => p !== null) : demProviders();
    for (const p of list) {
      const job = await getDemJob(db, hash, p.info.id);
      if (!job) {
        await db.mapDemJob.createMany({ data: [{ documentHash: hash, provider: p.info.id, version: TERRAIN_VERSION, state: "queued" }], skipDuplicates: true });
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
  if (demProviders().length === 0) return Promise.resolve();
  if (running) return running.then(() => kickDemJobs(db));
  running = (async () => {
    const tried = new Set<string>();
    for (;;) {
      const next = await nextClaimable(db, tried);
      if (!next) break;
      tried.add(`${next.documentHash}/${next.provider}`);
      const provider = demProviderById(next.provider);
      if (!provider || !(await claim(db, next))) continue;
      await serialisedDerive(() => execute(db, next.documentHash, provider));
    }
  })()
    .catch((err: unknown) => console.error("[map-dem] engine:", err))
    .finally(() => {
      running = null;
    });
  return running;
}

async function nextClaimable(db: Db, tried: Set<string>): Promise<{ documentHash: string; provider: string } | null> {
  const now = new Date(), stale = new Date(now.getTime() - DEM_JOB_RULES.staleMs);
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
        { state: "running", OR: [{ heartbeatAt: null }, { heartbeatAt: { lt: stale } }] },
      ],
    },
    data: { state: "running", reason: null, claimedBy: INSTANCE_ID, heartbeatAt: now, attempts: { increment: 1 }, updatedAt: now },
  });
  return count === 1;
}

type Outcome = { kind: "done"; derived: Extract<DemDerived, { type: "done" }>; tiles: number; tilesRead: number } | { kind: "unavailable"; reason: DemUnavailableReason };

async function run(db: Db, hash: string, provider: DemProvider): Promise<Outcome | null> {
  const doc = await db.mapDocument.findUnique({ where: { hash }, select: { header: true } });
  if (!doc) return null;
  if (isOverCap(doc.header)) return { kind: "unavailable", reason: "over-cap" };
  const frame = await documentPaperFrame(db, hash, 0);
  const extent = frame ? documentDemExtent(frame, doc.header) : null;
  if (!frame || !extent) return { kind: "unavailable", reason: "no-georeference" };
  let mosaic;
  try {
    mosaic = await fetchDemMosaic(provider, frame, extent);
  } catch (err: unknown) {
    if (err instanceof DemFetchError && err.reason === "over-cap") return { kind: "unavailable", reason: "over-cap" };
    throw err;
  }
  if (mosaic === "no-coverage") return { kind: "unavailable", reason: "no-coverage" };
  const bytes = await getBlob(db, "map_documents", hash);
  if (!bytes) return null;
  const derived = await (engineOptions.derive ?? deriveDemInWorker)({ bytes: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength), frame, paper: extent.paper, windows: mosaic.windows, provider: provider.info });
  if (derived.type === "unavailable") return { kind: "unavailable", reason: derived.reason };
  return { kind: "done", derived, tiles: mosaic.tiles, tilesRead: mosaic.tilesRead };
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
  const heartbeat = setInterval(() => {
    void db.mapDemJob.updateMany({ where: { documentHash: hash, provider: id, version: TERRAIN_VERSION, claimedBy: INSTANCE_ID, state: "running" }, data: { heartbeatAt: new Date() } }).catch(() => undefined);
  }, DEM_JOB_RULES.heartbeatMs);
  heartbeat.unref();
  const started = Date.now();
  let timer: NodeJS.Timeout | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new DemFetchError("timeout", `the DEM job exceeded ${DEM_JOB_RULES.timeoutMs} ms`)), DEM_JOB_RULES.timeoutMs);
    });
    const out = await Promise.race([run(db, hash, provider), timeout]);
    if (out === null) return; // the document went away (its job row with it)
    if (out.kind === "unavailable") {
      await mark(db, hash, id, { state: "unavailable", reason: out.reason, error: null, nextAttemptAt: null });
      console.log(`[map-dem] ${hash} ${id}: unavailable (${out.reason})`);
      if (out.reason === "no-coverage") void enqueueDocumentDem(db, hash);
      return;
    }
    await writeRows(db, hash, provider, out);
    await mark(db, hash, id, { state: "done", reason: null, error: null, nextAttemptAt: null });
    const g = out.derived.ground.header;
    console.log(`[map-dem] ${hash} ${id}: ${out.tilesRead} tile(s), ${g.width}×${g.height} at ${g.cellMm} mm in ${Date.now() - started} ms`);
  } catch (err: unknown) {
    const reason: DemFailedReason = err instanceof DemFetchError && err.reason !== "over-cap" ? err.reason : "derive";
    const job = await getDemJob(db, hash, id).catch(() => null);
    const retry = demRetryAt(job?.attempts ?? DEM_JOB_RULES.maxAttempts, reason);
    const text = demErrorText(err);
    console.error(`[map-dem] ${hash} ${id} failed (${reason}${retry ? `, retry after ${retry.toISOString()}` : ", final"}): ${text}`);
    await mark(db, hash, id, { state: "failed", reason, error: text, nextAttemptAt: retry }).catch((e: unknown) => console.error(`[map-dem] marking ${hash} ${id} failed:`, e));
  } finally {
    clearTimeout(timer);
    clearInterval(heartbeat);
  }
}

let ticker: NodeJS.Timeout | null = null;

/** The 60 s tick: resumes queued, due and stale jobs nobody kicked. */
export function startDemJobEngine(db: Db, intervalMs: number = DEM_JOB_RULES.staleMs): void {
  if (ticker || demProviders().length === 0) return;
  ticker = setInterval(() => void kickDemJobs(db), intervalMs);
  ticker.unref();
  setTimeout(() => void kickDemJobs(db), 7_000).unref();
}

export function stopDemJobEngine(): void {
  if (ticker) clearInterval(ticker);
  ticker = null;
}
