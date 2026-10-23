import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { OBJECT_TYPE, decodeMapDocument, encodeMapDocument, type MapDocumentInput, type MapObjectInput } from "../index.js";
import { documentRenderInput } from "../render-bridge.js";
import { COORD_FLAG } from "../../render/pass-stream.js";
import { symbolise } from "../../render/symbolise.js";
import { liberation } from "../../render/__tests__/fonts.js";
import type { TextSymbol } from "../../render/symbol.js";
import { SYMBOL_LIBRARY_VERSION } from "../../symbol-library/index.js";

/** A document whose symbols use every IR field B1 added (docs/map-rendering.md §3–4). */
const header: MapDocumentInput["header"] = {
  format: { version: 1, importer: "test-1" },
  source: { kind: "ocad", version: "2018.8.3", hash: "00".repeat(32), bytes: 1 },
  unitsPerMm: 100,
  mapScale: 15000,
  georeferencing: { crs: null, paperOrigin: { x: 0, y: 0 }, gridRotationDeg: 0 },
  colours: [
    { id: "src:0", name: "Black", cmyk: [0, 0, 0, 1], sourceNumber: 0 },
    { id: "src:1", name: "Brown", cmyk: [0, 0.56, 1, 0.18], sourceNumber: 1 },
    { id: "src:2", name: "White", cmyk: [0, 0, 0, 0], sourceNumber: 2 },
    { id: "src:3", name: "Purple", cmyk: [0.35, 0.85, 0, 0], sourceNumber: 3 },
  ],
  symbols: [
    { code: "107.0", name: "Gully", kind: "line", render: { type: "line", id: "s:107", code: "107", name: "Gully", main: { colour: 1, widthUm: 250, cap: "pointed", taper: { startUm: 750, endUm: 750 } } } },
    {
      code: "502.2", name: "Road", kind: "line",
      render: {
        type: "line", id: "s:502.2", code: "502.2", name: "Road",
        main: { colour: 1, widthUm: 300, dash: { layout: "ocad", dashUm: 2000, gapUm: 500 }, halo: { colour: 0, widthUm: -100, continuous: true } },
        borders: { left: { colour: 0, widthUm: 140, shiftUm: 500 }, right: { colour: 0, widthUm: 140, shiftUm: 500 }, extraPairs: [{ left: { colour: 3, widthUm: 100, shiftUm: 900 } }] },
      },
    },
    { code: "850.1", name: "Frame", kind: "line", render: { type: "line", id: "s:850.1", code: "850.1", name: "Frame", cornerRadiusUm: 2290, main: { colour: 3, widthUm: 180 } } },
    {
      code: "821.0", name: "Name", kind: "text", sourceFont: "Arial",
      render: { type: "text", id: "s:821", code: "821", name: "Name", fontFamily: "liberation-sans", fontSizeUm: 4000, weight: 700, colour: 0, verticalAlign: "middle", shadow: { colour: 2, offsetXUm: 150, offsetYUm: -150 } },
    },
  ],
};

const obj = (o: Partial<MapObjectInput> & { coords: number[] }): MapObjectInput => ({
  symbolIdx: 0, type: OBJECT_TYPE.line, sourceIndex: 0, flags: new Array(o.coords.length / 2).fill(0), ...o,
});

const doc = () =>
  decodeMapDocument(
    encodeMapDocument({
      header,
      objects: [
        obj({ sourceIndex: 0, coords: [0, 0, 1000, 0] }),
        obj({ sourceIndex: 1, symbolIdx: 1, coords: [0, 1000, 1000, 1000, 2000, 1000], flags: [0, COORD_FLAG.dash, 0] }),
        obj({ sourceIndex: 2, symbolIdx: 2, type: OBJECT_TYPE.rectangle, coords: [0, 2000, 1000, 2000, 1000, 2600, 0, 2600] }),
        obj({ sourceIndex: 3, symbolIdx: 3, type: OBJECT_TYPE.text, text: "Norra", angleDeciDeg: 300, coords: [500, 3000] }),
      ],
    }),
  );

