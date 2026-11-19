/**
 * `maps.pdf` composed on the device whenever it can (docs/course-print.md
 * §8.6, G16; slice G answer 3), main thread side. Loaded on first export
 * (`lib/download-api.ts` imports it dynamically); the PDF writer lives in
 * the print worker's own chunk.
 *
 * 1. `deviceLimit` 0 (no `Worker`, little memory) → the server's `maps.pdf`.
 * 2. `GET print-job<query>`: a non-2xx is the export's error — the body is
 *    `maps.pdf`'s message word for word (§8.5) — with no second request.
 * 3. Another job `version`, or `printCost` above the limit → `maps.pdf`.
 * 4. The worker composes; this thread answers its requests: the document
 *    from the document cache (`loadMapDocument`, a copy transferred), each
 *    graphic from `print.png` (an SVG at the box the composer asks).
 * 5. Any failure after the job arrived (the worker does not start or dies,
 *    the document cannot be read, the worker's `error`) → `maps.pdf` once.
 *
 * Offline (G17, §8.6 "Offline"): a job request that fails without a
 * response composes the event's stored job (`offline-store.ts`) with its
 * stored graphics and says when it was stored; it never falls back to
 * `maps.pdf`. Online, an event that is stored is kept current (write-through).
 *
 * Where the PDF was made is invisible: the same job, composer, faces and
 * graphics give the server's bytes for equal writer options.
 */

import { fetchDownload } from "../lib/download-api";
import { loadMapDocument } from "../lib/map-document-cache";
import { loadMapFonts } from "../lib/map-fonts";
import { venueAwareFetch } from "../lib/node-discovery";
import type { PrintJob } from "@oxygen/shared/print";
import { type DeviceEnv, deviceEnv, deviceLimit, printCost } from "./capability";
import { graphicUrl, offlinePrintStore, type OfflinePrintStore } from "./offline-store";
import type { PrintFace, PrintWorkerNeed, PrintWorkerRequest, PrintWorkerResponse } from "./protocol";

/**
 * The job version this client's worker composes (`PRINT_JOB_VERSION`;
 * `client.test.ts` keeps them equal). 2 (G14): the job carries the event's
 * patch, which the worker's `renderPrintJob` applies as the server does.
 * 3 (J5): images as passes; a job stored offline at version 2 is
 * `notStored` and must be stored again. 4 (J13): translucent corridor bands;
 * a version-3 job stored offline is `notStored` likewise. 5 (SVG windows):
 * a cropped SVG is asked over its window; a version-4 store lacks those
 * rasters, so it is `notStored` and stored again. 6 (J15): knockout images
 * cut the images below them; a version-5 job is `notStored` likewise. 7 (J18,
 * J19): an attached image may hide its control's circle and number, and a
 * knockout cuts by its graphic's outline; a version-6 job is `notStored`.
 */
export const DEVICE_PRINT_JOB_VERSION = 7;
/** An idle print worker is terminated after this long (its decoded document is large). */
export const PRINT_WORKER_IDLE_MS = 60_000;
/**
 * A worker that says nothing this long while this thread owes it nothing
 * (no page, no request, no result) is taken as dead: the job falls back to
 * the server (step 5). A page takes seconds at most (§11.5).
 */
export const PRINT_WORKER_SILENCE_MS = 60_000;

export interface PrintedPdf {
  blob: Blob;
  filename: string;
  /** Where it was composed (tests, the console). */
  host: "device" | "server";
  /** Composed from the device's stored job (offline): when it was stored (ISO). */
  storedAt?: string;
}

/**
 * Why an export could not be printed offline (§8.6 "Offline" 2a, 2b): no
 * stored job for the query (or one of another version), a stored job
 * above the device's limit, a device that cannot compose with the network
 * gone, or composing the stored job failed. The caller translates `code`.
 */
export type OfflinePrintErrorCode = "notStored" | "tooLarge" | "unsupported" | "failed";

export class OfflinePrintError extends Error {
  readonly code: OfflinePrintErrorCode;
  constructor(code: OfflinePrintErrorCode, message: string = code) {
    super(message);
    this.name = "OfflinePrintError";
    this.code = code;
  }
}

export interface WorkerLike {
  postMessage(msg: PrintWorkerRequest, transfer?: Transferable[]): void;
  onmessage: ((e: MessageEvent<PrintWorkerResponse>) => void) | null;
  onerror: ((e: ErrorEvent) => void) | null;
  terminate(): void;
}

export interface PrintClientDeps {
  env: () => DeviceEnv;
  /** Same-origin `/api/…` requests (`venueAwareFetch`). */
  fetch: (url: string) => Promise<Response>;
  /** The server's PDF: `maps.pdf` downloaded as a blob and its file name (`fetchDownload`). */
  server: (url: string) => Promise<{ blob: Blob; filename: string }>;
  /** The document's bytes by hash, claimed through the event; the caller transfers a copy. */
  document: (hash: string, eventId: string) => Promise<ArrayBuffer>;
  /** The bundled faces in the order regular, narrow, bold (§8.5). */
  faces: () => Promise<PrintFace[]>;
  createWorker: () => WorkerLike;
  /** The device's stored jobs and graphics (G17). */
  store: OfflinePrintStore;
  /** `navigator.onLine` (false: the browser knows it has no network). */
  online: () => boolean;
  /** `PRINT_WORKER_SILENCE_MS` unless given (tests). */
  silenceMs?: number;
}

