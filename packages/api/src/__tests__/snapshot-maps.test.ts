/**
 * The map part of the venue checkout snapshot (docs/map-storage.md §7.2):
 * which hashes travel, the `lease.exportBlob` input bounds, and the
 * venue-side slice assembly with its hash and size checks.
 */

import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import {
  EXPORT_BLOB_MAX_BYTES,
  exportBlobInput,
  fetchBlob,
  partitionMapFiles,
  pinnedHashes,
  verifyBlob,
  type BlobSliceFetcher,
} from "../sync/snapshotMaps.js";

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const H = (c: string) => c.repeat(64);

describe("pinnedHashes", () => {
  it("dedups sources and documents and adds each document's own source", () => {
    const got = pinnedHashes(
      [
        { sourceHash: H("a"), documentHash: H("d") },
        { sourceHash: H("a"), documentHash: H("d") },
        { sourceHash: H("b"), documentHash: null },
      ],
      [{ hash: H("d"), sourceHash: H("c") }],
    );
    expect(got.sources).toEqual([H("a"), H("b"), H("c")]);
    expect(got.documents).toEqual([H("d")]);
  });

  it("is empty for an event without pins", () => {
    expect(pinnedHashes([], [])).toEqual({ sources: [], documents: [] });
  });
});

describe("partitionMapFiles", () => {
  it("carries pinned rows without id / eventId and counts the pre-pipeline ones", () => {
    const { files, skipped } = partitionMapFiles([
      { id: 1n, eventId: 9n, fileName: "a.ocd", sourceHash: H("a"), documentHash: H("d"), clubMapVersionId: "v" },
      { id: 2n, eventId: 9n, fileName: "old.ocd", sourceHash: null, documentHash: null, clubMapVersionId: null },
    ]);
    expect(skipped).toBe(1);
    expect(files).toEqual([{ fileName: "a.ocd", sourceHash: H("a"), documentHash: H("d"), clubMapVersionId: "v" }]);
  });
});

describe("exportBlobInput", () => {
  const ok = { table: "map_documents", hash: H("a"), start: 0, length: 1024 };
  it("accepts a slice of at most 4 MiB", () => {
    expect(exportBlobInput.parse(ok)).toEqual(ok);
    expect(exportBlobInput.parse({ ...ok, length: EXPORT_BLOB_MAX_BYTES }).length).toBe(4 * 1024 * 1024);
  });
  it.each([
    ["an unknown table", { table: "map_previews" }],
    ["a non-hex hash", { hash: "Z".repeat(64) }],
    ["a short hash", { hash: "ab" }],
    ["a negative start", { start: -1 }],
    ["a zero length", { length: 0 }],
    ["more than 4 MiB", { length: EXPORT_BLOB_MAX_BYTES + 1 }],
  ])("rejects %s", (_name, patch) => {
    expect(exportBlobInput.safeParse({ ...ok, ...patch }).success).toBe(false);
  });
});

describe("verifyBlob", () => {
  const bytes = Buffer.from("orienteering");
  it("passes matching bytes", () => {
    expect(() => verifyBlob("map_sources", sha(bytes), bytes.length, bytes)).not.toThrow();
  });
  it("rejects a size mismatch", () => {
    expect(() => verifyBlob("map_sources", sha(bytes), bytes.length + 1, bytes)).toThrow(/size/);
  });
  it("rejects a hash mismatch", () => {
    expect(() => verifyBlob("map_documents", H("0"), bytes.length, bytes)).toThrow(/hash/);
  });
});

describe("fetchBlob", () => {
  const bytes = Buffer.alloc(EXPORT_BLOB_MAX_BYTES * 2 + 17, 7);
  bytes.write("start");
  bytes.write("end", bytes.length - 3);
  const hash = sha(bytes);

  const servingFrom = (b: Buffer, calls: Array<[number, number]>): BlobSliceFetcher => async (_t, _h, start, length) => {
    calls.push([start, length]);
    return { base64: b.subarray(start, start + length).toString("base64"), sizeBytes: b.length };
  };

  it("assembles 4 MiB slices in order and verifies the whole", async () => {
    const calls: Array<[number, number]> = [];
    const got = await fetchBlob("map_sources", hash, bytes.length, servingFrom(bytes, calls));
    expect(got.equals(bytes)).toBe(true);
    expect(calls).toEqual([
      [0, EXPORT_BLOB_MAX_BYTES],
      [EXPORT_BLOB_MAX_BYTES, EXPORT_BLOB_MAX_BYTES],
      [EXPORT_BLOB_MAX_BYTES * 2, 17],
    ]);
  });

  it("fails when the peer's bytes do not hash to the address", async () => {
    const other = Buffer.from(bytes);
    other[100] = 0;
    await expect(fetchBlob("map_sources", hash, bytes.length, servingFrom(other, []))).rejects.toThrow(/hash/);
  });

  it("fails when the peer reports another size", async () => {
    const short = bytes.subarray(0, bytes.length - 1);
    await expect(fetchBlob("map_sources", hash, bytes.length, servingFrom(short, []))).rejects.toThrow(/size/);
  });

  it("fails when a slice comes back short", async () => {
    const fetcher: BlobSliceFetcher = async (_t, _h, start, length) => ({
      base64: bytes.subarray(start, start + length - 1).toString("base64"),
      sizeBytes: bytes.length,
    });
    await expect(fetchBlob("map_sources", hash, bytes.length, fetcher)).rejects.toThrow(/slice/);
  });
});