describe("documentRenderInput → symbolise (every B1 field through a document)", () => {
  it("symbolises warning-free, with the new fields visible in the stream", () => {
    const input = documentRenderInput(doc(), { unmatched: "drop" });
    expect(input.stats).toMatchObject({ rendered: 4, proxied: 0, dropped: 0 });
    const { stream, warnings } = symbolise({ ...input, fonts: [liberation().sans] });
    expect(warnings).toEqual([]);
    const sourceOf = (i: number) => input.symbols[stream.symbolIdx[i]].code;
    const strokes = stream.passes.map((p, i) => ({ p, code: sourceOf(i) })).filter((x) => x.p.kind === "stroke");
    // 107: a pointed stroke with its taper.
    expect(strokes.find((x) => x.code === "107")!.p).toMatchObject({ cap: "pointed", taper: { startUm: 750, endUm: 750 } });
    // 502.2: narrow halo 100 µm, main, two first-pair borders, one extra border.
    expect(strokes.filter((x) => x.code === "502.2").map((x) => x.p.kind === "stroke" && x.p.widthUm).sort()).toEqual([100, 100, 140, 140, 300]);
    // 850.1: the rectangle is drawn closed with four rounded corners.
    const frame = strokes.find((x) => x.code === "850.1")!.p;
    expect(frame.kind === "stroke" && frame.path.closed && frame.path.flags.length).toBe(16);
    // 821: shadow pass + text pass, rotated 30°.
    const texts = stream.passes.filter((p) => p.kind === "text");
    expect(texts.map((p) => p.colour)).toEqual([0, 2]);
    for (const t of texts) expect(t.kind === "text" && Array.from(t.angles!)).toEqual([30, 30, 30, 30, 30]);
  });

  it("does not depend on the dev-only S1 reader path", () => {
    const src = readFileSync(fileURLToPath(new URL("../render-bridge.ts", import.meta.url)), "utf8");
    expect(src).not.toContain("ocad-objects");
  });
});

describe("documentRenderInput — text layout (map-rendering §4.9, map-document-format §8)", () => {
  const textHeader = (match?: Record<string, unknown>): MapDocumentInput["header"] => ({
    ...header,
    library: { id: "ISOM2017-2", version: SYMBOL_LIBRARY_VERSION },
    documentFactor: 1,
    colours: [
      { id: "src:0", name: "Black", cmyk: [0, 0, 0, 1], sourceNumber: 0, paletteIds: ["black100"] },
      { id: "src:1", name: "White", cmyk: [0, 0, 0, 0], sourceNumber: 1, paletteIds: ["white"] },
      { id: "src:2", name: "Purple", cmyk: [0.35, 0.85, 0, 0], sourceNumber: 2, paletteIds: ["purple-lower"] },
    ],
    symbols: [{
      code: "704.0", name: "Control number", kind: "text",
      render: {
        type: "text", id: "s:704", code: "704", name: "Control number", fontFamily: "liberation-sans-narrow", fontSizeUm: 3000, weight: 700, colour: 0,
        align: "right", verticalAlign: "middle", lineSpacing: 1.5, paragraphSpacingUm: 300, charSpacing: 0.1, tabStops: [{ xUm: 4000 }],
        shadow: { colour: 1, offsetXUm: 100, offsetYUm: -100 }, frame: { colour: 1, leftUm: 100, bottomUm: 100, rightUm: 100, topUm: 100 },
      },
      ...(match ? { match: { canonicalId: "ISOM2017-2:704", method: "code+geometry", state: "auto", confidence: 1, libraryVersion: SYMBOL_LIBRARY_VERSION, ...match } } : {}),
    }],
  });
  const textDoc = (match?: Record<string, unknown>) =>
    decodeMapDocument(encodeMapDocument({
      header: textHeader(match),
      objects: [
        obj({ sourceIndex: 0, type: OBJECT_TYPE.text, text: "1", coords: [0, 0], flags: [0] }),
        obj({ sourceIndex: 1, type: OBJECT_TYPE.formattedText, text: "2", coords: [0, 0, 3000, 0, 3000, 1000, 0, 1000], flags: [0, 0, 0, 0] }),
        obj({ sourceIndex: 2, type: OBJECT_TYPE.lineText, text: "3", coords: [0, 0, 3000, 0], flags: [0, 0] }),
      ],
    }));

  it("sets textLayout from the object type: formatted text is box text, line text runs along its path", () => {
    const { objects } = documentRenderInput(textDoc());
    const byText = Object.fromEntries(objects.map((o) => [o.text, o.textLayout]));
    expect(byText).toEqual({ "1": undefined, "2": "box", "3": "path" });
  });

  it("a canonically drawn text symbol keeps the source's layout and takes the entry's appearance; shadow and frame stay behind", () => {
    const { symbols, stats } = documentRenderInput(textDoc({}));
    expect(stats.canonicalSymbols).toBe(1);
    const t = symbols[0] as TextSymbol;
    expect(t.id).toBe("ISOM2017-2:704");
    // Entry appearance.
    expect(t).toMatchObject({ fontFamily: "liberation-sans", digitHeightUm: 4000, weight: 400, colour: 2 });
    // Source layout.
    expect(t).toMatchObject({ align: "right", verticalAlign: "middle", lineSpacing: 1.5, paragraphSpacingUm: 300, charSpacing: 0.1, tabStops: [{ xUm: 4000 }] });
    expect(t.wordSpacing).toBeUndefined();
    expect(t.shadow).toBeUndefined();
    expect(t.frame).toBeUndefined();
    // A suggested (not applied) match draws the source as it is.
    const src = documentRenderInput(textDoc({ state: "suggested" })).symbols[0] as TextSymbol;
    expect(src).toMatchObject({ fontFamily: "liberation-sans-narrow", shadow: { colour: 1 }, frame: { colour: 1 } });
  });
});
