/**
 * *Make maps available offline* (docs/course-print.md §8.6 "Offline",
 * G17): stores an event's print jobs, their `print.png` answers, the
 * faces and the document on this device, so its map exports compose with
 * no network. Run by the explicit action (Export ▾, the Courses page, the
 * sync panel) and silently when Layout mode opens (`auto`).
 *
 * 1. Explicit action with `courses.edit`: the caller's `ensure` (the sheets,
 *    as *All courses* and *All controls* do).
 * 2. The stored set: `offlineMapQueries` over the event's courses,
 *    variants, classes and sheets.
 * 3. Each query's job, four at a time; an HTTP error is `skipped`, a
 *    network failure ends the run (`complete: false`; so does a graphic
 *    the server refuses). Any other failure is an `OfflinePrepareError`,
 *    after the manifest of what was stored.
 * 4. The document; 5. the faces (and their files into `map-fonts`).
 * 6. PNG graphics once; SVG boxes learned by composing the distinct sheets
 *    that draw an SVG, in jobs within the device's limit.
 * 7. The manifest, then old entries and old events pruned.
 */

import type { PrintJob } from "@oxygen/shared/print";
import { offlineMapQueries, type OfflineQueryInput } from "../lib/editor/export-menu";
import { loadMapDocument } from "../lib/map-document-cache";
import { loadMapFonts, MAP_FONT_URLS } from "../lib/map-fonts";
import { venueAwareFetch } from "../lib/node-discovery";
import { type DeviceEnv, deviceEnv, deviceLimit, printCost } from "./capability";
import { composeToStore, defaultDeps as defaultPrintDeps, DEVICE_PRINT_JOB_VERSION, type PrintClientDeps, warmPrintWorker } from "./client";
import {
  graphicUrl,
  jobKey,
  normaliseQuery,
  OFFLINE_PRINT_REFRESH_MS,
  offlinePrintStore,
  type OfflinePrintManifest,
  type OfflinePrintStore,
  type OfflineSkip,
  setOfflinePrintProgress,
} from "./offline-store";

type PrintSheet = PrintJob["sheets"][number];

/** Job requests in flight at once. */
const JOB_CONCURRENCY = 4;

export type PrepareStatus = "stored" | "partial" | "unsupported" | "fresh" | "offline";

export interface PrepareResult {
  status: PrepareStatus;
  manifest: OfflinePrintManifest | null;
}

export interface PrepareOptions {
  /** Layout mode's silent run: only online, only when the stored event is older than `OFFLINE_PRINT_REFRESH_MS`, no `ensure`. */
  auto?: boolean;
  /** Step 1 (explicit action under `courses.edit`): ensure the sheets; failures are the caller's to swallow. */
  ensure?: () => Promise<void>;
}

export interface PrepareDeps {
  env: () => DeviceEnv;
  online: () => boolean;
  now: () => Date;
  lists: (nameId: string) => Promise<OfflineQueryInput>;
  fetch: (url: string) => Promise<Response>;
  store: OfflinePrintStore;
  document: (hash: string, eventId: string) => Promise<unknown>;
  /** The faces loaded and their files kept for a reload (`map-fonts`). */
  faces: () => Promise<void>;
  /** The print client's deps for composing (its store is replaced by the run's recording one). */
  print: PrintClientDeps;
  compose: (nameId: string, job: PrintJob, deps: PrintClientDeps) => Promise<void>;
  warm: (deps: PrintClientDeps) => Promise<void>;
}

async function eventLists(nameId: string): Promise<OfflineQueryInput> {
  // Loaded here, not at module load: the tests drive the step without a page.
  const { trpcVanillaClient } = await import("../lib/trpc");
  const [courses, classes, sheets] = await Promise.all([
    trpcVanillaClient.course.list.query(),
    trpcVanillaClient.class.list.query(),
    trpcVanillaClient.courseMap.list.query(),
  ]);
  const roots = courses.filter((c) => c.parentCourseId === null && courses.some((v) => v.parentCourseId === c.id));
  const variants = new Map(
    await Promise.all(
      roots.map(async (r) => {
        const list = await trpcVanillaClient.course.variantList.query({ courseId: r.id });
        return [r.id, list.map((v) => ({ key: v.variantKey, runnerCount: v.runnerCount }))] as const;
      }),
    ),
  );
  return {
    nameId,
    courses: courses.map((c) => ({ seq: c.id, parentSeq: c.parentCourseId })),
    variants,
    classes: classes.map((k) => ({ seq: k.id, courseSeq: k.courseId || null })),
    sheetSeqs: sheets.map((s) => s.seq),
  };
}

async function keepFaces(): Promise<void> {
  await loadMapFonts();
  if (typeof caches === "undefined") return;
  try {
    const cache = await caches.open("map-fonts");
    for (const url of MAP_FONT_URLS) if (!(await cache.match(url))) await cache.add(url);
  } catch (err) {
    console.warn("offline print: the faces were not kept in map-fonts", err);
  }
}

