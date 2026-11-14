/**
 * The device's store of an event's print jobs (docs/course-print.md §8.6
 * "Offline", G17): Cache Storage `offline-print`, written by app code only
 * — no service-worker route, so it works on a page no service worker
 * controls (a first visit, the dev server).
 *
 * | Key (same origin)                                   | Body                                   |
 * |-----------------------------------------------------|----------------------------------------|
 * | `/api/maps/<nameId>/print-job?<normalised query>`   | the job as served, `x-oxygen-stored-at` |
 * | `/api/maps/<nameId>/graphics/<id>/print.png[?w=&h=]`| the PNG as served                       |
 * | `/offline-print/<nameId>`                           | the manifest                            |
 *
 * No IndexedDB copy (07 §9.1). Reads never throw: a store that cannot be
 * opened (no `caches`, a private window) holds nothing.
 */

import type { PrintJob } from "@oxygen/shared/print";

export const OFFLINE_PRINT_CACHE = "offline-print";
/** The events kept: storing a sixth deletes the one stored longest ago. */
export const OFFLINE_PRINT_EVENTS = 5;
/** Layout mode's silent run refreshes an event stored longer ago than this. */
export const OFFLINE_PRINT_REFRESH_MS = 30 * 60_000;
/** The stored job's time (ISO), on its stored response. */
export const STORED_AT_HEADER = "x-oxygen-stored-at";

/** The subset of `Cache` the store uses (tests pass a memory one). */
export interface CacheLike {
  match(key: string, opts?: CacheQueryOptions): Promise<Response | undefined>;
  put(key: string, res: Response): Promise<void>;
  delete(key: string): Promise<boolean>;
  keys(): Promise<readonly { url: string }[]>;
}

export interface CacheStorageLike {
  open(name: string): Promise<CacheLike>;
}

export interface OfflineSkip {
  query: string;
  status: number;
  message: string;
}

/** What a run stored for an event (the sync panel's line reads it). */
export interface OfflinePrintManifest {
  storedAt: string;
  documentHash: string | null;
  jobVersion: number;
  /** The normalised queries whose jobs are stored. */
  queries: string[];
  /** Queries the server answered with an HTTP error (e.g. no setter sheets). */
  skipped: OfflineSkip[];
  /** False when the run ended early (the network went). */
  complete: boolean;
}

export interface StoredJob {
  job: PrintJob;
  storedAt: string;
}

/** `?a=…&b=…` sorted by name, then value; `""` for no parameters. Store and lookup both normalise. */
export function normaliseQuery(query: string): string {
  const params = [...new URLSearchParams(query.startsWith("?") ? query.slice(1) : query)];
  if (params.length === 0) return "";
  params.sort(([a, x], [b, y]) => (a < b ? -1 : a > b ? 1 : x < y ? -1 : x > y ? 1 : 0));
  return `?${new URLSearchParams(params).toString()}`;
}

const eventPrefix = (nameId: string): string => `/api/maps/${encodeURIComponent(nameId)}/`;

export const jobKey = (nameId: string, query: string): string => `${eventPrefix(nameId)}print-job${normaliseQuery(query)}`;

export const manifestKey = (nameId: string): string => `/offline-print/${encodeURIComponent(nameId)}`;

/** `print.png` of a graphic, at `box` for an SVG (§8.5): the request the client makes and its store key. */
export function graphicUrl(nameId: string, id: number, box?: readonly [number, number]): string {
  const base = `${eventPrefix(nameId)}graphics/${id}/print.png`;
  return box ? `${base}?w=${box[0]}&h=${box[1]}` : base;
}

/** The path (and query) of a cache key as `keys()` reports it (absolute in a browser). */
function pathOf(url: string): string {
  try {
    const u = new URL(url, "http://local");
    return `${u.pathname}${u.search}`;
  } catch {
    return url;
  }
}

function isManifest(m: unknown): m is OfflinePrintManifest {
  if (!m || typeof m !== "object") return false;
  const o = m as Partial<OfflinePrintManifest>;
  return typeof o.storedAt === "string" && Array.isArray(o.queries) && Array.isArray(o.skipped) && typeof o.complete === "boolean";
}

export interface OfflinePrintStore {
  putJob(nameId: string, query: string, job: PrintJob, storedAt: string): Promise<void>;
  getJob(nameId: string, query: string): Promise<StoredJob | null>;
  putGraphic(url: string, bytes: ArrayBuffer): Promise<void>;
  getGraphic(url: string): Promise<ArrayBuffer | null>;
  readManifest(nameId: string): Promise<OfflinePrintManifest | null>;
  writeManifest(nameId: string, m: OfflinePrintManifest): Promise<void>;
  /** Deletes the event's jobs and graphics whose keys are not in `keep`. */
  retain(nameId: string, keep: ReadonlySet<string>): Promise<void>;
  /** Keeps the `max` events stored most recently; deletes every entry of the others. */
  pruneEvents(max?: number): Promise<void>;
}

