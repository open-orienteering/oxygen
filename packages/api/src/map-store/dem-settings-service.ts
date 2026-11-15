/**
 * Settings → Height data's operations (docs/map-terrain.md §7.8), apart
 * from the router so tests drive them with the recorded fixture: the
 * view, saves, the account, the club maps' DEM states and their retry,
 * and *Test connection*.
 *
 * Nothing returned here carries the password: the status comes from
 * `demSettingsStatus`, job errors and live-check errors pass through
 * `maskSecret`.
 */

import { Worker } from "node:worker_threads";
import { TERRAIN_VERSION } from "@oxygen/shared/src/terrain/field/types.js";
import type { Prisma, PrismaClient } from "../generated/prisma/client.js";
import { workerBootstrap } from "../worker-bootstrap.js";
import { getBlob } from "./blob-store.js";
import type { DemCap } from "./dem-cog.js";
import { demOverCapOf, enqueueDocumentDem, getDemJob, kickDemJobs, requeueAuthFailures } from "./dem-jobs.js";
import type { LiveCheckReport } from "./dem-live-check.js";
import type { LiveCheckWorkerData, LiveCheckWorkerMessage } from "./dem-live-check-worker.js";
import { refreshDemProviders } from "./dem-registry.js";
import { DEM_RULES, documentDemExtent } from "./dem.js";
import { demSettingsStatus, effectiveDemConfig, maskSecret, type DemResolutionM, type DemSettingsStatus, type DemSettingsStore } from "./dem-settings.js";
import { documentPaperFrame } from "./event-document.js";
import { demDescriptor, isOverCap, serialisedDerive, type DemState } from "./heightfield.js";

type Db = PrismaClient | Prisma.TransactionClient;

export const LIVE_CHECK_SERVICE_RULES = {
  /** A `running` record whose run started longer ago than this reads as an error (its instance went away): the worker's limit and a margin. */
  staleMs: 15 * 60_000,
  /** A `queued` record (waiting for the derive queue) older than this reads as an error. */
  queuedStaleMs: 2 * 3_600_000,
  /** The worker's limit. */
  timeoutMs: 10 * 60_000,
} as const;

export interface LiveCheckRecord {
  /** queued: waiting for the derive queue; running: the check runs (since `startedAt`). */
  state: "queued" | "running" | "done" | "error";
  requestedAt: string;
  startedAt: string | null;
  /** An error read from a record left `queued` or `running` too long (§7.8). */
  stale?: boolean;
  finishedAt: string | null;
  clubMapId: string;
  mapName: string;
  by: string | null;
  report: LiveCheckReport | null;
  error: string | null;
}

export type LiveChecker = (input: LiveCheckWorkerData) => Promise<LiveCheckReport>;

/** §7.6's check in a worker thread of its own. */
export function liveCheckInWorker(data: LiveCheckWorkerData, timeoutMs: number = LIVE_CHECK_SERVICE_RULES.timeoutMs): Promise<LiveCheckReport> {
  return new Promise<LiveCheckReport>((resolve, reject) => {
    const worker = new Worker(workerBootstrap(new URL("./dem-live-check-worker", import.meta.url), import.meta.url), { eval: true, workerData: data });
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
      void worker.terminate();
    };
    const timer = setTimeout(() => finish(() => reject(new Error(`the live check exceeded ${timeoutMs} ms`))), timeoutMs);
    worker.on("message", (m: LiveCheckWorkerMessage) => finish(() => (m.type === "error" ? reject(new Error(m.message)) : resolve(m.report))));
    worker.on("error", (err) => finish(() => reject(err)));
    worker.on("exit", (code) => finish(() => reject(new Error(`the live check's worker exited with code ${code}`))));
  });
}

let liveChecker: LiveChecker = (d) => liveCheckInWorker(d);

/** Test seam: run the check in-process over the recorded fixture; null restores the worker. */
export function configureDemLiveCheck(fn: LiveChecker | null): void {
  liveChecker = fn ?? ((d) => liveCheckInWorker(d));
}

