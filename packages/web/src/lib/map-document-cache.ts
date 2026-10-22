/**
 * Map documents for the viewer (docs/map-storage.md §7.1): one
 * `GET /api/map-documents/:hash` per hash, the bytes kept in memory for
 * the session. Cache Storage (the service worker's CacheFirst
 * `map-documents` route, `vite.config.ts`) is the persistent copy; there
 * is no IndexedDB copy (07 §9.1).
 *
 * The request carries the event and kiosk key as headers, never in the
 * query, so the URL — and with it the service worker's cache key — is
 * the hash alone: a club map pinned by several events is cached once.
 */

import { useCallback, useEffect, useState } from "react";
import { mapDocument } from "@oxygen/shared";
import { kioskKeyFromUrl } from "./kiosk-key";

/** The document route without previews (`/thumbnail.png`, `/symbols/…`); `vite.config.ts` repeats it. */
export const MAP_DOCUMENT_PATH_RE = /^\/api\/map-documents\/[0-9a-f]{64}$/;

export const mapDocumentUrl = (hash: string): string => `/api/map-documents/${hash}`;

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
  fetchImpl?: typeof fetch;
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

async function fetchDocument(hash: string, opts: FetchOptions): Promise<LoadedMapDocument> {
  const headers: Record<string, string> = {};
  if (opts.eventId) headers["x-event-id"] = opts.eventId;
  const kioskKey = opts.kioskKey !== undefined ? opts.kioskKey : kioskKeyFromUrl();
  if (kioskKey) headers["x-kiosk-key"] = kioskKey;
  const f = opts.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await f(mapDocumentUrl(hash), { headers });
  } catch (err) {
    throw new MapDocumentError(isOffline() ? "offline" : "failed", err instanceof Error ? err.message : String(err));
  }
  if (res.status === 401 || res.status === 403) throw new MapDocumentError("unauthorised", `map document ${res.status}`);
  if (res.status === 404) throw new MapDocumentError("missing", "map document not found");
  if (!res.ok) throw new MapDocumentError(isOffline() ? "offline" : "failed", `map document ${res.status}`);
  const bytes = await res.arrayBuffer();
  let header: mapDocument.MapDocumentHeader;
  try {
    header = mapDocument.readMapDocumentHeader(new Uint8Array(bytes)).header;
  } catch (err) {
    throw new MapDocumentError("failed", `unreadable map document: ${err instanceof Error ? err.message : String(err)}`);
  }
  void requestPersistentStorage();
  return { hash, bytes, header };
}

function isOffline(): boolean {
  return typeof navigator !== "undefined" && navigator.onLine === false;
}

/** For tests: forget every loaded document and the persist request. */
export function resetMapDocumentCache(): void {
  loaded.clear();
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
