/**
 * Chunked map upload client (docs/map-storage.md §5).
 *
 * Files above `CHUNKED_UPLOAD_THRESHOLD` go through
 * `POST /api/map-uploads` → `PUT …/chunks/:n` (four in flight, retried
 * per chunk) → `POST …/finalise`, which yields the content hash the
 * tRPC `applyUploadedMap` / `addFromSource` mutations then consume.
 * Smaller files keep the one-shot base64 mutation — one request, and
 * every E2E fixture stays on the path it always used.
 */

export const CHUNKED_UPLOAD_THRESHOLD = 8 * 1024 * 1024;
export const CHUNK_BYTES = 8 * 1024 * 1024;
export const CHUNK_CONCURRENCY = 4;
export const CHUNK_RETRIES = 3;

const API_BASE = import.meta.env.VITE_API_URL ?? "";

export function shouldUseChunkedUpload(bytes: number, threshold = CHUNKED_UPLOAD_THRESHOLD): boolean {
  return bytes > threshold;
}

export interface ChunkedUploadOptions {
  /** Event nameId for an event map; omit for the club library. */
  eventNameId?: string | null;
  chunkBytes?: number;
  concurrency?: number;
  retries?: number;
  fetch?: typeof fetch;
  /** Bytes confirmed stored so far. */
  onProgress?: (sent: number, total: number) => void;
  signal?: AbortSignal;
}

export interface ChunkedUploadResult {
  fileHash: string;
  bytes: number;
  deduplicated: boolean;
}

export class MapUploadError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "MapUploadError";
    this.status = status;
  }
}

async function errorFrom(res: Response, fallback: string): Promise<MapUploadError> {
  let message = fallback;
  try {
    const body = (await res.json()) as { error?: string };
    if (body?.error) message = body.error;
  } catch {
    // Non-JSON error body: keep the fallback.
  }
  return new MapUploadError(res.status, message);
}

/** Split indices into `CHUNK_CONCURRENCY` lanes that each pull the next unsent chunk. */
async function runLanes(count: number, lanes: number, work: (n: number) => Promise<void>): Promise<void> {
  let next = 0;
  const lane = async () => {
    for (;;) {
      const n = next++;
      if (n >= count) return;
      await work(n);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(lanes, count)) }, lane));
}

export async function uploadMapFileChunked(file: Blob & { name?: string }, opts: ChunkedUploadOptions = {}): Promise<ChunkedUploadResult> {
  const doFetch = opts.fetch ?? fetch;
  const chunkBytes = opts.chunkBytes ?? CHUNK_BYTES;
  const retries = opts.retries ?? CHUNK_RETRIES;
  const headers: Record<string, string> = {};
  if (opts.eventNameId) headers["x-event-id"] = opts.eventNameId;
  const fileName = file.name ?? "map.ocd";

  const initRes = await doFetch(`${API_BASE}/api/map-uploads`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ fileName, bytes: file.size, chunkBytes }),
    signal: opts.signal,
  });
  if (!initRes.ok) throw await errorFrom(initRes, `Upload could not start (${initRes.status})`);
  const { uploadId, chunkCount } = (await initRes.json()) as { uploadId: string; chunkCount: number };

  let sent = 0;
  opts.onProgress?.(0, file.size);
  const putChunk = async (n: number) => {
    const blob = file.slice(n * chunkBytes, Math.min(file.size, (n + 1) * chunkBytes));
    let lastError: unknown = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const res = await doFetch(`${API_BASE}/api/map-uploads/${uploadId}/chunks/${n}`, {
          method: "PUT",
          headers: { ...headers, "content-type": "application/octet-stream" },
          body: blob,
          signal: opts.signal,
        });
        if (res.ok) {
          sent += blob.size;
          opts.onProgress?.(sent, file.size);
          return;
        }
        const err = await errorFrom(res, `Chunk ${n} rejected (${res.status})`);
        // Client-side rejections (bad size, wrong kind, no access) will not get better on retry.
        if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) throw err;
        lastError = err;
      } catch (err) {
        if (err instanceof MapUploadError) throw err;
        if (opts.signal?.aborted) throw err;
        lastError = err;
      }
    }
    throw lastError instanceof Error ? lastError : new Error(`Chunk ${n} failed after ${retries + 1} attempts`);
  };
  await runLanes(chunkCount, opts.concurrency ?? CHUNK_CONCURRENCY, putChunk);

  const finRes = await doFetch(`${API_BASE}/api/map-uploads/${uploadId}/finalise`, { method: "POST", headers, signal: opts.signal });
  if (!finRes.ok) throw await errorFrom(finRes, `Upload could not be finalised (${finRes.status})`);
  return (await finRes.json()) as ChunkedUploadResult;
}
