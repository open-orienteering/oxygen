/**
 * Map uploads for integration tests, through the real chunked upload
 * routes (docs/map-storage.md §5) — the only upload path since E5 removed
 * the base64 procedures (`course.uploadMap`, `clubMap.upload`).
 *
 * `uploadMapSource` runs init → chunks → finalise on an in-process
 * Fastify app and returns the content hash; `uploadEventMap` and
 * `uploadClubMap` then hand it to `course.applyUploadedMap` /
 * `clubMap.addFromSource` the way the web client does.
 */

import Fastify, { type FastifyInstance } from "fastify";
import { registerMapUploadRoutes } from "../../map-store/upload-routes.js";
import type { makeCaller } from "./caller.js";

type Caller = ReturnType<typeof makeCaller>;

/** Small enough that every fixture spans several chunks. */
const CHUNK_BYTES = 64 * 1024;

let server: FastifyInstance | null = null;

async function uploadServer(): Promise<FastifyInstance> {
  if (!server) {
    const app = Fastify({ logger: false, bodyLimit: CHUNK_BYTES * 2 });
    registerMapUploadRoutes(app);
    await app.ready();
    server = app;
  }
  return server;
}

export interface UploadOptions {
  /** Event nameId for an event-scoped upload; omit for the club library. */
  eventNameId?: string | null;
  /** Extra request headers (an identity header when the suite runs with auth on). */
  headers?: Record<string, string>;
}

/** Upload `bytes` through the chunk routes; returns the `map_sources` hash. */
export async function uploadMapSource(
  bytes: Uint8Array,
  fileName: string,
  opts: UploadOptions = {},
): Promise<{ fileHash: string; deduplicated: boolean }> {
  const app = await uploadServer();
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.eventNameId) headers["x-event-id"] = opts.eventNameId;
  const init = await app.inject({
    method: "POST",
    url: "/api/map-uploads",
    headers,
    payload: { fileName, bytes: bytes.byteLength, chunkBytes: CHUNK_BYTES },
  });
  if (init.statusCode !== 201) throw new Error(`upload init ${init.statusCode}: ${init.body}`);
  const { uploadId, chunkCount } = init.json() as { uploadId: string; chunkCount: number };
  for (let n = 0; n < chunkCount; n++) {
    const chunk = await app.inject({
      method: "PUT",
      url: `/api/map-uploads/${uploadId}/chunks/${n}`,
      headers: { ...headers, "content-type": "application/octet-stream" },
      payload: Buffer.from(bytes.subarray(n * CHUNK_BYTES, (n + 1) * CHUNK_BYTES)),
    });
    if (chunk.statusCode !== 204) throw new Error(`upload chunk ${n} ${chunk.statusCode}: ${chunk.body}`);
  }
  const fin = await app.inject({ method: "POST", url: `/api/map-uploads/${uploadId}/finalise`, headers });
  if (fin.statusCode !== 200) throw new Error(`upload finalise ${fin.statusCode}: ${fin.body}`);
  return fin.json() as { fileHash: string; deduplicated: boolean };
}

/** Upload `bytes` and make them the event's map (`course.applyUploadedMap`). */
export async function uploadEventMap(
  caller: Caller,
  eventNameId: string,
  bytes: Uint8Array,
  fileName = "test.ocd",
  opts: Omit<UploadOptions, "eventNameId"> = {},
) {
  const { fileHash } = await uploadMapSource(bytes, fileName, { ...opts, eventNameId });
  return caller.course.applyUploadedMap({ fileHash, fileName });
}

/** Upload `bytes` and add them to the club library (`clubMap.addFromSource`). */
export async function uploadClubMap(
  caller: Caller,
  bytes: Uint8Array,
  fileName = "club.ocd",
  name?: string,
  opts: Omit<UploadOptions, "eventNameId"> = {},
) {
  const { fileHash } = await uploadMapSource(bytes, fileName, opts);
  return caller.clubMap.addFromSource({ fileHash, fileName, ...(name ? { name } : {}) });
}

/** Close the shared upload app (call from `afterAll` if the suite used it). */
export async function closeUploadServer(): Promise<void> {
  const app = server;
  server = null;
  await app?.close();
}
