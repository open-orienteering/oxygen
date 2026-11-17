import { describe, it, expect } from "vitest";
import { mapDocument, render, symbolLibrary } from "@oxygen/shared";
import { ocadSymbolNumber, slimObjectsOfDocument, type SlimMapObject } from "../event-map-objects.js";

/**
 * `slimObjectsOfDocument` is the filter that decides what the description
 * autodetect can ever see (docs/map-storage.md §4.6). The decoding itself
 * belongs to the map document codec; what matters here is that nothing
 * unsearchable slips through, that geometry survives in the OCAD-style
 * shape `description-autodetect.ts` reads, and that the symbol code
 * follows the applied match. Parity with the legacy OCAD parse is
 * `document-readers-parity.test.ts`.
 */

const { OBJECT_TYPE } = mapDocument;
const { COORD_FLAG } = render;

type SymbolInput = mapDocument.MapDocumentInput["header"]["symbols"][number];

const header = (symbols: SymbolInput[], unitsPerMm = 100): mapDocument.MapDocumentInput["header"] => ({
  format: { version: 1, importer: "test-1" },
  source: { kind: "ocad", version: "2018", hash: "00".repeat(32), bytes: 1 },
  unitsPerMm,
  mapScale: 15000,
  georeferencing: { crs: null, paperOrigin: null, gridRotationDeg: 0 },
  colours: [{ id: "src:0", name: "Black", cmyk: [0, 0, 0, 1] }],
  symbols,
});

const sym = (code: string, kind: SymbolInput["kind"], extra: Partial<SymbolInput> = {}): SymbolInput => ({ code, name: code, kind, render: null, ...extra });

const obj = (symbolIdx: number, type: number, coords: number[], flags?: number[]): mapDocument.MapObjectInput => ({
  symbolIdx,
  type,
  sourceIndex: 0,
  coords,
  flags: flags ?? new Array(coords.length / 2).fill(0),
});

function slim(symbols: SymbolInput[], objects: mapDocument.MapObjectInput[], unitsPerMm = 100): SlimMapObject[] {
  const doc = mapDocument.decodeMapDocument(mapDocument.encodeMapDocument({ header: header(symbols, unitsPerMm), objects }));
  return slimObjectsOfDocument(doc);
}

describe("ocadSymbolNumber", () => {
  it("reads the reader's code format", () => {
    expect(ocadSymbolNumber("204.0")).toBe(204000);
    expect(ocadSymbolNumber("204.1")).toBe(204001);
    expect(ocadSymbolNumber("102.10")).toBe(102010);
    expect(ocadSymbolNumber("204")).toBe(204000);
  });

  it("answers null for codes that are not numbers", () => {
    expect(ocadSymbolNumber("graphic")).toBeNull();
    expect(ocadSymbolNumber("")).toBeNull();
  });
});

