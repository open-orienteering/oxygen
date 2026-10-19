import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { importOcadToDocument, importOmapToDocument } from "../import/ocad.js";
import { isClaimable, isTerminal, runImportInWorker, stageProgress, STALE_MS } from "../map-store/jobs.js";
import {
  assembleChunks,
  chunkCount,
  expectedChunkSize,
  MAX_CHUNK_BYTES,
  MAX_UPLOAD_BYTES,
  missingChunks,
  sniffMapKind,
  validateUploadInit,
} from "../map-store/uploads.js";

const fixture = readFileSync(fileURLToPath(new URL("../../../../e2e/test.ocd", import.meta.url)));

describe("import job state rules", () => {
  const now = new Date("2026-10-16T12:00:00Z");
  const ago = (ms: number) => new Date(now.getTime() - ms);

  it("claims queued jobs and running jobs whose heartbeat is stale, nothing else", () => {
    expect(isClaimable({ state: "queued", heartbeatAt: null }, now)).toBe(true);
    expect(isClaimable({ state: "running", heartbeatAt: null }, now)).toBe(true);
    expect(isClaimable({ state: "running", heartbeatAt: ago(STALE_MS + 1) }, now)).toBe(true);
    expect(isClaimable({ state: "running", heartbeatAt: ago(STALE_MS - 1000) }, now)).toBe(false);
    expect(isClaimable({ state: "done", heartbeatAt: ago(STALE_MS * 10) }, now)).toBe(false);
    expect(isClaimable({ state: "failed", heartbeatAt: null }, now)).toBe(false);
  });

  it("orders stage progress monotonically and ends at 1", () => {
    const p = (["parse", "normalise", "match", "encode", "store", "derive", "done"] as const).map(stageProgress);
    expect(new Set(p).size).toBe(p.length);
    expect(p).toEqual([...p].sort((a, b) => a - b));
    expect(p[0]).toBeGreaterThan(0);
    expect(p.at(-1)).toBe(1);
    expect(isTerminal("done")).toBe(true);
    expect(isTerminal("failed")).toBe(true);
    expect(isTerminal("running")).toBe(false);
  });
});

describe("import worker", () => {
  it("imports the fixture off the main thread with the same hashes as the inline path, reporting stages in order", async () => {
    const stages: string[] = [];
    const [worker, inline] = await Promise.all([
      runImportInWorker(fixture, "test.ocd", { onStage: (s) => stages.push(s), timeoutMs: 60_000 }),
      importOcadToDocument(fixture, "test.ocd"),
    ]);
    expect(worker.documentHash).toBe(inline.documentHash);
    expect(worker.fileHash).toBe(inline.fileHash);
    expect(Buffer.from(worker.bytes).equals(Buffer.from(inline.bytes))).toBe(true);
    expect(worker.report.source.fileName).toBe("test.ocd");
    expect(worker.report.counts.objects).toBe(inline.counts.objects);
    expect(worker.libraryVersion).toBe(inline.libraryVersion);
    expect(stages).toEqual(["parse", "normalise", "match", "encode"]);
  }, 60_000);

  it("imports a Mapper file when told the kind, with the same hashes as the inline path", async () => {
    const xmap = readFileSync(fileURLToPath(new URL("../../../../e2e/test.xmap", import.meta.url)));
    const stages: string[] = [];
    const [worker, inline] = await Promise.all([
      runImportInWorker(xmap, "test.xmap", { kind: "omap", onStage: (s) => stages.push(s), timeoutMs: 60_000 }),
      importOmapToDocument(xmap, "test.xmap"),
    ]);
    expect(worker.documentHash).toBe(inline.documentHash);
    expect(worker.report.source.kind).toBe("omap");
    expect(worker.report.importer).toBe("omap-1");
    expect(stages).toEqual(["parse", "normalise", "match", "encode"]);
  }, 60_000);

  it("rejects with the reader's error for bytes that are not OCAD / not Mapper XML", async () => {
    await expect(runImportInWorker(Buffer.from("definitely not a map"), "junk.ocd", { timeoutMs: 60_000 })).rejects.toThrow();
    await expect(runImportInWorker(Buffer.from("<svg/>"), "junk.xmap", { kind: "omap", timeoutMs: 60_000 })).rejects.toThrow(/expected <map>/);
  }, 60_000);
});

