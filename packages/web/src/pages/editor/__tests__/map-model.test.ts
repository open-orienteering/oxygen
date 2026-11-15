import { describe, expect, it } from "vitest";
import { mapDocument } from "@oxygen/shared";
import {
  centreOf, changes, correctedRefs, drawnCovers, correctionRows, hideChange, hitsObject, inverseChange, isHidden, mapModelOf, moveOp, objectInfo, refKey,
  restoreChange, stepRef,
} from "../modes/map/model";

const T = mapDocument.OBJECT_TYPE;
const HASH = "ab".repeat(32);
const ADD = "00000000-0000-7000-8000-000000000001";
const colours = [
  { id: "src:0", name: "Yellow", cmyk: [0, 0.27, 0.79, 0] as [number, number, number, number] },
  { id: "src:1", name: "Black", cmyk: [0, 0, 0, 1] as [number, number, number, number] },
];
const line = (code: string, name: string) => ({ code, name, kind: "line" as const, render: { type: "line" as const, id: code, code, name, main: { colour: 1, widthUm: 300 } } });

/** 100 units per mm: a yellow area (0..40), a black line at y = 20 (source 7), a line with a curve flag (source 9). */
function pinned() {
  return mapDocument.decodeMapDocument(mapDocument.encodeMapDocument({
    header: {
      format: { version: 1, importer: "test-1" },
      source: { kind: "ocad", version: "2018.8.3", hash: "00".repeat(32), bytes: 1 },
      unitsPerMm: 100,
      mapScale: 15000,
      georeferencing: { crs: null, paperOrigin: null },
      colours,
      symbols: [
        { code: "403.0", name: "Rough open land", kind: "area", render: { type: "area", id: "a", code: "403", name: "Rough open land", fill: 0 } },
        line("505.0", "Path"),
      ] as mapDocument.DocumentSymbolInput[],
    },
    objects: [
      { symbolIdx: 0, type: T.area, sourceIndex: 3, coords: [0, 0, 4000, 0, 4000, 4000, 0, 4000], flags: [0, 0, 0, 0] },
      { symbolIdx: 1, type: T.line, sourceIndex: 7, coords: [0, 2000, 4000, 2000], flags: [0, 0] },
      { symbolIdx: 1, type: T.line, sourceIndex: 9, coords: [0, 3000, 2000, 3000, 4000, 3000], flags: [0, 1, 0] },
    ],
  }));
}

const patchOf = (ops: mapDocument.PatchOp[], enabled = true): mapDocument.MapPatch => mapDocument.mapPatchSchema.parse({
  documentHash: HASH, enabled, symbols: {}, ops: Object.fromEntries(ops.map((op) => [mapDocument.patchOpId(op), op])),
});

