import { describe, expect, it } from "vitest";
import { mapDocument } from "@oxygen/shared";
import { pickIndexOf } from "../symbol-pick";

const T = mapDocument.OBJECT_TYPE;
/** Bottom first: yellow under brown under black. */
const colours = [
  { id: "src:0", name: "Yellow", cmyk: [0, 0.27, 0.79, 0] as [number, number, number, number] },
  { id: "src:1", name: "Brown", cmyk: [0, 0.56, 1, 0.18] as [number, number, number, number] },
  { id: "src:2", name: "Black", cmyk: [0, 0, 0, 1] as [number, number, number, number] },
];
const YELLOW = 0, BROWN = 1, BLACK = 2;
const line = (code: string, colour: number, widthUm = 300) => ({ code, name: code, kind: "line" as const, render: { type: "line" as const, id: code, code, name: code, main: { colour, widthUm } } });

/**
 * 100 units per mm. A yellow area (0..40 × 0..40, drawn below), a black line across it at y = 20, a brown
 * line at y = 30 of a hidden symbol, a text at (5, 5), and a point of a symbol without a drawing (proxy).
 */
function doc() {
  const bytes = mapDocument.encodeMapDocument({
    header: {
      format: { version: 1, importer: "test-1" },
      source: { kind: "ocad", version: "2018.8.3", hash: "00".repeat(32), bytes: 1 },
      unitsPerMm: 100,
      mapScale: 15000,
      georeferencing: { crs: null, paperOrigin: null },
      colours,
      symbols: ([
        { code: "403.0", name: "Rough open land", kind: "area" as const, render: { type: "area" as const, id: "a", code: "403", name: "Rough open land", fill: YELLOW } },
        line("505.0", BLACK),
        line("999.0", BROWN),
        { code: "821.0", name: "Name", kind: "text" as const, render: { type: "text" as const, id: "t", code: "821", name: "Name", fontFamily: "liberation-sans", fontSizeUm: 4000, colour: 0 } },
        { code: "204.0", name: "Boulder", kind: "point" as const, render: null },
      ] as mapDocument.DocumentSymbolInput[]).map((s, i) => (i === 2 ? { ...s, hidden: true } : s)),
    },
    objects: [
      { symbolIdx: 0, type: T.area, sourceIndex: 0, coords: [0, 0, 4000, 0, 4000, 4000, 0, 4000], flags: [0, 0, 0, 0] },
      { symbolIdx: 1, type: T.line, sourceIndex: 1, coords: [0, 2000, 4000, 2000], flags: [0, 0] },
      { symbolIdx: 1, type: T.line, sourceIndex: 2, coords: [0, 1000, 4000, 1000], flags: [0, 0] },
      { symbolIdx: 2, type: T.line, sourceIndex: 3, coords: [0, 3000, 4000, 3000], flags: [0, 0] },
      { symbolIdx: 3, type: T.text, sourceIndex: 4, text: "Norra", coords: [500, 500, 1500, 500, 1500, 900, 500, 900], flags: [0, 0, 0, 0] },
      { symbolIdx: 4, type: T.point, sourceIndex: 5, coords: [6000, 6000], flags: [0] },
    ],
  });
  return mapDocument.decodeMapDocument(bytes);
}

describe("the eyedropper's pick (docs/course-editor.md §6.4)", () => {
  const index = pickIndexOf(doc());

  it("counts the objects per symbol (the grouped list leaves unused ones out)", () => {
    expect([...index.objectsPerSymbol]).toEqual([1, 2, 1, 1, 1]);
  });

  it("an area is picked inside it, with the colour of the pass under the click", () => {
    expect(index.symbolAt({ x: 10, y: 25 }, 0.5)).toEqual({ symbolIdx: 0, colour: YELLOW });
  });

  it("a line drawn over the area wins within the tolerance (what is drawn on top)", () => {
    expect(index.symbolAt({ x: 10, y: 20.3 }, 0.5)).toEqual({ symbolIdx: 1, colour: BLACK });
    // Beyond half its width plus the tolerance, the area under it is picked.
    expect(index.symbolAt({ x: 10, y: 21 }, 0.5)?.symbolIdx).toBe(0);
  });

  it("a hidden symbol is never picked; a text is picked by its box; a proxy-drawn point by its disc", () => {
    expect(index.symbolAt({ x: 10, y: 30 }, 0.5)?.symbolIdx).toBe(0);
    expect(index.symbolAt({ x: 10, y: 7 }, 0.5)).toEqual({ symbolIdx: 3, colour: null });
    expect(index.symbolAt({ x: 60.2, y: 60 }, 0.5)?.symbolIdx).toBe(4);
  });

  it("empty map picks nothing", () => {
    expect(index.symbolAt({ x: 100, y: 100 }, 0.5)).toBeNull();
  });

  describe("over the effective document (map-patches §2.4)", () => {
    const ADD = "00000000-0000-7000-8000-000000000001";
    const ADD2 = "00000000-0000-7000-8000-000000000002";
    const patched = mapDocument.applyPatch(doc(), {
      documentHash: "ab".repeat(32), enabled: true,
      symbols: { "ISOM2017-2:506": mapDocument.patchSymbolSchema.parse({ code: "506", name: "Path", kind: "line", render: line("506", BLACK, 250).render }) },
      ops: {
        // The black line at y = 20 hidden; the one at y = 10 moved to y = 15.
        "hide:1": { op: "hide", sourceIndex: 1 },
        "modify:2": { op: "modify", sourceIndex: 2, coords: [[0, 1500], [4000, 1500]] },
        [`add:${ADD}`]: { op: "add", id: ADD, type: T.line, symbol: { doc: 1 }, coords: [[0, 3500], [4000, 3500]] },
        [`add:${ADD2}`]: { op: "add", id: ADD2, type: T.line, symbol: { patch: "ISOM2017-2:506" }, coords: [[5000, 0], [5000, 4000]] },
      },
    }).document;
    const eff = pickIndexOf(patched);

    it("a hidden object is not picked or counted; a modified one is picked where it now is", () => {
      expect(eff.symbolAt({ x: 10, y: 20 }, 0.3)?.symbolIdx).toBe(0);
      expect(eff.symbolAt({ x: 10, y: 10 }, 0.3)?.symbolIdx).toBe(0);
      expect(eff.symbolAt({ x: 10, y: 15 }, 0.3)).toEqual({ symbolIdx: 1, colour: BLACK });
    });

    it("an added object of a document symbol is picked and counted; one of a patch symbol is neither", () => {
      expect(eff.symbolAt({ x: 10, y: 35 }, 0.3)).toEqual({ symbolIdx: 1, colour: BLACK });
      expect(eff.symbolAt({ x: 50, y: 20 }, 0.3)).toBeNull();
      // Per document symbol only: the hidden line drops out, the added one counts.
      expect([...eff.objectsPerSymbol]).toEqual([1, 2, 1, 1, 1]);
    });
  });
});
