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
  snapshotPatchOf,
  verifyBlob,
  tokenMapOf,
  applyTokens,
  withDbNulls,
  type BlobSliceFetcher,
} from "../sync/snapshotMaps.js";
import { Prisma } from "../generated/prisma/client.js";
import { withoutDroppedFields } from "../sync/dropped-columns.js";

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

describe("snapshotPatchOf (docs/map-patches.md §3.4)", () => {
  const row = { id: "0190a0a0-0000-7000-8000-000000000001", documentHash: H("a"), enabled: false, ops: { "hide:1": { op: "hide", sourceIndex: 1 } }, symbols: {}, version: 2n ** 62n + 3n };

  it("carries the row with its token as an exact decimal string", () => {
    expect(snapshotPatchOf(row, [H("a"), H("b")])).toEqual({ ...row, version: "4611686018427387907" });
  });

  it("carries nothing without a row, or when its document does not travel (a dormant patch)", () => {
    expect(snapshotPatchOf(null, [H("a")])).toBeNull();
    expect(snapshotPatchOf(row, [H("b")])).toBeNull();
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

describe("withoutDroppedFields (a v0.6.0 exporter's rows)", () => {
  it("strips the columns E5 dropped and keeps the rest", () => {
    expect(withoutDroppedFields("mapFile", { fileName: "a.ocd", sourceHash: H("a"), fileData: "x", fileHash: H("a"), renderKey: "k", colorProfile: "auto", colorOverrides: {}, northLinesBelow: true }))
      .toEqual({ fileName: "a.ocd", sourceHash: H("a") });
    expect(withoutDroppedFields("event", { nameId: "e", mapPipeline: "vector", overprintCutsVersion: 3, autoOverprintCuts: true }))
      .toEqual({ nameId: "e", autoOverprintCuts: true });
    expect(withoutDroppedFields("course", { name: "A", geometry: {}, geometrySource: "editor", lengthSource: "derived" }))
      .toEqual({ name: "A", lengthSource: "derived" });
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

describe("tokens beside the rows (map-storage.md §7.2)", () => {
  const big = 2n ** 60n + 7n;
  it("tokenMapOf keeps each row's token as an exact decimal string", () => {
    expect(tokenMapOf([{ id: "a", version: big }, { id: "b", version: 0n }, { id: "c", version: 12 }])).toEqual({ a: big.toString(), b: "0", c: "12" });
  });
  it("tokenMapOf skips a row without a string id, or with an unsafe number", () => {
    expect(tokenMapOf([{ id: 1, version: 1n }, { id: "x", version: 2 ** 60 }, { id: "y" }])).toEqual({});
  });
  it("survives the JSON round trip that rounds the rows' own tokens", () => {
    const rows = [{ id: "a", version: big }];
    const wire = JSON.parse(JSON.stringify({ rows: rows.map((r) => ({ ...r, version: Number(r.version) })), tokens: tokenMapOf(rows) })) as {
      rows: Array<Record<string, unknown>>;
      tokens: Record<string, string>;
    };
    expect(BigInt(wire.rows[0].version as number)).not.toBe(big); // rounded on the wire
    expect(applyTokens(wire.rows, wire.tokens)[0].version).toBe(big);
  });
  it("applyTokens leaves a row the map lacks, every row without a map, and a malformed token", () => {
    const rows = [{ id: "a", version: 5 }, { id: "b", version: 6 }];
    expect(applyTokens(rows, { a: "9" })).toEqual([{ id: "a", version: 9n }, { id: "b", version: 6 }]);
    expect(applyTokens(rows, undefined)).toEqual(rows);
    expect(applyTokens(rows, { a: "-1" })[0].version).toBe(5);
  });
});

describe("withDbNulls", () => {
  it("replaces JSON nulls of the named fields only", () => {
    const out = withDbNulls({ a: null, b: null, c: { x: 1 } }, ["a", "c"]);
    expect(out.a).toBe(Prisma.DbNull);
    expect(out.b).toBeNull();
    expect(out.c).toEqual({ x: 1 });
  });
});

describe("exportBlobInput for graphics", () => {
  const ok = { table: "graphics", id: "42", start: 0, length: 1024 };
  it("accepts a graphic by decimal id", () => {
    expect(exportBlobInput.parse(ok)).toEqual(ok);
  });
  it.each([
    ["a hash instead of an id", { id: undefined, hash: H("a") }],
    ["a zero id", { id: "0" }],
    ["a non-decimal id", { id: "1e3" }],
    ["more than 4 MiB", { length: EXPORT_BLOB_MAX_BYTES + 1 }],
  ])("refuses %s", (_label, patch) => {
    expect(exportBlobInput.safeParse({ ...ok, ...patch }).success).toBe(false);
  });
  it("refuses a map table keyed by id", () => {
    expect(exportBlobInput.safeParse({ ...ok, table: "map_sources" }).success).toBe(false);
  });
});