async function textOf(res: Response): Promise<string> {
  return res.text().catch(() => "");
}

export const defaultDeps: PrintClientDeps = {
  env: deviceEnv,
  fetch: (url) => venueAwareFetch(url),
  server: (url) => fetchDownload(url),
  document: async (hash, eventId) => (await loadMapDocument(hash, { eventId })).bytes,
  faces: async () => (await loadMapFonts()).map((f) => ({ family: f.family, data: f.bytes })),
  createWorker: () => new Worker(new URL("./print-worker-entry.ts", import.meta.url), { type: "module" }) as unknown as WorkerLike,
  store: offlinePrintStore,
  online: () => typeof navigator === "undefined" || navigator.onLine !== false,
};

// ─── The worker: one per tab, one job at a time ──────────────────────

let worker: WorkerLike | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
let nextId = 1;
let chain: Promise<unknown> = Promise.resolve();

function dropWorker(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = null;
  worker?.terminate();
  worker = null;
}

/** For tests: forget the worker and the queue. */
export function resetPrintClient(): void {
  dropWorker();
  chain = Promise.resolve();
}

async function startWorker(deps: PrintClientDeps): Promise<WorkerLike> {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = null;
  if (worker) return worker;
  const faces = await deps.faces();
  const w = deps.createWorker();
  // Copies: the font cache keeps its bytes for the vector viewer.
  const copies = faces.map((f) => ({ family: f.family, data: f.data.slice(0) }));
  w.postMessage({ type: "init", faces: copies }, copies.map((f) => f.data));
  worker = w;
  return w;
}

/** A graphic's bytes by its `print.png` request (fetched, or from the store offline). */
export type GraphicSource = (url: string) => Promise<ArrayBuffer>;

/** `print.png` fetched; a non-2xx rejects (the worker is answered `error`, the writer's warning). */
function fetchGraphic(deps: PrintClientDeps, keep: boolean): GraphicSource {
  return async (url) => {
    const res = await deps.fetch(url);
    if (!res.ok) throw new Error(`print.png ${res.status}`);
    const bytes = await res.arrayBuffer();
    // Write-through (2c, and the store step): a copy, the original is transferred.
    if (keep) await deps.store.putGraphic(url, bytes.slice(0)).catch((err: unknown) => console.warn("offline print: a graphic was not stored", err));
    return bytes;
  };
}

/** The stored `print.png` answer; a miss rejects (`IMAGE_MISSING` / `SVG_RASTER`, as on the server). */
function storedGraphic(deps: PrintClientDeps): GraphicSource {
  return async (url) => {
    const bytes = await deps.store.getGraphic(url);
    if (!bytes) throw new Error(`print.png not stored on this device: ${url}`);
    return bytes;
  };
}

/** Compose `job` in the worker; rejects on any failure (the caller falls back to the server). */
async function composeOnDevice(nameId: string, job: PrintJob, deps: PrintClientDeps, graphic: GraphicSource): Promise<ArrayBuffer> {
  const w = await startWorker(deps);
  const id = nextId++;
  try {
    return await new Promise<ArrayBuffer>((resolve, rejectJob) => {
      // The watchdog runs while the worker owes the next message, paused while this thread fetches for it.
      let watchdog: ReturnType<typeof setTimeout> | null = null;
      let fetching = 0;
      const silence = deps.silenceMs ?? PRINT_WORKER_SILENCE_MS;
      const quiet = () => {
        if (watchdog) clearTimeout(watchdog);
        watchdog = null;
      };
      const arm = () => {
        quiet();
        if (fetching === 0) watchdog = setTimeout(() => reject(new Error(`print worker: silent for ${silence} ms`)), silence);
      };
      const reject = (err: Error) => {
        quiet();
        rejectJob(err);
      };
      const answer = async (need: PrintWorkerNeed): Promise<ArrayBuffer> => {
        if (need.what === "document") return (await deps.document(need.hash, nameId)).slice(0);
        return graphic(graphicUrl(nameId, need.graphicId, need.box, need.window));
      };
      w.onerror = (e) => {
        e.preventDefault?.();
        reject(new Error(`print worker: ${e.message || "failed to start"}`));
      };
      w.onmessage = (e) => {
        const msg = e.data;
        if (msg.id !== id) return;
        switch (msg.type) {
          case "need":
            fetching++;
            arm();
            answer(msg).then(
              (bytes) => {
                fetching--;
                w.postMessage({ type: "reply", reqId: msg.reqId, bytes }, [bytes]);
                arm();
              },
              (err: unknown) => {
                fetching--;
                // A document the device cannot read fails the job; a graphic is the writer's warning, as on the server.
                if (msg.what === "document") reject(err instanceof Error ? err : new Error(String(err)));
                w.postMessage({ type: "reply", reqId: msg.reqId, error: err instanceof Error ? err.message : String(err) });
                arm();
              },
            );
            return;
          case "page":
            arm();
            return;
          case "done":
            quiet();
            for (const warning of msg.warnings) console.warn(`maps.pdf (device): ${warning}`);
            resolve(msg.bytes);
            return;
          case "error":
            reject(new Error(msg.message));
            return;
        }
      };
      w.postMessage({ type: "compose", id, job });
      arm();
    });
  } catch (err) {
    // A failed worker is not reused: the next export starts a fresh one.
    dropWorker();
    throw err;
  } finally {
    if (worker === w) {
      w.onmessage = null;
      idleTimer = setTimeout(dropWorker, PRINT_WORKER_IDLE_MS);
    }
  }
}

