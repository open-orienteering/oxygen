import { describe, it, expect, vi } from "vitest";
import {
  CHUNKED_UPLOAD_THRESHOLD,
  MapUploadError,
  shouldUseChunkedUpload,
  uploadMapFileChunked,
} from "../lib/map-upload";

/** In-memory stand-in for the three upload routes. */
function fakeServer(opts: { failChunkOnce?: number; rejectChunk?: number } = {}) {
  const chunks = new Map<number, Uint8Array>();
  const calls: string[] = [];
  let failed = false;
  let init: { fileName: string; bytes: number; chunkBytes: number } | null = null;
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fetchImpl: typeof fetch = async (input, reqInit) => {
    const url = String(input);
    const method = reqInit?.method ?? "GET";
    calls.push(`${method} ${url}`);
    if (url.endsWith("/api/map-uploads") && method === "POST") {
      init = JSON.parse(String(reqInit?.body)) as typeof init;
      return json(201, { uploadId: "u1", chunkCount: Math.ceil(init!.bytes / init!.chunkBytes), chunkBytes: init!.chunkBytes });
    }
    const m = /\/api\/map-uploads\/u1\/chunks\/(\d+)$/.exec(url);
    if (m && method === "PUT") {
      const n = Number(m[1]);
      if (opts.rejectChunk === n) return json(415, { error: "Not an OCAD or Mapper file" });
      if (opts.failChunkOnce === n && !failed) {
        failed = true;
        return json(503, { error: "try again" });
      }
      const body = reqInit?.body as Blob;
      chunks.set(n, new Uint8Array(await body.arrayBuffer()));
      return new Response(null, { status: 204 });
    }
    if (url.endsWith("/api/map-uploads/u1/finalise") && method === "POST") {
      const expected = Math.ceil(init!.bytes / init!.chunkBytes);
      if (chunks.size !== expected) return json(409, { error: "Upload incomplete" });
      return json(200, { fileHash: "ab".repeat(32), bytes: init!.bytes, deduplicated: false });
    }
    return json(404, { error: "no route" });
  };
  return { fetchImpl, chunks, calls, get init() { return init; } };
}

const bytesOf = (n: number) => Uint8Array.from({ length: n }, (_, i) => i % 251);
const file = (n: number, name = "big.ocd") => Object.assign(new Blob([bytesOf(n)]), { name });

describe("shouldUseChunkedUpload", () => {
  it("switches above the 8 MiB threshold only", () => {
    expect(shouldUseChunkedUpload(CHUNKED_UPLOAD_THRESHOLD)).toBe(false);
    expect(shouldUseChunkedUpload(CHUNKED_UPLOAD_THRESHOLD + 1)).toBe(true);
    expect(shouldUseChunkedUpload(26_000)).toBe(false);
  });
});

describe("uploadMapFileChunked", () => {
  it("inits, puts every chunk with the right slice, finalises, and reports progress", async () => {
    const srv = fakeServer();
    const progress: number[] = [];
    const result = await uploadMapFileChunked(file(10_000), {
      eventNameId: "itest",
      chunkBytes: 4096,
      fetch: srv.fetchImpl,
      onProgress: (sent) => progress.push(sent),
    });
    expect(result).toEqual({ fileHash: "ab".repeat(32), bytes: 10_000, deduplicated: false });
    expect(srv.init).toEqual({ fileName: "big.ocd", bytes: 10_000, chunkBytes: 4096 });
    expect([...srv.chunks.keys()].sort()).toEqual([0, 1, 2]);
    expect(srv.chunks.get(2)!.byteLength).toBe(10_000 - 2 * 4096);
    const reassembled = Buffer.concat([0, 1, 2].map((n) => Buffer.from(srv.chunks.get(n)!)));
    expect(reassembled.equals(Buffer.from(bytesOf(10_000)))).toBe(true);
    expect(progress[0]).toBe(0);
    expect(progress.at(-1)).toBe(10_000);
    expect(srv.calls[0]).toBe("POST /api/map-uploads");
    expect(srv.calls.at(-1)).toBe("POST /api/map-uploads/u1/finalise");
  });

  it("retries a chunk the server failed transiently and still finalises", async () => {
    const srv = fakeServer({ failChunkOnce: 1 });
    await uploadMapFileChunked(file(10_000), { chunkBytes: 4096, fetch: srv.fetchImpl, concurrency: 1 });
    expect(srv.calls.filter((c) => c.endsWith("/chunks/1"))).toHaveLength(2);
    expect(srv.chunks.size).toBe(3);
  });

  it("does not retry a 4xx rejection and surfaces the server's message", async () => {
    const srv = fakeServer({ rejectChunk: 0 });
    const err = await uploadMapFileChunked(file(10_000), { chunkBytes: 4096, fetch: srv.fetchImpl }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MapUploadError);
    expect((err as MapUploadError).status).toBe(415);
    expect((err as MapUploadError).message).toBe("Not an OCAD or Mapper file");
    expect(srv.calls.filter((c) => c.endsWith("/chunks/0"))).toHaveLength(1);
    expect(srv.calls.some((c) => c.endsWith("/finalise"))).toBe(false);
  });

  it("sends x-event-id only for event uploads", async () => {
    const srv = fakeServer();
    const seen: Array<Record<string, string> | undefined> = [];
    const spy = vi.fn<typeof fetch>(async (input, init) => {
      seen.push(init?.headers as Record<string, string> | undefined);
      return srv.fetchImpl(input, init);
    });
    await uploadMapFileChunked(file(100), { chunkBytes: 100, fetch: spy });
    expect(seen).toHaveLength(3);
    expect(seen.every((h) => !h || !("x-event-id" in h))).toBe(true);
    await uploadMapFileChunked(file(100), { chunkBytes: 100, fetch: spy, eventNameId: "itest" });
    expect(seen.slice(3).every((h) => h?.["x-event-id"] === "itest")).toBe(true);
  });
});