export const defaultPrepareDeps: PrepareDeps = {
  env: deviceEnv,
  online: () => typeof navigator === "undefined" || navigator.onLine !== false,
  now: () => new Date(),
  lists: eventLists,
  fetch: (url) => venueAwareFetch(url),
  store: offlinePrintStore,
  document: (hash, eventId) => loadMapDocument(hash, { eventId }),
  faces: keepFaces,
  print: defaultPrintDeps,
  compose: composeToStore,
  warm: warmPrintWorker,
};

const SVG = "image/svg+xml";

/** The graphic ids a sheet draws (its image objects' `graphicId`). */
function sheetGraphicIds(sheet: PrintSheet): Set<number> {
  const ids = new Set<number>();
  for (const m of JSON.stringify(sheet).matchAll(/"graphicId":(\d+)/g)) ids.add(Number(m[1]));
  return ids;
}

/**
 * Step 6's jobs: the distinct sheets (without their copies) that draw an
 * SVG graphic, chunked so each job stays within `limit`; each job lists the
 * graphics its sheets draw. Composing them asks every SVG box once.
 */
export function boxLearningJobs(jobs: readonly PrintJob[], limit: number): PrintJob[] {
  const seen = new Set<string>();
  const picked: { sheet: PrintSheet; graphics: PrintJob["graphics"]; job: PrintJob }[] = [];
  for (const job of jobs) {
    const svg = new Set(job.graphics.filter((g) => g.mime === SVG).map((g) => g.id));
    if (svg.size === 0) continue;
    for (const s of job.sheets) {
      const ids = sheetGraphicIds(s);
      if (![...ids].some((id) => svg.has(id))) continue;
      const sheet: PrintSheet = { ...s, copies: 1 };
      const key = JSON.stringify(sheet);
      if (seen.has(key)) continue;
      seen.add(key);
      picked.push({ sheet, graphics: job.graphics.filter((g) => ids.has(g.id)), job });
    }
  }
  const out: PrintJob[] = [];
  let chunk: typeof picked = [];
  const flush = () => {
    if (chunk.length === 0) return;
    const graphics = new Map<number, PrintJob["graphics"][number]>();
    for (const p of chunk) for (const g of p.graphics) graphics.set(g.id, g);
    out.push({ ...chunk[0].job, sheets: chunk.map((p) => p.sheet), graphics: [...graphics.values()].sort((a, b) => a.id - b.id) });
    chunk = [];
  };
  for (const p of picked) {
    if (chunk.length > 0 && printCost({ sheets: [...chunk.map((c) => c.sheet), p.sheet] }) > limit) flush();
    chunk.push(p);
  }
  flush();
  return out;
}

class NetworkGone extends Error {}

/**
 * The store step failed for another reason than the network (Cache Storage
 * refused a write, the lists or the document were refused): the callers
 * show a translated message; the cause goes to the console.
 */
export class OfflinePrepareError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = "OfflinePrepareError";
  }
}

/** A failure without a response (a `fetch` `TypeError`, the document cache's `offline` kind) is the network going. */
function networkGone(err: unknown): boolean {
  if (err instanceof NetworkGone || err instanceof TypeError) return true;
  return !!err && typeof err === "object" && (err as { name?: unknown; kind?: unknown }).name === "MapDocumentError" && (err as { kind?: unknown }).kind === "offline";
}

interface Running {
  promise: Promise<PrepareResult>;
  auto: boolean;
}

/**
 * One run per event per tab. A second caller joins a run in flight —
 * except an explicit action that finds a silent run (Layout mode): it waits
 * for that run and then makes its own (the ensure step, no throttle).
 */
const running = new Map<string, Running>();

export function prepareOfflinePrint(nameId: string, opts: PrepareOptions = {}, deps: PrepareDeps = defaultPrepareDeps): Promise<PrepareResult> {
  const hit = running.get(nameId);
  if (hit && (opts.auto || !hit.auto)) return hit.promise;
  const auto = !!opts.auto;
  const after = hit ? hit.promise.catch(() => undefined) : Promise.resolve();
  const promise = after.then(() => run(nameId, opts, deps)).finally(() => {
    if (running.get(nameId)?.promise === promise) running.delete(nameId);
    setOfflinePrintProgress(nameId, null);
  });
  running.set(nameId, { promise, auto });
  return promise;
}

