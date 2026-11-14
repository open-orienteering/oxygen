/**
 * The prepared print document (docs/course-print.md §8.2): decoded and
 * bridged once per hash, the last two kept, a failed decode not kept; the
 * objects near a window by extent plus margin. Moved from the API's
 * `render/window-raster.ts` with the print pipeline (G13).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { OBJECT_TYPE, mapPatchSchema, type MapPatchInput } from "../../map-document/index.js";
import { type PrintPatch, livePrintPatch, objectsNear, prepareDocument, preparedDocumentKey, resetPreparedDocuments } from "../prepared-document.js";
import { printDocumentBytes } from "./print-document.js";

beforeEach(() => resetPreparedDocuments());

describe("prepareDocument", () => {
  it("decodes the document: colours, render input, header and cut features", async () => {
    const doc = await prepareDocument("a", printDocumentBytes);
    expect(doc.header.mapScale).toBe(10000);
    expect(doc.colours).toBe(doc.header.colours);
    expect(doc.input.objects).toHaveLength(3);
    // The boulder (204) is a cut feature at its place, paper mm.
    expect(doc.cutFeatures.map((f) => [f.x, f.y])).toEqual([[15, -10]]);
  });

  it("reads and decodes a hash once while it is kept; the third hash evicts the oldest", async () => {
    const read = vi.fn(printDocumentBytes);
    const first = await prepareDocument("a", read);
    expect(await prepareDocument("a", read)).toBe(first);
    expect(read).toHaveBeenCalledTimes(1);
    await prepareDocument("b", read);
    await prepareDocument("c", read);
    expect(read).toHaveBeenCalledTimes(3);
    await prepareDocument("c", read);
    await prepareDocument("b", read);
    expect(read).toHaveBeenCalledTimes(3);
    expect(await prepareDocument("a", read)).not.toBe(first);
    expect(read).toHaveBeenCalledTimes(4);
  });

  it("shares one decode between concurrent callers and forgets a failed one", async () => {
    const read = vi.fn(printDocumentBytes);
    const [x, y] = await Promise.all([prepareDocument("a", read), prepareDocument("a", read)]);
    expect(x).toBe(y);
    expect(read).toHaveBeenCalledTimes(1);
    await expect(prepareDocument("bad", () => new Uint8Array([1, 2, 3]))).rejects.toThrow();
    const ok = await prepareDocument("bad", printDocumentBytes);
    expect(ok.input.objects).toHaveLength(3);
  });
});

describe("prepareDocument with a patch (docs/map-patches.md §2; course-print.md §8.2)", () => {
  const HASH = "ab".repeat(32);
  const ADD_ID = "00000000-0000-4000-8000-000000000001";
  const patchOf = (version: string, input: Partial<MapPatchInput> = {}): PrintPatch => ({ version, patch: mapPatchSchema.parse({ documentHash: HASH, ...input }) });
  const hideBoulder = patchOf("7", { ops: { "hide:1": { op: "hide", sourceIndex: 1 } } });

  it("prepares the effective document: a hidden boulder is neither drawn nor cut around; an added one is both", async () => {
    const hidden = await prepareDocument(HASH, printDocumentBytes, hideBoulder);
    expect(hidden.input.objects).toHaveLength(2);
    expect(hidden.input.stats.patchHidden).toBe(1);
    expect(hidden.cutFeatures).toEqual([]);
    expect(hidden.patchIssues).toEqual([]);

    const added = await prepareDocument(HASH, printDocumentBytes, patchOf("8", {
      ops: { [`add:${ADD_ID}`]: { op: "add", id: ADD_ID, type: OBJECT_TYPE.point, symbol: { doc: 1 }, coords: [[-2000, 3000]] } },
    }));
    expect(added.input.objects).toHaveLength(4);
    expect(added.cutFeatures.map((f) => [f.x, f.y])).toEqual([[15, -10], [-20, 30]]);
  });

  it("keys by hash + patch version: one entry per version, and a disabled, op-less or null patch shares the unpatched entry", async () => {
    const read = vi.fn(printDocumentBytes);
    const plain = prepareDocument(HASH, read);
    expect(prepareDocument(HASH, read, null)).toBe(plain);
    expect(prepareDocument(HASH, read, patchOf("9"))).toBe(plain);
    expect(prepareDocument(HASH, read, { ...hideBoulder, patch: { ...hideBoulder.patch, enabled: false } })).toBe(plain);
    const v7 = prepareDocument(HASH, read, hideBoulder);
    expect(v7).not.toBe(plain);
    expect(prepareDocument(HASH, read, hideBoulder)).toBe(v7);
    expect(prepareDocument(HASH, read, { ...hideBoulder, version: "8" })).not.toBe(v7);
    await Promise.all([plain, v7]);
    expect(read).toHaveBeenCalledTimes(3);
  });

  it("does not apply a patch keyed onto another document", async () => {
    const other = { ...hideBoulder, patch: { ...hideBoulder.patch, documentHash: "cd".repeat(32) } };
    expect(livePrintPatch(HASH, other)).toBeNull();
    expect(prepareDocument(HASH, printDocumentBytes, other)).toBe(prepareDocument(HASH, printDocumentBytes));
  });

  it("names its key: the hash alone without a live patch, else hash and version", () => {
    expect(preparedDocumentKey(HASH, null)).toBe(HASH);
    expect(preparedDocumentKey(HASH, patchOf("9"))).toBe(HASH);
    expect(preparedDocumentKey(HASH, hideBoulder)).toBe(`${HASH}:7`);
  });

  it("skips an op it cannot apply and lists it in patchIssues", async () => {
    const doc = await prepareDocument(HASH, printDocumentBytes, patchOf("10", { ops: { "hide:99": { op: "hide", sourceIndex: 99 }, "hide:1": { op: "hide", sourceIndex: 1 } } }));
    expect(doc.patchIssues).toEqual([{ opId: "hide:99", code: "target-missing" }]);
    expect(doc.input.objects).toHaveLength(2);
  });
});

describe("objectsNear", () => {
  it("selects by extent plus margin", async () => {
    const all = (await prepareDocument("a", printDocumentBytes)).input.objects;
    expect(objectsNear(all, { minX: 500, minY: 500, width: 10, height: 10 }, 20)).toHaveLength(0);
    expect(objectsNear(all, { minX: 500, minY: 500, width: 10, height: 10 }, 100)).toHaveLength(1);
    const centre = objectsNear(all, { minX: -1, minY: -1, width: 2, height: 2 }, 0);
    expect(centre.length).toBeGreaterThan(0);
    expect(centre.length).toBeLessThan(all.length);
  });
});
