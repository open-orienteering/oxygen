/**
 * A small pinned document for Map mode's drawing tests (docs/course-editor.md §13 "Drawing", "Symbol picker"): matched
 * to ISOM 2017-2, 100 units per mm, a colour stack with black and the point brown (so `ISOM2017-2:204` boulder and
 * `ISOM2017-2:110` small elongated knoll materialise, the blue `312` spring does not).
 *
 * Symbols: 0 `403` area (own render, yellow), 1 `505` line (own render, black), 2 `204` point (own render, black,
 * not orientable), 3 `110` point (own render, brown, orientable). Objects: area source 3, line source 7, boulder
 * source 11 (angle 0), knoll source 12 (angle 450 = 45°).
 */

import { mapDocument, symbolLibrary } from "@oxygen/shared";

const T = mapDocument.OBJECT_TYPE;
export const HASH = "ab".repeat(32);

const colours = [
  { id: "src:0", name: "Black", cmyk: [0, 0, 0, 1] as [number, number, number, number], paletteIds: ["black100"] },
  { id: "src:1", name: "Brown", cmyk: [0, 0.56, 1, 0.18] as [number, number, number, number], paletteIds: ["brown100-point", "brown100-line"] },
  { id: "src:2", name: "Yellow", cmyk: [0, 0.27, 0.79, 0] as [number, number, number, number], paletteIds: ["yellow100"] },
];

/** A disc, or (rotatable) a stroke along the glyph's +x: what turns with the object's angle. */
const glyph = (rotatable: boolean) => rotatable
  ? { rotatable, parts: [{ kind: "stroke" as const, colour: 1, widthUm: 200, geometry: { coords: [0, 0, 600, 0] } }] }
  : { rotatable, parts: [{ kind: "disc" as const, colour: 0, diameterUm: 400 }] };

export function pinnedDoc(): mapDocument.MapDocument {
  return mapDocument.decodeMapDocument(mapDocument.encodeMapDocument({
    header: {
      format: { version: 1, importer: "test-1" },
      source: { kind: "ocad", version: "2018.8.3", hash: "00".repeat(32), bytes: 1 },
      unitsPerMm: 100,
      mapScale: 15000,
      documentFactor: 1,
      library: { id: "ISOM2017-2", version: symbolLibrary.SYMBOL_LIBRARY_VERSION },
      georeferencing: { crs: null, paperOrigin: null },
      colours,
      symbols: [
        { code: "403.0", name: "Rough open land", kind: "area", render: { type: "area", id: "a", code: "403", name: "Rough open land", fill: 2 } },
        { code: "505.0", name: "Path", kind: "line", render: { type: "line", id: "l", code: "505", name: "Path", main: { colour: 0, widthUm: 250 } } },
        { code: "204.0", name: "Boulder", kind: "point", render: { type: "point", id: "p", code: "204", name: "Boulder", orientation: "north", glyph: glyph(false) } },
        { code: "110.0", name: "Small elongated knoll", kind: "point", render: { type: "point", id: "k", code: "110", name: "Small elongated knoll", orientation: "object", glyph: glyph(true) } },
      ] as mapDocument.DocumentSymbolInput[],
    },
    objects: [
      { symbolIdx: 0, type: T.area, sourceIndex: 3, coords: [0, 0, 4000, 0, 4000, 4000, 0, 4000], flags: [0, 0, 0, 0] },
      { symbolIdx: 1, type: T.line, sourceIndex: 7, coords: [0, 2000, 4000, 2000], flags: [0, 0] },
      { symbolIdx: 2, type: T.point, sourceIndex: 11, coords: [1000, 1000], flags: [0] },
      { symbolIdx: 3, type: T.point, sourceIndex: 12, coords: [3000, 1000], flags: [0], angleDeciDeg: 450 },
    ],
  }));
}

export const patchOf = (ops: mapDocument.PatchOp[], symbols: Record<string, mapDocument.PatchSymbol> = {}): mapDocument.MapPatch => mapDocument.mapPatchSchema.parse({
  documentHash: HASH, enabled: true, symbols, ops: Object.fromEntries(ops.map((op) => [mapDocument.patchOpId(op), op])),
});