export class DemSettingsError extends Error {
  constructor(
    readonly code: "PRECONDITION_FAILED" | "NOT_FOUND" | "BAD_REQUEST" | "CONFLICT",
    message: string,
  ) {
    super(message);
    this.name = "DemSettingsError";
  }
}

// ---- view and saves --------------------------------------------------------------

/** The stored record as shown: one left queued or running too long reads as a stale error (§7.8). */
export function readLiveCheck(raw: unknown, now: Date): LiveCheckRecord | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as LiveCheckRecord;
  const age = (iso: string | null) => (iso ? now.getTime() - Date.parse(iso) : 0);
  if ((r.state === "running" && age(r.startedAt) > LIVE_CHECK_SERVICE_RULES.staleMs) || (r.state === "queued" && age(r.requestedAt) > LIVE_CHECK_SERVICE_RULES.queuedStaleMs))
    return { ...r, state: "error", stale: true, error: null, finishedAt: null };
  return r;
}

export interface DemSettingsView {
  status: DemSettingsStatus;
  liveCheck: LiveCheckRecord | null;
}

export async function demSettingsView(store: DemSettingsStore, env: NodeJS.ProcessEnv, now: Date = new Date()): Promise<DemSettingsView> {
  const [saved, live] = await Promise.all([store.load(), store.getLiveCheck()]);
  return { status: demSettingsStatus(env, saved), liveCheck: readLiveCheck(live, now) };
}

/** Saves the providers and / or the resolution (null resets to the environment), then re-reads the registry and kicks. */
export async function saveDemSettings(db: Db, store: DemSettingsStore, input: { providers?: { lantmateriet: boolean; glo30: boolean } | null; resolutionM?: DemResolutionM | null }): Promise<void> {
  if (input.providers !== undefined) await store.saveProviders(input.providers);
  if (input.resolutionM !== undefined) await store.saveResolution(input.resolutionM);
  await refreshDemProviders();
  void kickDemJobs(db);
}

/** Seals and saves the account; queues every `lantmateriet-*` job that ended `failed: auth` (§7.0b 7). Returns how many. */
export async function setDemAccount(db: Db, store: DemSettingsStore, input: { user: string; password: string; savedBy: string | null }): Promise<number> {
  await store.setAccount(input);
  await refreshDemProviders();
  const queued = await requeueAuthFailures(db, { allLantmateriet: true });
  void kickDemJobs(db);
  return queued;
}

export async function clearDemAccount(store: DemSettingsStore): Promise<void> {
  await store.clearAccount();
  await refreshDemProviders();
}

// ---- the club maps -----------------------------------------------------------------

export type LiveCheckIneligible = "no-georeference" | "over-cap" | "over-1m-cap";

export interface DemMapRow {
  clubMapId: string;
  name: string;
  documentHash: string;
  state: DemState;
  reason: string | null;
  providerId: string | null;
  /** Ground cell of the level read, metres, on a ready map: the provider's, or the next coarser overview's (§7.0c answer 12). */
  readAtM: number | null;
  /** On an `over-cap` ending: the cap it hit (§7.0c answer 12); null when not recorded. */
  overCap: DemCap | null;
  job: { state: string; attempts: number; nextAttemptAt: string | null; error: string | null; updatedAt: string } | null;
  /** Whether a retry would queue something. */
  retryable: boolean;
  /** null: *Test connection* may run on it. */
  liveCheck: LiveCheckIneligible | null;
}

async function latestVersions(db: Db) {
  const series = await db.clubMap.findMany({
    orderBy: { createdAt: "desc" },
    select: { id: true, name: true, rotationCorrection: true, versions: { orderBy: { seq: "desc" }, take: 1, select: { documentHash: true } } },
  });
  return series.flatMap((s) => (s.versions[0] ? [{ id: s.id, name: s.name, rotationCorrection: s.rotationCorrection, documentHash: s.versions[0].documentHash }] : []));
}

