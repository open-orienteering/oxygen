/**
 * A small document for the patch tests (docs/map-rendering.md §5.2 "Patch"): 10 mm cells, one row,
 * a line of a hidden symbol the bridge drops, lines, areas and a boulder in five cells.
 */

import { mapDocument } from "@oxygen/shared";

export const T = mapDocument.OBJECT_TYPE;
export const HASH = "ab".repeat(32);
export const CELL_UM = 10_000;
const YELLOW = 0, BLACK = 1;

export const lineSym = (code: string, widthUm = 300, hidden = false) => ({
  code, name: code, kind: "line" as const, hidden,
  render: { type: "line" as const, id: code, code, name: code, main: { colour: BLACK, widthUm } },
});
export const discSym = (code: string, diameterUm: number) => ({
  code, name: code, kind: "point" as const,
  render: { type: "point" as const, id: code, code, name: code, glyph: { parts: [{ kind: "disc" as const, colour: BLACK, diameterUm }], rotatable: false }, orientation: "north" as const },
});

/**
 * 100 units per mm, 10 mm cells along y ∈ [0, 10] mm: source 0 a line of a hidden symbol, 1 a black
 * line in cell 0, 2 one in cell 1, 3 a yellow area in cell 2, 4 a boulder in cell 3, 5 an area in cell 4.
 */
export function documentBytes(): ArrayBuffer {
  const u8 = mapDocument.encodeMapDocument({
    header: {
      format: { version: 1, importer: "test-1" },
      source: { kind: "ocad", version: "2018.8.3", hash: "00".repeat(32), bytes: 1 },
      unitsPerMm: 100,
      mapScale: 15000,
      georeferencing: { crs: null, paperOrigin: null },
      colours: [{ id: "src:0", name: "Yellow", cmyk: [0, 0.27, 0.79, 0] }, { id: "src:1", name: "Black", cmyk: [0, 0, 0, 1] }],
      symbols: [
        lineSym("506.0"),
        { code: "403.0", name: "Rough open land", kind: "area", render: { type: "area", id: "403", code: "403", name: "Rough open land", fill: YELLOW } },
        discSym("204.0", 520),
        lineSym("999.0", 300, true),
      ],
    },
    objects: [
      { symbolIdx: 3, type: T.line, sourceIndex: 0, coords: [100, 200, 900, 200], flags: [0, 0] },
      { symbolIdx: 0, type: T.line, sourceIndex: 1, coords: [500, 100, 500, 900], flags: [0, 0] },
      { symbolIdx: 0, type: T.line, sourceIndex: 2, coords: [1500, 100, 1500, 900], flags: [0, 0] },
      { symbolIdx: 1, type: T.area, sourceIndex: 3, coords: [2100, 100, 2900, 100, 2900, 900, 2100, 900], flags: [0, 0, 0, 0] },
      { symbolIdx: 2, type: T.point, sourceIndex: 4, coords: [3500, 500], flags: [0] },
      { symbolIdx: 1, type: T.area, sourceIndex: 5, coords: [4100, 100, 4900, 100, 4900, 900, 4100, 900], flags: [0, 0, 0, 0] },
    ],
  });
  return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer;
}

/** `objectIndex` of each source object (the encoder orders objects its own way). */
export const index = (() => {
  const doc = mapDocument.decodeMapDocument(new Uint8Array(documentBytes()));
  const out = new Map<number, number>();
  doc.attrs.sourceIndex.forEach((s, i) => out.set(s, i));
  return (source: number) => out.get(source)!;
})();
export const N = 6;
/** Cell id of column `c` (one row). */
export const cell = (c: number) => c;
export const LARGE = 5;

export const patchOf = (ops: mapDocument.PatchOp[], symbols: Record<string, mapDocument.PatchSymbol> = {}, enabled = true): mapDocument.MapPatch => ({
  documentHash: HASH, enabled, symbols, ops: Object.fromEntries(ops.map((o) => [mapDocument.patchOpId(o), o])),
});
export const ADD1 = "00000000-0000-7000-8000-000000000001";
export const ADD2 = "00000000-0000-7000-8000-000000000002";
export const moveLine1 = (xMm: number): mapDocument.PatchOp => ({ op: "modify", sourceIndex: 1, coords: [[xMm * 100, 100], [xMm * 100, 900]] });