/** The store over `storage` (default: the page's `caches`, null where there is none). */
export function createOfflinePrintStore(storage: () => CacheStorageLike | null = defaultStorage): OfflinePrintStore {
  let opened: Promise<CacheLike | null> | undefined;
  const cache = (): Promise<CacheLike | null> => {
    opened ??= (async () => {
      const s = storage();
      if (!s) return null;
      try {
        return await s.open(OFFLINE_PRINT_CACHE);
      } catch {
        return null;
      }
    })();
    return opened;
  };
  const read = async (key: string): Promise<Response | null> => {
    try {
      return (await (await cache())?.match(key)) ?? null;
    } catch {
      return null;
    }
  };
  const write = async (key: string, res: Response): Promise<void> => {
    const c = await cache();
    if (!c) throw new Error("Cache Storage is not available on this device");
    await c.put(key, res);
  };
  const readManifest = async (nameId: string): Promise<OfflinePrintManifest | null> => {
    const res = await read(manifestKey(nameId));
    const m: unknown = await res?.json().catch(() => null);
    return isManifest(m) ? m : null;
  };
  const deleteWhere = async (pred: (path: string) => boolean): Promise<void> => {
    const c = await cache();
    if (!c) return;
    for (const req of await c.keys()) {
      const path = pathOf(req.url);
      if (pred(path)) await c.delete(path);
    }
  };

  return {
    putJob: (nameId, query, job, storedAt) =>
      write(jobKey(nameId, query), new Response(JSON.stringify(job), { headers: { "content-type": "application/json", [STORED_AT_HEADER]: storedAt } })),
    async getJob(nameId, query) {
      const res = await read(jobKey(nameId, query));
      if (!res) return null;
      const job = (await res.json().catch(() => null)) as PrintJob | null;
      if (!job || typeof job !== "object" || !Array.isArray(job.sheets)) return null;
      return { job, storedAt: res.headers.get(STORED_AT_HEADER) ?? "" };
    },
    putGraphic: (url, bytes) => write(pathOf(url), new Response(bytes, { headers: { "content-type": "image/png" } })),
    async getGraphic(url) {
      const res = await read(pathOf(url));
      return res ? res.arrayBuffer().catch(() => null) : null;
    },
    readManifest,
    writeManifest: (nameId, m) => write(manifestKey(nameId), new Response(JSON.stringify(m), { headers: { "content-type": "application/json" } })),
    async retain(nameId, keep) {
      const prefix = eventPrefix(nameId);
      const kept = new Set([...keep].map(pathOf));
      await deleteWhere((p) => p.startsWith(prefix) && !kept.has(p));
    },
    async pruneEvents(max = OFFLINE_PRINT_EVENTS) {
      const c = await cache();
      if (!c) return;
      const events: { nameId: string; storedAt: string }[] = [];
      for (const req of await c.keys()) {
        const path = pathOf(req.url);
        if (!path.startsWith("/offline-print/")) continue;
        const nameId = decodeURIComponent(path.slice("/offline-print/".length));
        const m = await readManifest(nameId);
        events.push({ nameId, storedAt: m?.storedAt ?? "" });
      }
      events.sort((a, b) => (a.storedAt < b.storedAt ? 1 : a.storedAt > b.storedAt ? -1 : 0));
      for (const { nameId } of events.slice(max)) {
        const prefix = eventPrefix(nameId);
        await deleteWhere((p) => p.startsWith(prefix) || p === manifestKey(nameId));
      }
    },
  };
}

function defaultStorage(): CacheStorageLike | null {
  return typeof caches !== "undefined" ? (caches as unknown as CacheStorageLike) : null;
}

/** The page's store (one per tab). */
export const offlinePrintStore: OfflinePrintStore = createOfflinePrintStore();

// ─── A run's progress, for the buttons and the sync panel (no print chunk needed) ───

export interface OfflinePrintProgress {
  done: number;
  total: number;
}

const progress = new Map<string, OfflinePrintProgress>();
const listeners = new Set<() => void>();

/** The event's running store step, null when none runs. */
export function offlinePrintProgress(nameId: string): OfflinePrintProgress | null {
  return progress.get(nameId) ?? null;
}

/** Sets (null: ends) the event's progress and tells every listener; also called when a run ends, so readers re-read the manifest. */
export function setOfflinePrintProgress(nameId: string, p: OfflinePrintProgress | null): void {
  if (p) progress.set(nameId, p);
  else progress.delete(nameId);
  for (const l of [...listeners]) l();
}

/** Calls `fn` on any event's progress change or run end. */
export function subscribeOfflinePrint(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