/** Whether §7.6 may run on the document (§7.8 "Test connection"), decided from the stored header before any request. */
export async function liveCheckEligibility(db: Db, hash: string, known?: { header: unknown } | null): Promise<LiveCheckIneligible | null> {
  const doc = known !== undefined ? known : await db.mapDocument.findUnique({ where: { hash }, select: { header: true } });
  if (!doc) return "no-georeference";
  if (isOverCap(doc.header)) return "over-cap";
  const frame = await documentPaperFrame(db, hash, 0);
  const extent = frame ? documentDemExtent(frame, doc.header) : null;
  if (!frame || !extent) return "no-georeference";
  const g = extent.groundMPerMm;
  const cells1m = (extent.paper.maxX - extent.paper.minX) * g * ((extent.paper.maxY - extent.paper.minY) * g);
  return cells1m > DEM_RULES.maxMosaicCells ? "over-1m-cap" : null;
}

export async function listDemMaps(db: Db, store: DemSettingsStore, env: NodeJS.ProcessEnv): Promise<DemMapRow[]> {
  await refreshDemProviders();
  const credential = effectiveDemConfig(env, await store.load()).account?.credential ?? null;
  const secrets = credential ? [credential, credential.slice(credential.indexOf(":") + 1)] : [];
  const maps = await latestVersions(db);
  const hashes = [...new Set(maps.map((m) => m.documentHash))];
  // one read each for the jobs and the headers of every map (the panel polls this)
  const [jobs, headers] = await Promise.all([
    db.mapDemJob.findMany({ where: { documentHash: { in: hashes }, version: TERRAIN_VERSION }, select: { documentHash: true, provider: true, state: true, attempts: true, nextAttemptAt: true, error: true, updatedAt: true } }),
    db.mapDocument.findMany({ where: { hash: { in: hashes } }, select: { hash: true, header: true } }),
  ]);
  const rows: DemMapRow[] = [];
  for (const m of maps) {
    const d = await demDescriptor(db, m.documentHash, { rotationCorrection: m.rotationCorrection });
    const job = d.provider ? jobs.find((j) => j.documentHash === m.documentHash && j.provider === d.provider?.id) ?? null : null;
    const header = headers.find((h) => h.hash === m.documentHash) ?? null;
    rows.push({
      clubMapId: m.id,
      name: m.name,
      documentHash: m.documentHash,
      state: d.state,
      reason: d.reason,
      providerId: d.provider?.id ?? null,
      readAtM: d.state === "ready" ? d.provider?.resolutionM ?? null : null,
      overCap: d.state === "unavailable" && d.reason === "over-cap" ? demOverCapOf(job?.error) : null,
      job: job ? { state: job.state, attempts: job.attempts, nextAttemptAt: job.nextAttemptAt?.toISOString() ?? null, error: job.error ? maskSecret(job.error, secrets) : null, updatedAt: job.updatedAt.toISOString() } : null,
      retryable: d.state === "failed" || (d.state === "pending" && !job),
      liveCheck: await liveCheckEligibility(db, m.documentHash, header),
    });
  }
  return rows;
}

async function latestOf(db: Db, clubMapId: string) {
  const m = (await latestVersions(db)).find((v) => v.id === clubMapId);
  if (!m) throw new DemSettingsError("NOT_FOUND", "no such club map, or it has no version");
  return m;
}

/**
 * Queues the club map's DEM again (§7.8 "The state list"): the serving
 * provider's failed job from its first attempt, or a first job. An
 * `unavailable` ending repeats for an immutable document and is refused.
 */
