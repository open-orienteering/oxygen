/**
 * The prepared print document (docs/course-print.md §8.2): decoded and
 * bridged once per hash, the last two kept, a failed decode not kept; the
 * objects near a window by extent plus margin. Moved from the API's
 * `render/window-raster.ts` with the print pipeline (G13).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { objectsNear, prepareDocument, resetPreparedDocuments } from "../prepared-document.js";
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