async function run(nameId: string, opts: PrepareOptions, deps: PrepareDeps): Promise<PrepareResult> {
  const prior = await deps.store.readManifest(nameId);
  const limit = deviceLimit(deps.env());
  if (limit <= 0) return { status: "unsupported", manifest: prior };
  if (!deps.online()) return { status: "offline", manifest: prior };
  if (opts.auto && prior?.complete && deps.now().getTime() - Date.parse(prior.storedAt) < OFFLINE_PRINT_REFRESH_MS) {
    return { status: "fresh", manifest: prior };
  }

  const storedAt = deps.now().toISOString();
  // Every key this run writes, so the event's other entries can go.
  const kept = new Set<string>();
  const store: OfflinePrintStore = {
    ...deps.store,
    putGraphic: async (url, bytes) => {
      kept.add(url);
      await deps.store.putGraphic(url, bytes);
    },
  };
  const jobs: { query: string; job: PrintJob }[] = [];
  const skipped: OfflineSkip[] = [];
  /** `print.png` requests answered with an HTTP error: the export would print without them. */
  const missingGraphics: OfflineSkip[] = [];
  let done = 0;
  let total = 1;
  const tick = () => setOfflinePrintProgress(nameId, { done: ++done, total });
  let complete = true;
  let failure: unknown = null;

  /** A graphic request of this run: a thrown fetch is the network going, an HTTP error a missing graphic. */
  const graphicFetch = async (url: string): Promise<Response> => {
    let res: Response;
    try {
      res = await deps.fetch(url);
    } catch (err) {
      throw new NetworkGone(err instanceof Error ? err.message : String(err));
    }
    if (!res.ok) missingGraphics.push({ query: url, status: res.status, message: (await res.clone().text().catch(() => "")).slice(0, 200) });
    return res;
  };

  try {
    if (!opts.auto && opts.ensure) await opts.ensure();
    const queries = offlineMapQueries(await deps.lists(nameId));
    // Progress: the jobs, then the PNGs and compose chunks once known.
    total = queries.length + 1;
    setOfflinePrintProgress(nameId, { done, total });
    let next = 0;
    const worker = async () => {
      while (next < queries.length) {
        const query = queries[next++];
        let res: Response;
        try {
          res = await deps.fetch(`/api/maps/${encodeURIComponent(nameId)}/print-job${query}`);
        } catch (err) {
          throw new NetworkGone(err instanceof Error ? err.message : String(err));
        }
        if (!res.ok) {
          skipped.push({ query, status: res.status, message: (await res.text().catch(() => "")).slice(0, 200) });
        } else {
          const job = (await res.json().catch(() => null)) as PrintJob | null;
          if (!job || !Array.isArray(job.sheets) || job.version !== DEVICE_PRINT_JOB_VERSION) {
            skipped.push({ query, status: res.status, message: "not a print job this device composes" });
          } else {
            await deps.store.putJob(nameId, query, job, storedAt);
            kept.add(jobKey(nameId, query));
            jobs.push({ query, job });
          }
        }
        tick();
      }
    };
    await Promise.all(Array.from({ length: Math.min(JOB_CONCURRENCY, queries.length) }, worker));

    const documentHash = jobs[0]?.job.document.hash ?? null;
    if (documentHash) await deps.document(documentHash, nameId);
    await deps.faces();

    const pngs = new Set<number>();
    for (const { job } of jobs) for (const g of job.graphics) if (g.mime === "image/png") pngs.add(g.id);
    const learn = boxLearningJobs(jobs.map((j) => j.job), limit);
    total += pngs.size + learn.length;
    for (const id of pngs) {
      const url = graphicUrl(nameId, id);
      const res = await graphicFetch(url);
      if (res.ok) await store.putGraphic(url, await res.arrayBuffer());
      tick();
    }
    // The compose's print.png requests go through the same accounting (an SVG box that failed is not stored).
    const net: { gone: NetworkGone | null } = { gone: null };
    const printDeps: PrintClientDeps = {
      ...deps.print,
      store,
      fetch: (url) =>
        graphicFetch(url).catch((err: unknown) => {
          if (err instanceof NetworkGone) net.gone = err;
          throw err;
        }),
    };
    for (const job of learn) {
      await deps.compose(nameId, job, printDeps);
      if (net.gone) throw net.gone;
      tick();
    }
    // The worker's chunk reaches the service worker's cache when the worker starts.
    if (learn.length === 0) await deps.warm(printDeps);
    tick();
  } catch (err) {
    complete = false;
    if (networkGone(err)) console.warn("offline print: the network went while storing; the event is partly stored", err);
    else failure = err;
  }
  if (missingGraphics.length > 0) {
    complete = false;
    console.warn("offline print: graphics that could not be stored", missingGraphics);
  }

  const manifest: OfflinePrintManifest = {
    storedAt,
    documentHash: jobs[0]?.job.document.hash ?? prior?.documentHash ?? null,
    jobVersion: DEVICE_PRINT_JOB_VERSION,
    queries: jobs.map((j) => normaliseQuery(j.query)),
    skipped: [...skipped, ...missingGraphics],
    complete,
  };
  // Written on every end once a job is stored, so the stored jobs are always under a manifest (the panel, write-through, pruning).
  if (jobs.length > 0 || !failure) {
    try {
      await deps.store.writeManifest(nameId, manifest);
      // A partial run keeps what an earlier run stored.
      if (complete) await deps.store.retain(nameId, kept);
      await deps.store.pruneEvents();
    } catch (err) {
      failure ??= err;
    }
  }
  if (failure) {
    console.warn("offline print: storing failed", failure);
    throw new OfflinePrepareError(failure);
  }
  return { status: complete ? "stored" : "partial", manifest };
}

/** For tests: forget runs in flight. */
export function resetOfflinePrepare(): void {
  running.clear();
}