describe("chunked upload rules", () => {
  it("validates the init body", () => {
    expect(validateUploadInit({ fileName: "a.ocd", bytes: 100, chunkBytes: 40 })).toEqual({ ok: true, chunkCount: 3 });
    expect(validateUploadInit(null)).toMatchObject({ ok: false, status: 400 });
    expect(validateUploadInit({ fileName: " ", bytes: 1, chunkBytes: 1 })).toMatchObject({ ok: false, status: 400 });
    expect(validateUploadInit({ fileName: "a", bytes: 0, chunkBytes: 1 })).toMatchObject({ ok: false, status: 400 });
    expect(validateUploadInit({ fileName: "a", bytes: 1.5, chunkBytes: 1 })).toMatchObject({ ok: false, status: 400 });
    expect(validateUploadInit({ fileName: "a", bytes: MAX_UPLOAD_BYTES + 1, chunkBytes: 1 })).toMatchObject({ ok: false, status: 413 });
    expect(validateUploadInit({ fileName: "a", bytes: 10, chunkBytes: MAX_CHUNK_BYTES + 1 })).toMatchObject({ ok: false, status: 400 });
    expect(validateUploadInit({ fileName: "a", bytes: 10, chunkBytes: 0 })).toMatchObject({ ok: false, status: 400 });
    expect(validateUploadInit({ fileName: "a", bytes: MAX_UPLOAD_BYTES, chunkBytes: MAX_CHUNK_BYTES })).toEqual({ ok: true, chunkCount: 16 });
  });

  it("sizes every chunk as chunkBytes except the last, and rejects out-of-range indices", () => {
    expect(chunkCount(100, 40)).toBe(3);
    expect(chunkCount(80, 40)).toBe(2);
    expect(expectedChunkSize(0, 100, 40)).toBe(40);
    expect(expectedChunkSize(1, 100, 40)).toBe(40);
    expect(expectedChunkSize(2, 100, 40)).toBe(20);
    expect(expectedChunkSize(3, 100, 40)).toBeNull();
    expect(expectedChunkSize(-1, 100, 40)).toBeNull();
    expect(expectedChunkSize(1.5, 100, 40)).toBeNull();
    expect(expectedChunkSize(1, 80, 40)).toBe(40);
    expect(expectedChunkSize(0, 5, 40)).toBe(5);
  });

  it("sniffs OCAD by magic and Mapper by its XML root, nothing else", () => {
    expect(sniffMapKind(fixture.subarray(0, 64))).toBe("ocad");
    expect(sniffMapKind(Buffer.from('<?xml version="1.0"?>\n<map xmlns="http://openorienteering.org/apps/mapper/xml/v2" version="9">'))).toBe("omap");
    expect(sniffMapKind(Buffer.from('<?xml version="1.0"?><svg/>'))).toBeNull();
    expect(sniffMapKind(Buffer.from("%PDF-1.7"))).toBeNull();
    expect(sniffMapKind(new Uint8Array(0))).toBeNull();
    expect(sniffMapKind(new Uint8Array([0xad]))).toBeNull();
  });

  it("lists missing chunk indices and assembles the rest in order with the file hash", () => {
    expect(missingChunks(4, [0, 2])).toEqual([1, 3]);
    expect(missingChunks(2, [1, 0])).toEqual([]);
    const parts = [fixture.subarray(0, 10_000), fixture.subarray(10_000, 20_000), fixture.subarray(20_000)];
    const { bytes, fileHash } = assembleChunks(parts);
    expect(bytes.equals(fixture)).toBe(true);
    expect(fileHash).toBe(createHash("sha256").update(fixture).digest("hex"));
  });
});
