/**
 * Map documents for the viewer (docs/map-storage.md §7.1): one
 * `GET /api/map-documents/:hash` per hash (through `venueAwareFetch`, so
 * a venue session reads the box's copy), the bytes kept in memory for the
 * session. Cache Storage `map-documents` is the persistent copy: the
 * service worker's CacheFirst route (`vite.config.ts`) fills it on a page
 * it controls, and the app puts a document there itself and reads it back
 * when the network fails (G17, "App-code copy"), so a page no service
 * worker controls keeps it too. There is no IndexedDB copy (07 §9.1).
 *
 * The request carries the event and kiosk key as headers, never in the
 * query, so the URL — and with it the service worker's cache key — is
 * the hash alone: a club map pinned by several events is cached once.
 *
 * The event's patch (docs/map-patches.md §3.3) comes beside the document:
 * `GET /api/maps/:nameId/patch`, kept per event for the session and
 * revalidated by ETag (`useMapPatch`). It is not in Cache Storage.
 */

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { mapDocument } from "@oxygen/shared";
import { kioskKeyFromUrl } from "./kiosk-key";
import { venueAwareFetch } from "./node-discovery";

/** The document route without previews (`/thumbnail.png`, `/symbols/…`); `vite.config.ts` repeats it. */
export const MAP_DOCUMENT_PATH_RE = /^\/api\/map-documents\/[0-9a-f]{64}$/;

export const mapDocumentUrl = (hash: string): string => `/api/map-documents/${hash}`;

/** The service worker's document cache (`vite.config.ts`), shared with the app-code copy. */
export const MAP_DOCUMENTS_CACHE = "map-documents";

/** The subset of Cache Storage the app-code copy uses (tests pass a memory one). */
export interface DocumentCacheStorage {
  open(name: string): Promise<{
    match(key: string, opts?: CacheQueryOptions): Promise<Response | undefined>;
    put(key: string, res: Response): Promise<void>;
  }>;
}

const pageCaches = (): DocumentCacheStorage | null =>
  typeof caches !== "undefined" ? (caches as unknown as DocumentCacheStorage) : null;

export type MapDocumentErrorKind = "unauthorised" | "missing" | "offline" | "failed";

export class MapDocumentError extends Error {
  readonly kind: MapDocumentErrorKind;
  constructor(kind: MapDocumentErrorKind, message: string) {
    super(message);
    this.name = "MapDocumentError";
    this.kind = kind;
  }
}

export interface LoadedMapDocument {
  hash: string;
  /** The whole document; callers that transfer it to a worker pass a copy. */
  bytes: ArrayBuffer;
  header: mapDocument.MapDocumentHeader;
}

export interface FetchOptions {
  /** Event nameId the document is claimed through (`x-event-id`). */
  eventId?: string | null;
  /** Kiosk key (`x-kiosk-key`); default: the page URL's `?k=`. */
  kioskKey?: string | null;
  /** Default `venueAwareFetch`. */
  fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>;
  /** Default the page's `caches` (null: none). */
  cacheStorage?: DocumentCacheStorage | null;
}

/** The stored copy's response, null on a miss or where Cache Storage is unavailable. */
async function storedDocument(hash: string, storage: DocumentCacheStorage | null): Promise<Response | null> {
  if (!storage) return null;
  try {
    // The route sends `Vary: Accept-Encoding`; the request headers differ (the event), the bytes do not.
    return (await (await storage.open(MAP_DOCUMENTS_CACHE)).match(mapDocumentUrl(hash), { ignoreVary: true })) ?? null;
  } catch {
    return null;
  }
}

/** Puts `bytes` under the hash URL unless a copy is there (the service worker's, on a page it controls). */
async function keepDocument(hash: string, bytes: ArrayBuffer, storage: DocumentCacheStorage | null): Promise<void> {
  if (!storage) return;
  try {
    const cache = await storage.open(MAP_DOCUMENTS_CACHE);
    if (await cache.match(mapDocumentUrl(hash), { ignoreVary: true })) return;
    await cache.put(mapDocumentUrl(hash), new Response(bytes.slice(0), { status: 200, headers: { "content-type": "application/octet-stream" } }));
  } catch (err) {
    console.warn("[map-document] not kept in Cache Storage:", err);
  }
}

/** Documents kept decoded-header + bytes in memory; older ones are dropped (Cache Storage still has them). */
export const MEMORY_ENTRIES = 4;

