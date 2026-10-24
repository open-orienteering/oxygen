/**
 * The request side of the print worker (docs/course-print.md §8.2): a small
 * pool of long-lived `worker_threads` workers that compose `maps.pdf` pages
 * so the Fastify event loop (card readouts) never waits on a print.
 *
 * - Pool size `PRINT_WORKERS` (default 1, max 4): each worker holds a
 *   decoded document and a font set, so the pool is sized for the CPU and
 *   memory budget, not for throughput.
 * - `printGate` admits as many prints as there are workers. The route takes
 *   it *before* the render permit, so a print waiting for a worker holds no
 *   permit that tile requests need.
 * - A worker is started on first use, `unref`'d while idle, replaced after
 *   it exits, and terminated by `resetPrintWorkers()` (server close).
 */

import { Worker } from "node:worker_threads";
import { course } from "@oxygen/shared";
import { Semaphore, intSetting } from "../map-render-limits.js";
import { workerBootstrap } from "../worker-bootstrap.js";
import type { CoursePagesOptions, CoursePagesResult } from "./pdf-page.js";
import type { PrintWorkerMessage, PrintWorkerRequest } from "./print-worker.js";

export const PRINT_WORKER_TIMEOUT_MS = 10 * 60_000;
const MAX_WORKERS = 4;

export function printWorkerCount(): number {
  return Math.min(MAX_WORKERS, intSetting(process.env.PRINT_WORKERS, 1, 1));
}

export interface WorkerPrintOptions extends Omit<CoursePagesOptions, "document" | "rasteriseSvg"> {
  document: { hash: string; bytes: () => Promise<Uint8Array> };
  timeoutMs?: number;
}

interface Slot {
  worker: Worker | null;
  /** Hashes this worker instance has been sent (it keeps the last two). */
  hashes: string[];
  busy: boolean;
  /** Settles the in-flight request when the worker dies. */
  fail: ((err: Error) => void) | null;
}

let slots: Slot[] = [];
let gate: Semaphore | null = null;
let nextId = 1;

function ensureSlots(): void {
  const n = printWorkerCount();
  if (slots.length === n && gate) return;
  slots = Array.from({ length: n }, () => ({ worker: null, hashes: [], busy: false, fail: null }));
  gate = new Semaphore(n);
}

/** Admission to a worker; the route wraps `renderGate().run` in it. */
export function printGate<T>(task: () => Promise<T>): Promise<T> {
  ensureSlots();
  return gate!.run(task);
}

function startWorker(slot: Slot): Worker {
  const worker = new Worker(workerBootstrap(new URL("./print-worker", import.meta.url), import.meta.url), { eval: true });
  worker.unref();
  const drop = (err: Error) => {
    if (slot.worker !== worker) return;
    slot.worker = null;
    slot.hashes = [];
    const fail = slot.fail;
    slot.fail = null;
    fail?.(err);
  };
  worker.on("error", (err) => drop(err instanceof Error ? err : new Error(String(err))));
  worker.on("exit", (code) => drop(new Error(`print worker exited with code ${code}`)));
  slot.worker = worker;
  slot.hashes = [];
  return worker;
}

function remember(slot: Slot, hash: string): void {
  slot.hashes = [...slot.hashes.filter((h) => h !== hash), hash].slice(-2);
}

async function send(slot: Slot, opts: WorkerPrintOptions, withBytes: boolean): Promise<CoursePagesResult | "need-document"> {
  const worker = slot.worker ?? startWorker(slot);
  const id = nextId++;
  const { hash } = opts.document;
  const bytes = withBytes ? new Uint8Array(await opts.document.bytes()) : undefined;
  const req: PrintWorkerRequest = {
    type: "print",
    id,
    hash,
    ...(bytes ? { bytes } : {}),
    sheets: opts.sheets,
    graphics: [...(opts.graphics ?? new Map())],
    rotationCorrectionDeg: opts.rotationCorrectionDeg,
    mode: opts.mode,
    deterministic: opts.deterministic,
    text: opts.text,
    info: opts.info,
  };
  return new Promise((resolve, reject) => {
    const timeoutMs = opts.timeoutMs ?? PRINT_WORKER_TIMEOUT_MS;
    const timer = setTimeout(() => {
      finish(() => reject(new Error(`print exceeded ${timeoutMs} ms`)));
      void worker.terminate();
    }, timeoutMs);
    const onMessage = (m: PrintWorkerMessage) => {
      if (m.id !== id) return;
      if (m.type === "page") opts.onPage?.({ index: m.index, label: m.label, warnings: m.warnings });
      else if (m.type === "done") finish(() => resolve({ bytes: m.bytes, pageCount: m.pageCount, warnings: m.warnings }));
      else if (m.code === "NeedDocument") finish(() => resolve("need-document"));
      else finish(() => reject(m.code === "CourseStackError" ? new course.CourseStackError(m.message) : new Error(m.message)));
    };
    const finish = (fn: () => void) => {
      clearTimeout(timer);
      worker.off("message", onMessage);
      slot.fail = null;
      worker.unref();
      fn();
    };
    slot.fail = (err) => finish(() => reject(err));
    worker.on("message", onMessage);
    worker.ref();
    if (bytes) worker.postMessage(req, [bytes.buffer as ArrayBuffer]);
    else worker.postMessage(req);
  });
}

/**
 * Compose `opts.sheets` in a worker. The document blob is read and sent
 * only when the chosen worker has not prepared this hash yet. Callers hold
 * `printGate`. A `CourseStackError` in the worker is rethrown as one here.
 */
export async function renderCoursePagesInWorker(opts: WorkerPrintOptions): Promise<CoursePagesResult> {
  ensureSlots();
  const slot = slots.find((s) => !s.busy) ?? slots[0];
  slot.busy = true;
  try {
    const known = slot.worker !== null && slot.hashes.includes(opts.document.hash);
    let out = await send(slot, opts, !known);
    if (out === "need-document") out = await send(slot, opts, true);
    if (out === "need-document") throw new Error("print worker did not accept the document");
    remember(slot, opts.document.hash);
    return out;
  } finally {
    slot.busy = false;
  }
}

/** Terminate every worker (server close, tests); the next print starts fresh ones. */
export async function resetPrintWorkers(): Promise<void> {
  const old = slots;
  slots = [];
  gate = null;
  await Promise.all(
    old.map(async (s) => {
      const w = s.worker;
      s.worker = null;
      s.fail?.(new Error("print worker reset"));
      if (w) await w.terminate();
    }),
  );
}
