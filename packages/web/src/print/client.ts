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
 * Where the PDF was made is invisible: the same job, composer, faces and
 * graphics give the server's bytes for equal writer options.
 */

import { fetchDownload } from "../lib/download-api";
import { loadMapDocument } from "../lib/map-document-cache";
import { loadMapFonts } from "../lib/map-fonts";
import { venueAwareFetch } from "../lib/node-discovery";
import type { PrintJob } from "@oxygen/shared/print";
import { type DeviceEnv, deviceEnv, deviceLimit, printCost } from "./capability";
import type { PrintFace, PrintWorkerNeed, PrintWorkerRequest, PrintWorkerResponse } from "./protocol";

/**
 * The job version this client's worker composes (`PRINT_JOB_VERSION`;
 * `client.test.ts` keeps them equal). 2 (G14): the job carries the event's
 * patch, which the worker's `renderPrintJob` applies as the server does.
 */
export const DEVICE_PRINT_JOB_VERSION = 2;
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

function graphicUrl(nameId: string, id: number, box?: [number, number]): string {
  const base = `/api/maps/${encodeURIComponent(nameId)}/graphics/${id}/print.png`;
  return box ? `${base}?w=${box[0]}&h=${box[1]}` : base;
}

/** Compose `job` in the worker; rejects on any failure (the caller falls back to the server). */
async function composeOnDevice(nameId: string, job: PrintJob, deps: PrintClientDeps): Promise<ArrayBuffer> {
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
        const res = await deps.fetch(graphicUrl(nameId, need.graphicId, need.box));
        if (!res.ok) throw new Error(`print.png ${res.status}`);
        return res.arrayBuffer();
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
  if (limit <= 0) return server();
  const res = await deps.fetch(`${route}/print-job${query}`);
  if (!res.ok) throw new Error((await textOf(res)) || `Download failed (${res.status})`);
  // A 2xx that is not a job (a proxy's login page, a cut body) is not the export's error: the server prints.
  const job = (await res.json().catch(() => null)) as PrintJob | null;
  if (!job || typeof job !== "object" || !Array.isArray(job.sheets)) return server();
  if (job.version !== DEVICE_PRINT_JOB_VERSION || printCost(job) > limit) return server();
  let bytes: ArrayBuffer;
  try {
    bytes = await composeOnDevice(nameId, job, deps);
  } catch (err) {
    console.warn("maps.pdf: composing on the device failed; the server composes", err);
    return server();
  }
  return { blob: new Blob([bytes], { type: "application/pdf" }), filename: job.filename, host: "device" };
}

/**
 * `maps.pdf<query>` for event `nameId`, composed on this device when it
 * can and by the server otherwise (§8.6). Exports run one at a time.
 */
export function printMapsPdf(nameId: string, query: string, deps: PrintClientDeps = defaultDeps): Promise<PrintedPdf> {
  const run = chain.then(() => print(nameId, query, deps));
  chain = run.catch(() => undefined);
  return run;
}
