/**
 * The graphics part of the venue checkout snapshot (docs/map-storage.md
 * §7.2): which graphic ids the layout rows reference, and the venue-side
 * slice assembly with its size and hash checks.
 */

import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
// snapshotMaps first, as the server loads them: source-routes' import graph
// reaches the lease router, which imports both.
import { EXPORT_BLOB_MAX_BYTES } from "../sync/snapshotMaps.js";
import { fetchGraphic, referencedGraphicIds, verifyGraphic, type GraphicSliceFetcher } from "../sync/snapshotGraphics.js";

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

describe("referencedGraphicIds", () => {
  it("collects image objects of templates and sheets and course objects' props.graphicId, sorted and distinct", () => {
    expect(
      referencedGraphicIds({
        templateObjects: [
          [
            { kind: "image", graphicId: 12 },
            { kind: "text", graphicId: 99 },
          ],
          [{ kind: "image", graphicId: 3 }],
        ],
        sheetObjects: [[{ kind: "image", graphicId: 12 }]],
        courseObjectProps: [{ graphicId: 7 }, { border: "solid" }],
      }),
    ).toEqual(["3", "7", "12"]);
  });

  it("ignores malformed JSON: non-arrays, non-objects, non-positive or non-integer ids", () => {
    expect(
      referencedGraphicIds({
        templateObjects: [null, { kind: "image", graphicId: 1 }, [null, "x", { kind: "image", graphicId: 0 }, { kind: "image", graphicId: 1.5 }, { kind: "image", graphicId: "4" }]],
        sheetObjects: [undefined],
        courseObjectProps: [null, 5, { graphicId: -1 }],
      }),
    ).toEqual([]);
  });
});

describe("verifyGraphic / fetchGraphic", () => {
  const bytes = Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 251));
  const g = { id: "42", sizeBytes: bytes.length, sha256: sha(bytes) };
  const serving =
    (b: Buffer, seen: Array<[string, number, number]>): GraphicSliceFetcher =>
    async (id, start, length) => {
      seen.push([id, start, length]);
      return { base64: b.subarray(start, start + length).toString("base64"), sizeBytes: b.length };
    };

  it("assembles the bytes in one slice under 4 MiB and verifies them", async () => {
    const seen: Array<[string, number, number]> = [];
    expect((await fetchGraphic(g, serving(bytes, seen))).equals(bytes)).toBe(true);
    expect(seen).toEqual([["42", 0, bytes.length]]);
    expect(bytes.length).toBeLessThan(EXPORT_BLOB_MAX_BYTES);
  });

  it("fails on a wrong size or hash", () => {
    expect(() => verifyGraphic(g, bytes.subarray(1))).toThrow(/expected size/);
    const tampered = Buffer.from(bytes);
    tampered[0] ^= 0xff;
    expect(() => verifyGraphic(g, tampered)).toThrow(/arrived with hash/);
  });

  it("fails when the peer reports another size or a slice comes back short", async () => {
    await expect(fetchGraphic(g, serving(bytes.subarray(0, 999), []))).rejects.toThrow(/reports size/);
    const short: GraphicSliceFetcher = async (_id, start, length) => ({
      base64: bytes.subarray(start, start + length - 1).toString("base64"),
      sizeBytes: bytes.length,
    });
    await expect(fetchGraphic(g, short)).rejects.toThrow(/slice/);
  });
});