async function print(nameId: string, query: string, deps: PrintClientDeps): Promise<PrintedPdf> {
  const route = `/api/maps/${encodeURIComponent(nameId)}`;
  const server = async (): Promise<PrintedPdf> => ({ ...(await deps.server(`${route}/maps.pdf${query}`)), host: "server" });

  const limit = deviceLimit(deps.env());
  if (limit <= 0) {
    // The server prints for this device; with the network gone there is nothing to ask (2b).
    if (!deps.online()) throw new OfflinePrintError("unsupported");
    return server();
  }
  let res: Response;
  try {
    res = await deps.fetch(`${route}/print-job${query}`);
  } catch (err) {
    // No response (2a): the stored job, never maps.pdf.
    console.warn("maps.pdf: the print job could not be fetched; composing the stored job", err);
    return printStored(nameId, query, limit, deps);
  }
  if (!res.ok) throw new Error((await textOf(res)) || `Download failed (${res.status})`);
  // A 2xx that is not a job (a proxy's login page, a cut body) is not the export's error: the server prints.
  const job = (await res.json().catch(() => null)) as PrintJob | null;
  if (!job || typeof job !== "object" || !Array.isArray(job.sheets)) return server();
  if (job.version !== DEVICE_PRINT_JOB_VERSION || printCost(job) > limit) return server();
  // 2c: an event stored on this device follows its exports.
  const keep = (await deps.store.readManifest(nameId)) !== null;
  if (keep) await deps.store.putJob(nameId, query, job, new Date().toISOString()).catch((err: unknown) => console.warn("offline print: the job was not stored", err));
  let bytes: ArrayBuffer;
  try {
    bytes = await composeOnDevice(nameId, job, deps, fetchGraphic(deps, keep));
  } catch (err) {
    console.warn("maps.pdf: composing on the device failed; the server composes", err);
    return server();
  }
  return { blob: new Blob([bytes], { type: "application/pdf" }), filename: job.filename, host: "device" };
}

/** 2a, 2b: the event's stored job for `query`, composed with the stored graphics. */
async function printStored(nameId: string, query: string, limit: number, deps: PrintClientDeps): Promise<PrintedPdf> {
  const stored = await deps.store.getJob(nameId, query);
  if (!stored || stored.job.version !== DEVICE_PRINT_JOB_VERSION) throw new OfflinePrintError("notStored");
  if (printCost(stored.job) > limit) throw new OfflinePrintError("tooLarge");
  let bytes: ArrayBuffer;
  try {
    bytes = await composeOnDevice(nameId, stored.job, deps, storedGraphic(deps));
  } catch (err) {
    console.warn("maps.pdf: composing the stored job failed", err);
    throw new OfflinePrintError("failed", err instanceof Error ? err.message : String(err));
  }
  return { blob: new Blob([bytes], { type: "application/pdf" }), filename: stored.job.filename, host: "device", storedAt: stored.storedAt };
}

/** Runs `fn` in the export queue (one at a time per tab). */
function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn);
  chain = run.catch(() => undefined);
  return run;
}

/**
 * The store step's compose (§8.6 "Offline" step 6): `job` composed in the
 * export queue with every `print.png` fetched and stored, so the SVG boxes
 * the composer asks are on the device. The PDF is dropped.
 */
export function composeToStore(nameId: string, job: PrintJob, deps: PrintClientDeps = defaultDeps): Promise<void> {
  return enqueue(async () => {
    await composeOnDevice(nameId, job, deps, fetchGraphic(deps, true));
  });
}

/** Starts the print worker (its chunk then sits in the service worker's `print-worker` cache), in the queue. */
export function warmPrintWorker(deps: PrintClientDeps = defaultDeps): Promise<void> {
  return enqueue(async () => {
    await startWorker(deps);
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(dropWorker, PRINT_WORKER_IDLE_MS);
  });
}

/**
 * `maps.pdf<query>` for event `nameId`, composed on this device when it
 * can and by the server otherwise (§8.6). Exports run one at a time.
 */
export function printMapsPdf(nameId: string, query: string, deps: PrintClientDeps = defaultDeps): Promise<PrintedPdf> {
  return enqueue(() => print(nameId, query, deps));
}