export async function retryDemMap(db: Db, clubMapId: string): Promise<{ queued: boolean }> {
  await refreshDemProviders();
  const m = await latestOf(db, clubMapId);
  const d = await demDescriptor(db, m.documentHash, { rotationCorrection: m.rotationCorrection });
  if (d.state === "disabled") throw new DemSettingsError("PRECONDITION_FAILED", "no height-data provider is on");
  if (d.state === "unavailable") throw new DemSettingsError("BAD_REQUEST", `the map's height data is unavailable (${d.reason ?? "unknown"}); a retry would end the same`);
  if (d.state === "ready") return { queued: false };
  const id = d.provider?.id;
  const job = id ? await getDemJob(db, m.documentHash, id) : null;
  if (id && job?.state === "failed") {
    await db.mapDemJob.updateMany({ where: { documentHash: m.documentHash, provider: id, version: TERRAIN_VERSION, state: "failed" }, data: { state: "queued", reason: null, error: null, attempts: 0, nextAttemptAt: null, updatedAt: new Date() } });
    void kickDemJobs(db);
    return { queued: true };
  }
  if (!job) {
    await enqueueDocumentDem(db, m.documentHash, id);
    return { queued: true };
  }
  return { queued: false }; // queued or running already
}

// ---- Test connection ---------------------------------------------------------------

/**
 * Starts §7.6's live check on a club map (§7.0b 9, §7.8): refuses before
 * any request without an account or on an ineligible map, records
 * `running`, and returns with `done`, the run itself (the router does not
 * await it; tests do).
 */
export async function startDemLiveCheck(db: Db, store: DemSettingsStore, env: NodeJS.ProcessEnv, input: { clubMapId: string; by: string | null }, now: Date = new Date()): Promise<{ record: LiveCheckRecord; done: Promise<void> }> {
  const credential = effectiveDemConfig(env, await store.load()).account?.credential ?? null;
  if (!credential) throw new DemSettingsError("PRECONDITION_FAILED", "no Lantmäteriet account is saved or configured");
  const current = readLiveCheck(await store.getLiveCheck(), now);
  if (current?.state === "running" || current?.state === "queued") throw new DemSettingsError("CONFLICT", "a connection test is already running");
  const m = await latestOf(db, input.clubMapId);
  const ineligible = await liveCheckEligibility(db, m.documentHash);
  if (ineligible) throw new DemSettingsError("BAD_REQUEST", `the map cannot be tested (${ineligible})`);
  const bytes = await getBlob(db, "map_documents", m.documentHash);
  if (!bytes) throw new DemSettingsError("NOT_FOUND", "the map's document is gone");

  const queued: LiveCheckRecord = { state: "queued", requestedAt: now.toISOString(), startedAt: null, finishedAt: null, clubMapId: m.id, mapName: m.name, by: input.by, report: null, error: null };
  await store.setLiveCheck(queued);
  let record = queued;
  const password = credential.slice(credential.indexOf(":") + 1);
  const secrets = [credential, password];
  const document = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // the staleness clock starts when the derive queue gives the check its turn (§7.8)
  const done = serialisedDerive(async () => {
    record = { ...queued, state: "running", startedAt: new Date().toISOString() };
    await store.setLiveCheck(record);
    return liveChecker({ credential, document });
  })
    .then(async (report) => {
      // §7.6's report holds aggregates only (tested); checked whole, never rewritten
      const json = JSON.stringify(report);
      if (json.includes(credential) || (password.length >= 4 && json.includes(password))) throw new Error("the report held the account and was withheld");
      await store.setLiveCheck({ ...record, state: "done", finishedAt: new Date().toISOString(), report });
    })
    .catch(async (err: unknown) => {
      const text = maskSecret(err instanceof Error ? err.message : String(err), secrets).slice(0, 2000);
      console.error(`[map-dem] connection test on ${m.documentHash} failed: ${text}`);
      await store.setLiveCheck({ ...record, state: "error", finishedAt: new Date().toISOString(), error: text });
    })
    .catch((err: unknown) => console.error("[map-dem] storing the connection test's result failed:", err instanceof Error ? err.message : err));
  return { record: queued, done };
}