describe("Map mode's model (docs/course-editor.md §13)", () => {
  it("names objects by source index or add id; a hide is a hide op, an added object's hide removes its add", () => {
    expect(refKey({ source: 7 })).toBe("source:7");
    expect(refKey({ added: ADD })).toBe(`added:${ADD}`);
    expect(hideChange({ source: 7 })).toEqual({ put: [{ op: "hide", sourceIndex: 7 }] });
    expect(hideChange({ added: ADD })).toEqual({ remove: [`add:${ADD}`] });
    expect(restoreChange({ source: 7 })).toEqual({ remove: ["hide:7"] });
    const p = patchOf([{ op: "hide", sourceIndex: 7 }]);
    expect(isHidden(p, { source: 7 })).toBe(true);
    expect(isHidden(p, { source: 9 })).toBe(false);
  });

  it("a move shifts every coordinate by one rounded integer delta, flags kept", () => {
    const m = mapModelOf(HASH, pinned(), null);
    expect(moveOp(m, null, { source: 9 }, 1.004, -0.5)).toEqual({ op: "modify", sourceIndex: 9, coords: [[100, 2950], [2100, 2950, 1], [4100, 2950]] });
    expect(moveOp(m, null, { source: 9 }, 0.004, 0)).toBeNull();
    expect(moveOp(m, null, { source: 42 }, 1, 1)).toBeNull();
  });

  it("a move over an existing modify starts from its coordinates and keeps its angle", () => {
    const p = patchOf([{ op: "modify", sourceIndex: 7, coords: [[0, 1000], [4000, 1000]], angle: 450 }]);
    const m = mapModelOf(HASH, pinned(), p);
    expect(moveOp(m, p, { source: 7 }, 0, 1)).toEqual({ op: "modify", sourceIndex: 7, coords: [[0, 1100], [4000, 1100]], angle: 450 });
  });

  it("a move of an added object rewrites its add", () => {
    const add: mapDocument.PatchOp = { op: "add", id: ADD, type: 2, symbol: { doc: 1 }, coords: [[100, 100], [200, 100]] };
    const p = patchOf([add]);
    const m = mapModelOf(HASH, pinned(), p);
    expect(m.indexOf({ added: ADD })).toBe(3);
    expect(moveOp(m, p, { added: ADD }, 1, 0)).toEqual({ ...add, coords: [[200, 100], [300, 100]] });
  });

  it("the inverse of a change puts back what was there and removes what was not", () => {
    const prev: mapDocument.PatchOp = { op: "modify", sourceIndex: 7, coords: [[0, 0], [1, 1]] };
    const before = patchOf([prev, { op: "hide", sourceIndex: 9 }]);
    expect(inverseChange(before, { put: [{ op: "modify", sourceIndex: 7, coords: [[5, 5], [6, 6]] }] })).toEqual({ put: [prev] });
    expect(inverseChange(before, { put: [{ op: "hide", sourceIndex: 3 }] })).toEqual({ remove: ["hide:3"] });
    expect(inverseChange(before, { remove: ["hide:9"] })).toEqual({ put: [{ op: "hide", sourceIndex: 9 }] });
    expect(inverseChange(null, { remove: ["hide:9"] })).toBeNull();
    expect(changes(before, { put: [{ op: "hide", sourceIndex: 9 }] })).toBe(false);
    expect(changes(before, { remove: ["hide:3"] })).toBe(false);
    expect(changes(before, { remove: ["hide:9"] })).toBe(true);
  });

  it("names the object's symbol and box; a hidden object is still found (its row restores it)", () => {
    const m = mapModelOf(HASH, pinned(), patchOf([{ op: "hide", sourceIndex: 7 }]));
    expect(objectInfo(m, { source: 7 }, "en")).toMatchObject({
      type: T.line, code: "505.0", name: "Path", symbolIdx: 1, swatch: { kind: "document", idx: 1 }, bounds: { minX: 0, minY: 20, maxX: 40, maxY: 20 },
    });
    expect(centreOf(m, { source: 7 })).toEqual({ x: 20, y: 20 });
    expect(objectInfo(m, { source: 42 }, "en")).toBeNull();
  });

  it("a press is on the object when its drawn shape is within the tolerance; a hidden one is never pressed", () => {
    const m = mapModelOf(HASH, pinned(), null);
    expect(hitsObject(m, { source: 7 }, { x: 10, y: 20.2 }, 0.3)).toBe(true);
    expect(hitsObject(m, { source: 7 }, { x: 10, y: 21 }, 0.3)).toBe(false);
    expect(hitsObject(m, { source: 3 }, { x: 10, y: 10 }, 0.3)).toBe(true);
    const hidden = mapModelOf(HASH, pinned(), patchOf([{ op: "hide", sourceIndex: 7 }]));
    expect(hitsObject(hidden, { source: 7 }, { x: 10, y: 20 }, 0.3)).toBe(false);
    // A moved object is pressed where it now is.
    const moved = mapModelOf(HASH, pinned(), patchOf([{ op: "modify", sourceIndex: 7, coords: [[0, 1000], [4000, 1000]] }]));
    expect(hitsObject(moved, { source: 7 }, { x: 10, y: 10 }, 0.3)).toBe(true);
    expect(hitsObject(moved, { source: 7 }, { x: 10, y: 20 }, 0.3)).toBe(false);
  });

  it("the model takes the patch as enabled: a switched-off patch still reports its ops and issues", () => {
    const off = patchOf([{ op: "hide", sourceIndex: 7 }, { op: "hide", sourceIndex: 42 }], false);
    const m = mapModelOf(HASH, pinned(), off);
    const rows = correctionRows(m, off, "en");
    expect(rows).toEqual([
      { opId: "hide:42", op: "hide", ref: { source: 42 }, label: null, issue: "target-missing" },
      { opId: "hide:7", op: "hide", ref: { source: 7 }, label: "505.0 Path", issue: null },
    ]);
    // A patch keyed onto another document is not applied.
    expect(mapModelOf(HASH, pinned(), { ...off, documentHash: "cd".repeat(32) }).issues).toEqual([]);
  });

  it("Tab steps through a list, wrapping; the corrected objects once each in Corrections order", () => {
    const p = patchOf([{ op: "hide", sourceIndex: 7 }, { op: "modify", sourceIndex: 7, coords: [[0, 0], [1, 1]] }, { op: "hide", sourceIndex: 3 }]);
    const refs = correctedRefs(correctionRows(mapModelOf(HASH, pinned(), p), p, "en"));
    expect(refs).toEqual([{ source: 3 }, { source: 7 }]);
    expect(stepRef(refs, null, 1)).toEqual({ source: 3 });
    expect(stepRef(refs, null, -1)).toEqual({ source: 7 });
    expect(stepRef(refs, { source: 7 }, 1)).toEqual({ source: 3 });
    expect(stepRef(refs, { source: 3 }, -1)).toEqual({ source: 7 });
    expect(stepRef(refs, { source: 99 }, 1)).toEqual({ source: 3 });
    expect(stepRef([], null, 1)).toBeNull();
  });

  it("Tab skips a row whose object is not in the document", () => {
    const p = patchOf([{ op: "hide", sourceIndex: 42 }, { op: "hide", sourceIndex: 7 }]);
    expect(correctedRefs(correctionRows(mapModelOf(HASH, pinned(), p), p, "en"))).toEqual([{ source: 7 }]);
  });

  it("a committed draft is covered once its version or a later one is drawn", () => {
    expect(drawnCovers(null, "5")).toBe(false);
    expect(drawnCovers("4", "5")).toBe(false);
    expect(drawnCovers("5", "5")).toBe(true);
    expect(drawnCovers("117619361030209536", "117619360975880192")).toBe(true);
    expect(drawnCovers("x", "x")).toBe(true);
  });
});