const loaded = new Map<string, Promise<LoadedMapDocument>>();

/** Loads a document once per hash; concurrent callers share the request and the same bytes. */
export function loadMapDocument(hash: string, opts: FetchOptions = {}): Promise<LoadedMapDocument> {
  const hit = loaded.get(hash);
  if (hit) {
    loaded.delete(hash);
    loaded.set(hash, hit);
    return hit;
  }
  const p = fetchDocument(hash, opts);
  loaded.set(hash, p);
  // A failure is not cached: the next call (retry) asks again.
  p.catch(() => {
    if (loaded.get(hash) === p) loaded.delete(hash);
  });
  while (loaded.size > MEMORY_ENTRIES) loaded.delete(loaded.keys().next().value as string);
  return p;
}

function documentHeaders(opts: FetchOptions): Record<string, string> {
  const headers: Record<string, string> = {};
  if (opts.eventId) headers["x-event-id"] = opts.eventId;
  const kioskKey = opts.kioskKey !== undefined ? opts.kioskKey : kioskKeyFromUrl();
  if (kioskKey) headers["x-kiosk-key"] = kioskKey;
  return headers;
}

async function fetchDocument(hash: string, opts: FetchOptions): Promise<LoadedMapDocument> {
  const headers = documentHeaders(opts);
  const f = opts.fetchImpl ?? venueAwareFetch;
  const storage = opts.cacheStorage !== undefined ? opts.cacheStorage : pageCaches();
  let res: Response;
  let fromNetwork = true;
  try {
    res = await f(mapDocumentUrl(hash), { headers });
  } catch (err) {
    // No response: the stored copy, else 07 §9.1's eviction detection.
    const stored = await storedDocument(hash, storage);
    if (!stored) throw new MapDocumentError(isOffline() ? "offline" : "failed", err instanceof Error ? err.message : String(err));
    res = stored;
    fromNetwork = false;
  }
  if (res.status === 401 || res.status === 403) throw new MapDocumentError("unauthorised", `map document ${res.status}`);
  if (res.status === 404) throw new MapDocumentError("missing", "map document not found");
  if (!res.ok) {
    const stored = isOffline() ? await storedDocument(hash, storage) : null;
    if (!stored) throw new MapDocumentError(isOffline() ? "offline" : "failed", `map document ${res.status}`);
    res = stored;
    fromNetwork = false;
  }
  const bytes = await res.arrayBuffer();
  let header: mapDocument.MapDocumentHeader;
  try {
    header = mapDocument.readMapDocumentHeader(new Uint8Array(bytes)).header;
  } catch (err) {
    throw new MapDocumentError("failed", `unreadable map document: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (fromNetwork) await keepDocument(hash, bytes, storage);
  void requestPersistentStorage();
  return { hash, bytes, header };
}

const prefetched = new Map<string, Promise<boolean>>();

/**
 * Warms the device's copy of an event's document (map-storage.md §7.1
 * "Prefetch", 07 §9.1): one request unless it is in memory or in
 * `map-documents`; stored, not decoded, not kept in memory. Once per hash
 * per session; skipped offline and when the browser asks to save data.
 * Resolves whether the document is stored afterwards; never rejects.
 */
export function prefetchMapDocument(hash: string, eventId: string, opts: Omit<FetchOptions, "eventId"> = {}): Promise<boolean> {
  let p = prefetched.get(hash);
  if (p) return p;
  p = (async () => {
    const storage = opts.cacheStorage !== undefined ? opts.cacheStorage : pageCaches();
    if (loaded.has(hash) || (await storedDocument(hash, storage))) return true;
    if (isOffline() || saveData()) return false;
    try {
      const res = await (opts.fetchImpl ?? venueAwareFetch)(mapDocumentUrl(hash), { headers: documentHeaders({ ...opts, eventId }) });
      if (res.status !== 200) return false;
      await keepDocument(hash, await res.arrayBuffer(), storage);
      void requestPersistentStorage();
      return (await storedDocument(hash, storage)) !== null;
    } catch {
      return false;
    }
  })();
  prefetched.set(hash, p);
  // A failed prefetch may be retried on the next event page.
  void p.then((ok) => { if (!ok && prefetched.get(hash) === p) prefetched.delete(hash); });
  return p;
}

/** Whether the document is on this device: in memory or in `map-documents` (the offline-ready line). */
export async function isMapDocumentStored(hash: string, storage: DocumentCacheStorage | null = pageCaches()): Promise<boolean> {
  return loaded.has(hash) || (await storedDocument(hash, storage)) !== null;
}

function saveData(): boolean {
  const c = typeof navigator !== "undefined" ? (navigator as Navigator & { connection?: { saveData?: boolean } }).connection : undefined;
  return c?.saveData === true;
}

/** `navigator.storage.persisted()` (07 §9.1 "Pinning"); false where the API is missing. */
export async function storagePersisted(): Promise<boolean> {
  try {
    const storage = typeof navigator !== "undefined" ? navigator.storage : undefined;
    return storage?.persisted ? await storage.persisted() : false;
  } catch {
    return false;
  }
}

function isOffline(): boolean {
  return typeof navigator !== "undefined" && navigator.onLine === false;
}

/** For tests: forget every loaded document and the persist request. */
export function resetMapDocumentCache(): void {
  loaded.clear();
  prefetched.clear();
  persistRequested = undefined;
}

let persistRequested: Promise<boolean> | undefined;

/**
 * Asks once per session for persistent storage, so the cached documents
 * survive storage pressure (07 §9.1 "Pinning"). Resolves false where the
 * API is missing or refuses.
 */
export function requestPersistentStorage(): Promise<boolean> {
  persistRequested ??= (async () => {
    try {
      const storage = typeof navigator !== "undefined" ? navigator.storage : undefined;
      if (!storage?.persist) return false;
      return await storage.persist();
    } catch {
      return false;
    }
  })();
  return persistRequested;
}

export type MapDocumentState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; doc: LoadedMapDocument }
  | { status: "error"; kind: MapDocumentErrorKind };

/** React hook over `loadMapDocument`; `retry` asks again after an error. */
export function useMapDocument(hash: string | null | undefined, eventId: string | null | undefined): {
  state: MapDocumentState;
  retry: () => void;
} {
  const [state, setState] = useState<MapDocumentState>({ status: hash ? "loading" : "idle" });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!hash) {
      setState({ status: "idle" });
      return;
    }
    let cancelled = false;
    setState({ status: "loading" });
    loadMapDocument(hash, { eventId }).then(
      (doc) => { if (!cancelled) setState({ status: "ready", doc }); },
      (err) => { if (!cancelled) setState({ status: "error", kind: err instanceof MapDocumentError ? err.kind : "failed" }); },
    );
    return () => { cancelled = true; };
  }, [hash, eventId, attempt]);
  const retry = useCallback(() => setAttempt((a) => a + 1), []);
  return { state, retry };
}

// ---- the event's patch (docs/map-patches.md §3.3; map-rendering §5.4 "Host") ----

/** What the patch route answers: the version (the ETag) and the patch, null for none. */
export interface MapPatchDelivery {
  version: string;
  patch: mapDocument.MapPatch | null;
}

/** No correction to draw (`map-patches.md` §3.3: version `"0"`, the identity). */
export const NO_PATCH: MapPatchDelivery = Object.freeze({ version: "0", patch: null });

export const mapPatchUrl = (nameId: string): string => `/api/maps/${encodeURIComponent(nameId)}/patch`;

interface PatchEntry {
  delivery: MapPatchDelivery | undefined;
  inflight: Promise<MapPatchDelivery> | undefined;
  listeners: Set<() => void>;
}

const patches = new Map<string, PatchEntry>();

function patchEntry(nameId: string): PatchEntry {
  let e = patches.get(nameId);
  if (!e) patches.set(nameId, (e = { delivery: undefined, inflight: undefined, listeners: new Set() }));
  return e;
}

/** The session's copy of an event's patch, `undefined` before the first answer. */
export function getMapPatch(nameId: string): MapPatchDelivery | undefined {
  return patches.get(nameId)?.delivery;
}

/** Replaces the session's copy and tells every viewer of the event (G6's optimistic write goes through here). */
export function setMapPatch(nameId: string, delivery: MapPatchDelivery): void {
  const e = patchEntry(nameId);
  const prev = e.delivery;
  e.delivery = delivery;
  if (prev?.version !== delivery.version || prev.patch !== delivery.patch) for (const l of [...e.listeners]) l();
}

/** Calls `fn` whenever the session's copy of the event's patch changes. */
export function subscribeMapPatch(nameId: string, fn: () => void): () => void {
  const e = patchEntry(nameId);
  e.listeners.add(fn);
  return () => { e.listeners.delete(fn); };
}

/** The route's body as a delivery; a patch that does not parse is no patch (as the server treats an unreadable row). */
export function parseMapPatchDelivery(body: unknown): MapPatchDelivery | null {
  if (!body || typeof body !== "object") return null;
  const { version, patch } = body as { version?: unknown; patch?: unknown };
  if (typeof version !== "string") return null;
  if (patch === null || patch === undefined) return { version, patch: null };
  const parsed = mapDocument.mapPatchSchema.safeParse(patch);
  if (!parsed.success) {
    console.warn("[map-patch] unreadable patch, drawing the document without it:", parsed.error.message);
    return { version, patch: null };
  }
  return { version, patch: parsed.data };
}

/**
 * Fetches (or revalidates, `If-None-Match` with the session's version) an event's patch. One
 * request per event at a time. Never rejects: a failure keeps the session's copy, else no patch.
 */
export function loadMapPatch(nameId: string, opts: FetchOptions = {}): Promise<MapPatchDelivery> {
  const e = patchEntry(nameId);
  if (e.inflight) return e.inflight;
  const p = (async (): Promise<MapPatchDelivery> => {
    const headers: Record<string, string> = {};
    const kioskKey = opts.kioskKey !== undefined ? opts.kioskKey : kioskKeyFromUrl();
    if (kioskKey) headers["x-kiosk-key"] = kioskKey;
    if (e.delivery) headers["if-none-match"] = `"${e.delivery.version}"`;
    try {
      const res = await (opts.fetchImpl ?? fetch)(mapPatchUrl(nameId), { headers, cache: "no-store" });
      if (res.status === 304 && e.delivery) return e.delivery;
      if (!res.ok) return e.delivery ?? NO_PATCH;
      const delivery = parseMapPatchDelivery(await res.json());
      if (!delivery) return e.delivery ?? NO_PATCH;
      setMapPatch(nameId, delivery);
      return delivery;
    } catch {
      return e.delivery ?? NO_PATCH;
    }
  })();
  e.inflight = p;
  void p.finally(() => { if (e.inflight === p) e.inflight = undefined; });
  return p;
}

/**
 * The session's copy when it is `version` (or no version is wanted), else a fetch. A fetch that
 * joined a request already in flight — started before the change — and still answers another
 * version is made once more, so a `patchVersion` change is never lost to a revalidation.
 */
export async function refreshMapPatch(nameId: string, version?: string | null, opts: FetchOptions = {}): Promise<MapPatchDelivery> {
  const held = getMapPatch(nameId);
  if (held && (version == null || version === held.version)) return held;
  const joined = !!patches.get(nameId)?.inflight;
  const d = await loadMapPatch(nameId, opts);
  return joined && version != null && d.version !== version ? loadMapPatch(nameId, opts) : d;
}

/** For tests: forget every event's patch. */
export function resetMapPatches(): void {
  patches.clear();
}

/**
 * React hook: the event's patch (`NO_PATCH` until the first answer; the layer does not wait for
 * it). Fetched on mount, again whenever `version` (`mapMetadata.patchVersion`) differs from the
 * session's copy, and revalidated when the page regains focus, becomes visible or comes back
 * online — there is no live channel for the patch.
 */
export function useMapPatch(nameId: string | null | undefined, version?: string | null): MapPatchDelivery {
  const subscribe = useCallback((fn: () => void) => (nameId ? subscribeMapPatch(nameId, fn) : () => undefined), [nameId]);
  const delivery = useSyncExternalStore(subscribe, () => (nameId ? getMapPatch(nameId) : undefined)) ?? NO_PATCH;
  useEffect(() => {
    if (nameId) void refreshMapPatch(nameId, version);
  }, [nameId, version]);
  useEffect(() => {
    if (!nameId || typeof window === "undefined") return;
    const revalidate = () => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      void loadMapPatch(nameId);
    };
    window.addEventListener("focus", revalidate);
    window.addEventListener("online", revalidate);
    document.addEventListener("visibilitychange", revalidate);
    return () => {
      window.removeEventListener("focus", revalidate);
      window.removeEventListener("online", revalidate);
      document.removeEventListener("visibilitychange", revalidate);
    };
  }, [nameId]);
  return delivery;
}
