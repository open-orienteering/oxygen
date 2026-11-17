/**
 * The pinned document's height field for the viewer's 3D mode
 * (docs/map-rendering.md §5.4 "3D mode" "Field"; docs/map-storage.md §4.7):
 * fetched from the descriptor's `url` as given (`/api/map-documents/:hash/
 * height.bin?v=…`) through `venueAwareFetch` with the document's headers,
 * decoded with the field's client entry, and kept like the document — one
 * request per URL shared by concurrent callers, the decoded fields in
 * memory (three: a document's `contours`, anchored and ground fields, so
 * switching the surface asks nothing again, H11), a copy in Cache Storage
 * `map-heightfields` (app-written; the service worker has no route for it)
 * that serves it offline. Failures are not kept.
 */

import { useCallback, useEffect, useState } from "react";
import { decodeHeightField, type HeightField } from "@oxygen/shared/src/terrain/field/read.js";
import { kioskKeyFromUrl } from "../lib/kiosk-key";
import { venueAwareFetch } from "../lib/node-discovery";

export const HEIGHTFIELDS_CACHE = "map-heightfields";
/** Decoded fields kept in memory (a club map's is up to ~100 MB of int16 at the 60 M cap; most are a few MB). */
export const FIELD_MEMORY_ENTRIES = 3;

export type HeightFieldErrorKind = "unauthorised" | "missing" | "pending" | "offline" | "failed";

export class HeightFieldError extends Error {
  readonly kind: HeightFieldErrorKind;
  /** A 404's `reason` (`no-contours`, `over-cap`, `version`, …). */
  readonly reason?: string;
  constructor(kind: HeightFieldErrorKind, message: string, reason?: string) {
    super(message);
    this.name = "HeightFieldError";
    this.kind = kind;
    this.reason = reason;
  }
}

/** The Cache Storage subset used (tests pass a memory one). */
export interface FieldCacheStorage {
  open(name: string): Promise<{
    match(key: string, opts?: CacheQueryOptions): Promise<Response | undefined>;
    put(key: string, res: Response): Promise<void>;
    delete?(key: string): Promise<boolean>;
    keys?(): Promise<readonly { url: string }[]>;
  }>;
}

export interface HeightFieldFetchOptions {
  /** `x-event-id`. */
  eventId?: string | null;
  /** `x-kiosk-key`; default the page URL's `?k=`. */
  kioskKey?: string | null;
  fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>;
  /** Default the page's `caches` (null: none). */
  cacheStorage?: FieldCacheStorage | null;
}

const pageCaches = (): FieldCacheStorage | null => (typeof caches !== "undefined" ? (caches as unknown as FieldCacheStorage) : null);
const isOffline = () => typeof navigator !== "undefined" && navigator.onLine === false;

const loaded = new Map<string, Promise<HeightField>>();

/** Loads the field at `url` once; concurrent callers share the request and the decoded field. */
export function loadHeightField(url: string, opts: HeightFieldFetchOptions = {}): Promise<HeightField> {
  const hit = loaded.get(url);
  if (hit) {
    loaded.delete(url);
    loaded.set(url, hit);
    return hit;
  }
  const p = fetchField(url, opts);
  loaded.set(url, p);
  p.catch(() => {
    if (loaded.get(url) === p) loaded.delete(url);
  });
  while (loaded.size > FIELD_MEMORY_ENTRIES) loaded.delete(loaded.keys().next().value as string);
  return p;
}

/** For tests. */
export function resetHeightFields(): void {
  loaded.clear();
}

async function stored(url: string, storage: FieldCacheStorage | null): Promise<Response | null> {
  if (!storage) return null;
  try {
    return (await (await storage.open(HEIGHTFIELDS_CACHE)).match(url, { ignoreVary: true })) ?? null;
  } catch {
    return null;
  }
}

/** Keeps the bytes under `url`, dropping the same document's other versions of the same source. */
async function keep(url: string, bytes: ArrayBuffer, storage: FieldCacheStorage | null): Promise<void> {
  if (!storage) return;
  try {
    const cache = await storage.open(HEIGHTFIELDS_CACHE);
    const self = new URL(url, "http://x");
    for (const k of (await cache.keys?.()) ?? []) {
      const other = new URL(k.url, "http://x");
      if (other.pathname === self.pathname && other.search !== self.search && other.searchParams.get("source") === self.searchParams.get("source")) await cache.delete?.(k.url);
    }
    await cache.put(url, new Response(bytes.slice(0), { status: 200, headers: { "content-type": "application/octet-stream" } }));
  } catch (err) {
    console.warn("[height-field] not kept in Cache Storage:", err);
  }
}

async function fetchField(url: string, opts: HeightFieldFetchOptions): Promise<HeightField> {
  const headers: Record<string, string> = {};
  if (opts.eventId) headers["x-event-id"] = opts.eventId;
  const kioskKey = opts.kioskKey !== undefined ? opts.kioskKey : kioskKeyFromUrl();
  if (kioskKey) headers["x-kiosk-key"] = kioskKey;
  const f = opts.fetchImpl ?? venueAwareFetch;
  const storage = opts.cacheStorage !== undefined ? opts.cacheStorage : pageCaches();
  let res: Response;
  let fromNetwork = true;
  try {
    res = await f(url, { headers });
  } catch (err) {
    const copy = await stored(url, storage);
    if (!copy) throw new HeightFieldError(isOffline() ? "offline" : "failed", err instanceof Error ? err.message : String(err));
    res = copy;
    fromNetwork = false;
  }
  if (res.status === 401 || res.status === 403) throw new HeightFieldError("unauthorised", `height field ${res.status}`);
  if (res.status === 404) {
    const body = (await res.json().catch(() => null)) as { reason?: unknown } | null;
    throw new HeightFieldError("missing", "height field not found", typeof body?.reason === "string" ? body.reason : undefined);
  }
  if (!res.ok) {
    const copy = await stored(url, storage);
    if (!copy) throw new HeightFieldError(res.status === 503 ? "pending" : isOffline() ? "offline" : "failed", `height field ${res.status}`);
    res = copy;
    fromNetwork = false;
  }
  const bytes = await res.arrayBuffer();
  let field: HeightField;
  try {
    field = decodeHeightField(new Uint8Array(bytes));
  } catch (err) {
    throw new HeightFieldError("failed", `unreadable height field: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (fromNetwork) await keep(url, bytes, storage);
  return field;
}

export type HeightFieldState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; url: string; field: HeightField }
  | { status: "error"; kind: HeightFieldErrorKind; reason?: string };

/** React hook over `loadHeightField`: asks only while `url` is non-null; `retry` asks again after an error. */
export function useHeightField(url: string | null | undefined, eventId: string | null | undefined): { state: HeightFieldState; retry: () => void } {
  const [state, setState] = useState<HeightFieldState>({ status: url ? "loading" : "idle" });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!url) {
      setState({ status: "idle" });
      return;
    }
    let cancelled = false;
    setState({ status: "loading" });
    loadHeightField(url, { eventId }).then(
      (field) => { if (!cancelled) setState({ status: "ready", url, field }); },
      (err: unknown) => {
        if (!cancelled) setState(err instanceof HeightFieldError ? { status: "error", kind: err.kind, reason: err.reason } : { status: "error", kind: "failed" });
      },
    );
    return () => { cancelled = true; };
  }, [url, eventId, attempt]);
  const retry = useCallback(() => setAttempt((a) => a + 1), []);
  return { state, retry };
}