describe("slimObjectsOfDocument", () => {
  it("keeps a mapped point object with its bbox", () => {
    expect(slim([sym("204.0", "point")], [obj(0, OBJECT_TYPE.point, [100, 200])])).toEqual([
      { sym: 204000, objType: 1, coordinates: [[100, 200]], bbox: [100, 200, 100, 200] },
    ]);
  });

  it("computes the bbox of a polyline", () => {
    const [line] = slim([sym("505.0", "line")], [obj(0, OBJECT_TYPE.line, [0, 0, 300, -50, 100, 400])]);
    expect(line.bbox).toEqual([0, -50, 300, 400]);
  });

  it("drops symbols with no description meaning", () => {
    // Contour, course overprint control circle.
    const objects = slim([sym("101.0", "line"), sym("702.0", "point")], [obj(0, OBJECT_TYPE.line, [0, 0, 10, 10]), obj(1, OBJECT_TYPE.point, [0, 0])]);
    expect(objects).toEqual([]);
  });

  it("drops text and rectangle object types", () => {
    const objects = [OBJECT_TYPE.text, OBJECT_TYPE.formattedText, OBJECT_TYPE.lineText, OBJECT_TYPE.rectangle].map((t) =>
      obj(0, t, [0, 0, 10, 10]),
    );
    expect(slim([sym("204.0", "point")], objects)).toEqual([]);
  });

  it("drops objects of hidden symbols", () => {
    expect(slim([sym("204.0", "point", { hidden: true })], [obj(0, OBJECT_TYPE.point, [0, 0])])).toEqual([]);
  });

  it("drops objects the patch hides and keeps the ones it adds (map-patches §2.4)", () => {
    const doc = mapDocument.decodeMapDocument(mapDocument.encodeMapDocument({
      header: header([sym("204.0", "point")]),
      objects: [{ ...obj(0, OBJECT_TYPE.point, [100, 200]), sourceIndex: 4 }, { ...obj(0, OBJECT_TYPE.point, [300, 400]), sourceIndex: 5 }],
    }));
    const id = "00000000-0000-4000-8000-0000000000c3";
    const { document } = mapDocument.applyPatch(doc, mapDocument.mapPatchSchema.parse({
      documentHash: "ab".repeat(32),
      ops: { "hide:4": { op: "hide", sourceIndex: 4 }, [`add:${id}`]: { op: "add", id, type: OBJECT_TYPE.point, symbol: { doc: 0 }, coords: [[500, 600]] } },
    }));
    expect(slimObjectsOfDocument(document).map((o) => o.coordinates[0])).toEqual([[300, 400], [500, 600]]);
  });

  it("drops non-numeric codes (graphics)", () => {
    expect(slim([sym("graphic", "line", { origin: "graphic" })], [obj(0, OBJECT_TYPE.line, [0, 0, 10, 10])])).toEqual([]);
  });

  it("uses the applied match's canonical code, else the source code", () => {
    const match = (state: "auto" | "suggested") => ({
      canonicalId: "ISOM2017-2:204",
      method: "geometry" as const,
      state,
      confidence: 0.9,
      libraryVersion: symbolLibrary.SYMBOL_LIBRARY_VERSION,
    });
    const objects = slim(
      [sym("900.0", "point", { match: match("auto") }), sym("901.0", "point", { match: match("suggested") })],
      [obj(0, OBJECT_TYPE.point, [1, 1]), obj(1, OBJECT_TYPE.point, [2, 2])],
    );
    // 900 has no description meaning: only the applied match makes it a boulder.
    expect(objects.map((o) => o.sym)).toEqual([204000]);
  });

  it("keeps only the outer ring of an area with holes", () => {
    const [area] = slim(
      [sym("521.0", "area")],
      [obj(0, OBJECT_TYPE.area, [0, 0, 100, 0, 100, 100, 20, 20, 40, 20], [0, 0, 0, COORD_FLAG.hole, 0])],
    );
    expect(area.coordinates).toEqual([
      [0, 0],
      [100, 0],
      [100, 100],
    ]);
    expect(area.bbox).toEqual([0, 0, 100, 100]);
  });

  it("flattens Bezier segments onto the drawn curve instead of keeping the handles", () => {
    // A path from (0,0) to (1000,0) bowing north: handles 800 units above
    // the chord. The drawn curve peaks at 0.75 × 800 = 600 — never at the
    // handle height.
    const [line] = slim(
      [sym("505.0", "line")],
      [obj(0, OBJECT_TYPE.line, [0, 0, 0, 800, 1000, 800, 1000, 0], [0, COORD_FLAG.bezierFirst, COORD_FLAG.bezierSecond, 0])],
    );
    const ys = line.coordinates.map((c) => c[1]);
    expect(Math.max(...ys)).toBeCloseTo(600, 0);
    expect(line.coordinates[0]).toEqual([0, 0]);
    expect(line.coordinates.at(-1)).toEqual([1000, 0]);
    // 1 anchor + 8 flattened steps.
    expect(line.coordinates).toHaveLength(9);
    expect(line.bbox[3]).toBeCloseTo(600, 0);
  });

  it("keeps a lone Bezier-flagged vertex when the segment is incomplete", () => {
    const [line] = slim([sym("505.0", "line")], [obj(0, OBJECT_TYPE.line, [0, 0, 50, 50], [0, COORD_FLAG.bezierFirst])]);
    expect(line.coordinates).toEqual([
      [0, 0],
      [50, 50],
    ]);
  });

  it("answers in 1/100 mm whatever the document's unit", () => {
    // OMAP: 1000 units per mm.
    const [point] = slim([sym("204.0", "point")], [obj(0, OBJECT_TYPE.point, [12_340, -5_000])], 1000);
    expect(point.coordinates).toEqual([[1234, -500]]);
  });
});
