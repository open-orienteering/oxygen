import { describe, expect, it } from "vitest";
import { type mapImport, mapDocument, render } from "@oxygen/shared";
import { glyphOutlineFrom, loadBundledFonts } from "../fonts.js";
import { rasterisePassStream } from "../reference-raster.js";
import {
  changedMask,
  classify,
  colourCensus,
  decodePaints,
  GRAPHIC_PREFIX,
  idHex,
  inverseOrder,
  kindKey,
  nameChanges,
  nameLayers,
  NOTHING,
  NOTHING_NAME,
  paintNamer,
  paintStream,
  paletteRank,
  parseClassification,
  permutationOrder,
  permuteStack,
  permutedRenderOptions,
  namePeeled,
  fineKindOf,
  reportedClasses,
  namePatternMatches,
  rankTiles,
  rasterisePaints,
  sideBySide,
  splitKind,
  stackLayers,
  suggestClass,
  tileGrid,
  UNATTRIBUTED,
  UNDECODABLE,
  viewKind,
  sharedTop,
  withoutRows,
  viewKindOf,
  flipKind,
  correspondingNamer,
  jointDocument,
  layeredCandidate,
  objectsPerSymbol,
  paintCorrespondence,
  paintKey,
  sourceTableOf,
  withoutPasses,
  type PaintView,
  type Rgba,
  type StackLayer,
} from "../colour-order-diff.js";

/** A one-row image from RGB triples (alpha 255). */
const row = (...px: [number, number, number][]): Rgba => ({ width: px.length, height: 1, pixels: Uint8Array.from(px.flatMap((p) => [...p, 255])) });
const W: [number, number, number] = [255, 255, 255];
const rank = paletteRank("iof2024", "ISOM2017-2");

describe("changedMask", () => {
  it("marks pixels whose largest channel difference exceeds the tolerance and counts the source's ink", () => {
    const a = row(W, [100, 100, 100], [100, 100, 100], [0, 0, 0]);
    const b = row(W, [116, 100, 100], [117, 100, 100], [0, 0, 0]);
    const r = changedMask(a, b, 16);
    expect([...r.mask]).toEqual([0, 0, 1, 0]);
    expect(r).toMatchObject({ changed: 1, inked: 3 });
    expect(changedMask(a, b).changed).toBe(1); // the default is the golden tier's 16
  });

  it("refuses images of different sizes", () => {
    expect(() => changedMask(row(W), row(W, W))).toThrow(/size mismatch/);
  });
});

describe("sideBySide", () => {
  it("puts source, candidate and the difference side by side, red where changed", () => {
    const a = row([0, 0, 0], W), b = row(W, W);
    const out = sideBySide(a, b, Uint8Array.from([1, 0]), 2);
    expect(out.width).toBe(2 * 3 + 2 * 2);
    const px = (x: number) => [...out.pixels.slice(x * 4, x * 4 + 3)];
    expect(px(0)).toEqual([0, 0, 0]);
    expect(px(2)).toEqual([255, 255, 255]); // gap
    expect(px(4)).toEqual([255, 255, 255]); // candidate
    expect(px(8)).toEqual([255, 0, 0]); // changed
    expect(px(9)).toEqual([255, 255, 255]); // unchanged paper stays white
  });
});

describe("tiles", () => {
  const bounds = { minX: -1000, minY: 0, maxX: 125_000, maxY: 60_000 };

  it("covers the bounds with whole tiles, row 0 at the bottom, and keeps only those a window meets", () => {
    const g = tileGrid(bounds, 60);
    expect(g).toMatchObject({ nx: 3, ny: 1 });
    expect(g.tiles[2].bounds).toEqual({ minX: 119_000, minY: 0, maxX: 179_000, maxY: 60_000 });
    expect(tileGrid(bounds, 60, { minX: 70_000, minY: 10_000, maxX: 80_000, maxY: 20_000 }).tiles.map((t) => t.x)).toEqual([1]);
    expect(() => tileGrid(bounds, 0)).toThrow();
  });

  it("ranks by changed pixels, leaves out unchanged tiles, ties by row then column", () => {
    const t = [{ x: 1, y: 0, changed: 5 }, { x: 0, y: 1, changed: 5 }, { x: 0, y: 0, changed: 9 }, { x: 2, y: 0, changed: 0 }];
    expect(rankTiles(t, 5).map((r) => `${r.x},${r.y}`)).toEqual(["0,0", "1,0", "0,1"]);
    expect(rankTiles(t, 1)).toHaveLength(1);
  });
});

describe("paints", () => {
  it("give each (row, kind, symbol) one id rising with the stream's sort key", () => {
    const sq = (x: number) => render.makePath([x, 0, x + 1000, 0, x + 1000, 1000, x, 1000], undefined, true);
    const b = new render.PassStreamBuilder();
    b.push({ kind: "stroke", colour: 3, path: sq(0), widthUm: 100, cap: "butt", join: "miter" }, 0, 7);
    b.push({ kind: "fill", colour: 3, path: sq(0), rule: "evenodd" }, 1, 9);
    b.push({ kind: "fill", colour: 1, path: sq(0), rule: "evenodd" }, 2, 9);
    b.push({ kind: "fill", colour: 3, path: sq(2000), rule: "evenodd" }, 3, 9);
    const { stream, paints } = paintStream(b.build());
    expect(paints).toEqual([
      { row: 1, kind: "fill", symbolIdx: 9 },
      { row: 3, kind: "fill", symbolIdx: 9 },
      { row: 3, kind: "stroke", symbolIdx: 7 },
    ]);
    expect(stream.passes.map((p) => p.colour)).toEqual([0, 1, 1, 2]);
    expect(render.sortPassStream(stream).passes.map((p) => p.colour)).toEqual([0, 1, 1, 2]);
  });

  it("encode an id as id + 1 in 24-bit RGB and decode it back", () => {
    expect(idHex(0)).toBe("#000001");
    expect(idHex(255)).toBe("#000100");
    const img: Rgba = { width: 4, height: 1, pixels: Uint8Array.from([0, 0, 1, 255, 0, 1, 0, 255, 0, 0, 0, 255, 0, 0, 9, 128]) };
    expect([...decodePaints(img, 300)]).toEqual([0, 255, NOTHING, UNDECODABLE]);
    expect([...decodePaints(img, 10)]).toEqual([0, UNDECODABLE, NOTHING, UNDECODABLE]);
    expect(() => idHex(-1)).toThrow();
  });

  it("rasterise crisp: every pixel of fills, patterns, hatches, strokes and text decodes, on the reference raster's grid", async () => {
    const fonts = await loadBundledFonts();
    const glyphOutline = glyphOutlineFrom(fonts);
    for (const name of ["colour-order", "glyph-instances", "hatch-area", "dashed-bezier-stroke", "text-with-halo"] as const) {
      const stream = render.passStreamFromJson(render.renderFixtures[name]);
      const bounds = render.passStreamBounds(stream)!;
      const ref = await rasterisePassStream(stream, { colour: () => "#000000", bounds, pxPerMm: 10, glyphOutline });
      const p = await rasterisePaints(stream, { bounds, pxPerMm: 10, glyphOutline });
      expect([p.width, p.height], name).toEqual([ref.width, ref.height]);
      expect([...p.ids].filter((v) => v === UNDECODABLE).length, name).toBe(0);
      expect([...p.ids].some((v) => v >= 0), name).toBe(true);
    }
  });

  it("name an overlap by the upper paint even where both rows share one ink", async () => {
    // Two squares of the same ink, rows 2 and 5; the right half overlaps.
    const b = new render.PassStreamBuilder();
    b.push({ kind: "fill", colour: 5, path: render.makePath([1000, 0, 3000, 0, 3000, 2000, 1000, 2000], undefined, true), rule: "evenodd" }, 0, 1);
    b.push({ kind: "fill", colour: 2, path: render.makePath([0, 0, 2000, 0, 2000, 2000, 0, 2000], undefined, true), rule: "evenodd" }, 1, 0);
    const stream = b.build();
    const bounds = { minX: 0, minY: 0, maxX: 3000, maxY: 2000 };
    const p = await rasterisePaints(stream, { bounds, pxPerMm: 1 });
    expect(p.paints.map((x) => x.row)).toEqual([2, 5]);
    expect([...p.ids.slice(0, 3)]).toEqual([0, 1, 1]); // top row: left only row 2, middle both (5 on top), right only 5
  });
});

describe("naming changes", () => {
  // Three layers; stack rows in the source and in the candidate (the candidate lifts brown50-paved over both blacks).
  const names = ["brown50-paved", "black50-building", "black100"];
  const named = (id: number) => names[id];
  const source = new Map([["brown50-paved", 0], ["black50-building", 1], ["black100", 2]]);
  const candidate = new Map([["black50-building", 0], ["black100", 1], ["brown50-paved", 2]]);
  const rowOf = { source: (n: string) => source.get(n), candidate: (n: string) => candidate.get(n) };
  const view = (src: number[], cand: number[]): PaintView => ({ source: Int32Array.from(src), candidate: Int32Array.from(cand), nameSource: named, nameCandidate: named });

  it("names a pixel by the layer on top in the source, then in the candidate", () => {
    const v = view([1, 2, 0, NOTHING, UNDECODABLE], [0, 0, 0, 1, 0]);
    expect(viewKind(v, 0)).toEqual({ from: "black50-building", to: "brown50-paved" });
    expect(viewKind(v, 1)).toEqual({ from: "black100", to: "brown50-paved" });
    expect(viewKind(v, 2)).toBeNull(); // the same layer on top in both
    expect(viewKind(v, 3)).toEqual({ from: NOTHING_NAME, to: "black50-building" });
    expect(viewKind(v, 4)).toBeNull(); // a blended value
  });

  it("names a pixel with the same layer on top by the pair around it whose order flipped", () => {
    // 3×1: a thin black100 line (centre) on top in both orders, the paved brown beside it now drawn above it.
    const v = view([0, 2, 0], [0, 2, 0]);
    expect(flipKind(v, 1, 3, 1, rowOf)).toBe(kindKey("black100", "brown50-paved"));
    // black50-building and black100 keep their order: no pair flipped
    expect(flipKind(view([1, 2, 1], [1, 2, 1]), 1, 3, 1, rowOf)).toBeUndefined();
    // the paper takes no part; a layer one stack lacks takes no part
    expect(flipKind(view([NOTHING, 2, NOTHING], [NOTHING, 2, NOTHING]), 1, 3, 1, rowOf)).toBeUndefined();
    expect(flipKind(view([0, 2, 0], [0, 2, 0]), 1, 3, 1, { source: rowOf.source, candidate: (n) => (n === "brown50-paved" ? undefined : candidate.get(n)) })).toBeUndefined();
  });

  it("finds the layer to peel where both orders have the same one on top", () => {
    const v = view([2, 0, NOTHING, UNDECODABLE], [2, 1, NOTHING, 2]);
    expect([0, 1, 2, 3].map((i) => sharedTop(v, i))).toEqual(["black100", null, null, null]);
    const graphic: PaintView = { ...v, nameSource: (id) => `graphic:${named(id)}` };
    expect(sharedTop(graphic, 0)).toBe("black100");
  });

  it("peels layers off a stream by row, keeping the per-pass arrays aligned", () => {
    const sq = render.makePath([0, 0, 1000, 0, 1000, 1000, 0, 1000], undefined, true);
    const b = new render.PassStreamBuilder();
    b.push({ kind: "fill", colour: 0, path: sq, rule: "evenodd" }, 10, 100);
    b.push({ kind: "fill", colour: 1, path: sq, rule: "evenodd" }, 11, 101);
    b.push({ kind: "fill", colour: 2, path: sq, rule: "evenodd" }, 12, 102);
    const s = { ...b.build(), maskIdx: Int32Array.from([-1, 0, -1]), masks: [{ regions: [] }] };
    const peeled = withoutRows(s, new Set([1]));
    expect(peeled.passes.map((p) => p.colour)).toEqual([0, 2]);
    expect([...peeled.objectIdx]).toEqual([10, 12]);
    expect([...peeled.symbolIdx]).toEqual([100, 102]);
    expect([...peeled.maskIdx!]).toEqual([-1, -1]);
  });

  it("peels a shared top layer off to find the change under it, one view per peel set, at most three deep", async () => {
    // 2×1: pixel 0 has black100 on top in both orders over a swap of the paved brown and the building grey;
    // pixel 1 has the same black100 on top at every depth (nothing under it changed).
    const seen: string[][] = [];
    const views: Record<string, PaintView> = {
      "": view([2, 2], [2, 2]),
      black100: view([1, 2], [0, 2]),
    };
    const k = await namePeeled(Uint8Array.from([1, 1]), 2, 1, async (peel) => {
      seen.push([...peel]);
      return views[peel.join("+")] ?? view([2, 2], [2, 2]);
    }, { source: () => undefined, candidate: () => undefined });
    expect(Object.fromEntries(k)).toEqual({ [kindKey("black50-building", "brown50-paved")]: 2 }); // pixel 1 by its neighbour
    // pixel 1 is peeled once and then has black100 on top again: peeling never repeats a layer
    expect(seen).toEqual([[], ["black100"]]);
    let calls = 0;
    const deep = await namePeeled(Uint8Array.from([1]), 1, 1, async (peel) => {
      calls++;
      const top = ["brown50-paved", "black50-building", "black100", "yellow100", "blue100-line"][peel.length];
      return { source: Int32Array.from([0]), candidate: Int32Array.from([0]), nameSource: () => top, nameCandidate: () => top };
    }, { source: () => undefined, candidate: () => undefined }, 3);
    expect(calls).toBe(4); // the full view, then three peels; a fourth is not tried
    expect(Object.fromEntries(deep)).toEqual({ [UNATTRIBUTED]: 1 });
  });

  it("names a pixel no view can tell by the supersampled view's sub-pixels, and asks for that view only then", async () => {
    // 2×1 tile: pixel 0 is told by the full view; pixel 1 shows black100 over the paper in both (a hairline under it).
    // At 2× the hairline covers sub-pixels of pixel 1: the paved brown, drawn above the building grey in the candidate.
    const coarse = view([1, 2], [0, 2]);
    const fineIds = (a: number, b: number) => Int32Array.from([1, 1, 2, a, 1, 1, 2, b]);
    let asked = 0;
    const fine = async () => {
      asked++;
      return { ...view([...fineIds(1, 1)], [...fineIds(0, 0)]), width: 4, height: 2, factor: 2 };
    };
    const k = await namePeeled(Uint8Array.from([1, 1]), 2, 1, async () => coarse, { source: () => undefined, candidate: () => undefined }, 0, fine);
    expect(Object.fromEntries(k)).toEqual({ [kindKey("black50-building", "brown50-paved")]: 2 });
    expect(asked).toBe(1);
    // Nothing left to name: the fine view is not drawn.
    await namePeeled(Uint8Array.from([1, 0]), 2, 1, async () => coarse, { source: () => undefined, candidate: () => undefined }, 0, fine);
    expect(asked).toBe(1);
    // A fine view of the wrong size is an error, not a guess.
    await expect(namePeeled(Uint8Array.from([0, 1]), 2, 1, async () => coarse, { source: () => undefined, candidate: () => undefined }, 0, async () => ({ ...coarse, width: 3, height: 2, factor: 2 }))).rejects.toThrow(/fine view/);
  });

  it("names a pixel from a fine view by the most frequent kind in its block and a one-sub-pixel margin, ties by key", () => {
    // 1×1 tile at 2×: sub-pixels (0,0) and (1,1) tell two kinds once each → the first by key.
    const v = { ...view([1, 2, 2, 0], [0, 2, 2, 2]), width: 2, height: 2, factor: 2 };
    expect(fineKindOf(v, 1, { source: () => undefined, candidate: () => undefined })(0)).toBe(kindKey("black50-building", "brown50-paved"));
  });

  it("counts every changed pixel once; one no view can tell takes its neighbours' kind, else is unattributed", () => {
    // 3×3; the centre has black100 on top in both and no flipped pair around; its named neighbours vote.
    const v = view([1, 1, 2, 2, 2, 2, 2, 2, 2], [0, 0, 0, 2, 2, 2, 2, 2, 2]);
    const mask = Uint8Array.from([1, 1, 1, 0, 1, 0, 0, 0, 0]);
    const k = nameChanges(mask, 3, 3, viewKindOf(v, 3, 3, { source: () => undefined, candidate: () => undefined }));
    expect(Object.fromEntries(k)).toEqual({ [kindKey("black50-building", "brown50-paved")]: 3, [kindKey("black100", "brown50-paved")]: 1 });
    expect(Object.fromEntries(nameChanges(Uint8Array.from([1, 0]), 2, 1, () => undefined))).toEqual({ [UNATTRIBUTED]: 1 });
    expect(() => nameChanges(Uint8Array.from([1]), 2, 1, () => undefined)).toThrow(/size/);
    expect(splitKind(kindKey("a", "b"))).toEqual(["a", "b"]);
  });
});

// A small document: colour table, symbols, objects per symbol. No geometry.
const colour = (name: string, cmyk: [number, number, number, number], extra: Partial<mapDocument.DocumentColour> = {}): mapDocument.DocumentColour =>
  ({ id: `src:${name}`, name, cmyk, ...extra }) as mapDocument.DocumentColour;
const area = (id: string, fill: number) => render.parseRenderSymbol({ type: "area", id, code: id, name: id, fill });
const line = (id: string, c: number) => render.parseRenderSymbol({ type: "line", id, code: id, name: id, main: { colour: c, widthUm: 200 } });

function fixture() {
  const colours = [
    colour("Black", [0, 0, 0, 1], { sourceNumber: 0, paletteIds: ["black100", "black-cultivated"] }),
    colour("Brown 50%", [0, 0.28, 0.5, 0], { sourceNumber: 1, paletteIds: ["brown50-paved"] }),
    colour("Mask", [0, 0, 0, 0], { sourceNumber: 2 }),
    colour("Yellow", [0, 0.27, 0.79, 0], { sourceNumber: 3, paletteIds: ["yellow100"] }),
    colour("Logo red", [0, 1, 1, 0], { sourceNumber: 4 }),
    colour("Purple", [0.35, 0.85, 0, 0], { paletteIds: ["purple-upper"], purpleRole: "upper" }),
    colour("Purple lower", [0.35, 0.85, 0, 0], { paletteIds: ["purple-lower"], purpleRole: "lower" }),
  ];
  const docSymbols: (Pick<mapDocument.DocumentSymbol, "kind" | "hidden" | "origin" | "match">)[] = [
    { kind: "area", hidden: false, origin: "source", match: { canonicalId: "ISOM2017-2:401", method: "explicit", state: "auto", confidence: 1, reasons: [], reviewed: false, libraryVersion: "x" } },
    { kind: "line", hidden: false, origin: "source", match: { canonicalId: null, method: "none", state: "unmatched", confidence: 0, reasons: [], reviewed: false, libraryVersion: "x" } },
    { kind: "area", hidden: false, origin: "source" },
    { kind: "area", hidden: false, origin: "graphic" },
    { kind: "line", hidden: true, origin: "source" },
  ];
  const symbols = [area("a", 3), line("b", 0), area("c", 2), area("d", 4), line("e", 1)];
  const perSymbol = [10, 4, 2, 1, 50];
  return { colours, docSymbols, symbols, perSymbol };
}

describe("stack layers", () => {
  it("read roles, uses, the dominant kind and the colour class per row, and name them uniquely", () => {
    const f = fixture();
    const layers = stackLayers(f.colours, f.docSymbols, f.symbols, f.perSymbol, [undefined, "brown50-road", undefined, undefined, undefined, undefined, undefined], rank);
    expect(layers.map((l) => l.name)).toEqual(["black-cultivated+black100", "brown50-paved+brown50-road", "none:white:area", "yellow100", "none:red:area", "purple-upper", "purple-lower"]);
    expect(layers.map((l) => l.uses)).toEqual([4, 0, 2, 10, 1, 0, 0]); // the hidden symbol draws nothing
    expect(layers[1].kind).toBe("none");
    expect(nameLayers([{ roles: ["black100"], kind: "line", colourClass: "black", name: "" }, { roles: ["black100"], kind: "area", colourClass: "black", name: "" }]).map((l) => l.name)).toEqual(["black100", "black100#2"]);
  });

  it("prefix a graphic object's paint with graphic:", () => {
    const f = fixture();
    const layers = stackLayers(f.colours, f.docSymbols, f.symbols, f.perSymbol, [], rank);
    const name = paintNamer([{ row: 4, kind: "fill", symbolIdx: 3 }, { row: 3, kind: "fill", symbolIdx: 0 }], layers, f.docSymbols);
    expect([name(0), name(1)]).toEqual([`${GRAPHIC_PREFIX}none:red:area`, "yellow100"]);
  });
});

describe("the permutation candidate", () => {
  it("orders rows by their highest role's palette place, roleless areas under lower purple, other roleless rows under upper purple", () => {
    const f = fixture();
    const layers = stackLayers(f.colours, f.docSymbols, f.symbols, f.perSymbol, [], rank);
    const order = permutationOrder(layers, rank);
    const names = order.map((i) => layers[i].name);
    expect(names).toEqual(["yellow100", "brown50-paved", "none:white:area", "none:red:area", "purple-lower", "black-cultivated+black100", "purple-upper"]);
    // the experiment's rule: equal keys keep the stack order (the mask before the logo)
    expect(names.indexOf("none:white:area")).toBeLessThan(names.indexOf("none:red:area"));
  });

  it("re-indexes every source symbol and keeps the colours with the rows", () => {
    const f = fixture();
    const doc = { header: { colours: f.colours, symbols: f.symbols.map((r, i) => ({ ...f.docSymbols[i], code: `${i}`, name: `${i}`, render: r })) } } as unknown as Pick<mapDocument.MapDocument, "header">;
    const order = [3, 1, 2, 4, 6, 0, 5];
    const p = permuteStack(doc, order);
    expect(p.header.colours.map((c) => c.name)).toEqual(order.map((i) => f.colours[i].name));
    const inv = inverseOrder(order);
    p.header.symbols.forEach((s, i) => {
      expect(render.renderColourRefs(s.render!)).toEqual(render.renderColourRefs(f.symbols[i]).map((c) => inv[c]).sort((a, b) => a - b));
      expect(p.header.colours[render.renderColourRefs(s.render!)[0]]).toBe(f.colours[render.renderColourRefs(f.symbols[i])[0]]);
    });
    expect(() => inverseOrder([0, 0, 1])).toThrow(/permutation/);
    // objects without IR are drawn by the bridge's proxies in row 0: the candidate's take the row it moved to
    expect(permutedRenderOptions(order)).toEqual({ proxyColours: { line: 5, area: 5, point: 5, text: 5 } });
  });
});

describe("the permutation keeps proxy-drawn objects' colour", () => {
  it("draws an object whose symbol has no IR in the same colour in both orders", () => {
    const header: mapDocument.MapDocumentInput["header"] = {
      format: { version: 1, importer: "test-1" },
      source: { kind: "ocad", version: "2018.8.3", hash: "00".repeat(32), bytes: 1 },
      unitsPerMm: 100,
      mapScale: 15000,
      georeferencing: { crs: null, paperOrigin: { x: 0, y: 0 }, gridRotationDeg: 0 },
      colours: [
        { id: "src:0", name: "Black", cmyk: [0, 0, 0, 1], sourceNumber: 0 },
        { id: "src:1", name: "Yellow", cmyk: [0, 0.27, 0.79, 0], sourceNumber: 1, paletteIds: ["yellow100"] },
      ],
      symbols: [
        { code: "graphic", name: "Frame bar", kind: "area", origin: "graphic", render: null },
        { code: "401", name: "Open land", kind: "area", render: { type: "area", id: "s:401", code: "401", name: "Open land", fill: 1 } },
      ],
    };
    const ring = [0, 0, 1000, 0, 1000, 1000, 0, 1000, 0, 0];
    const doc = mapDocument.decodeMapDocument(mapDocument.encodeMapDocument({
      header,
      objects: [0, 1].map((symbolIdx) => ({ symbolIdx, type: mapDocument.OBJECT_TYPE.area, sourceIndex: symbolIdx, coords: ring, flags: new Array(5).fill(0) })),
    }));
    const order = [1, 0]; // the black moves on top: row 0 becomes row 1
    const inks = (d: mapDocument.MapDocument, opts: mapDocument.DocumentRenderOptions = {}) => {
      const input = mapDocument.documentRenderInput(d, opts);
      const { stream } = render.symbolise({ objects: input.objects, symbols: input.symbols, fonts: [] });
      return stream.passes.map((p, i) => [input.symbols[stream.symbolIdx[i]].code, d.header.colours[p.colour].name]).sort();
    };
    const source = inks(doc);
    expect(source).toEqual([["401", "Yellow"], ["proxy-area", "Black"]]);
    const permuted = permuteStack(doc, order);
    expect(inks(permuted, permutedRenderOptions(order))).toEqual(source);
    expect(inks(permuted)).not.toEqual(source); // without the options the proxy takes the yellow now at row 0
  });
});

describe("colourCensus", () => {
  it("counts used rows, rows without a palette entry, multi-role rows and symbols by match state", () => {
    const f = fixture();
    const layers = stackLayers(f.colours, f.docSymbols, f.symbols, f.perSymbol, [], rank);
    const doc = { header: { colours: f.colours, symbols: f.docSymbols, objects: { count: 67 } } } as unknown as Pick<mapDocument.MapDocument, "header">;
    expect(colourCensus(doc, layers, f.perSymbol)).toEqual({
      objects: 67,
      colours: 7,
      used: 4,
      unidentified: 2,
      uses: 17,
      unidentifiedUses: 3,
      multi: [{ row: 0, roles: ["black-cultivated", "black100"], uses: 4 }],
      symbols: { used: 5, auto: 1, suggested: 0, unmatched: 1, none: 3, reviewed: 0, graphic: 1 },
      lowerAt: 6,
      upperAt: 5,
    });
  });
});

describe("classification", () => {
  const kinds = new Map([
    [kindKey("black50-building", "brown50-paved"), 50],
    [kindKey("graphic:none:red:area", "yellow100"), 30],
    [kindKey("none:white:area", "blue100-line"), 15],
    [UNATTRIBUTED, 5],
  ]);

  it("takes the first matching rule in file order, scoped to a map or not, with * wildcards", () => {
    const c = parseClassification({
      version: 1,
      rules: [
        { map: "other", from: "*", to: "*", class: "layout" },
        { from: "black50-building", to: "brown50-paved", class: "multi-role", note: "one brown, two roles" },
        { map: "sprint", from: "graphic:none:red:area", to: "*", class: "layout" },
        { from: "black50-building", to: "*", class: "deviation-dropped" },
        { from: "nothing-like-this", to: "*", class: "mask" },
      ],
    });
    const r = classify(kinds, c, "sprint");
    expect(r.kinds.map((k) => [k.from, k.to, k.class, k.rule])).toEqual([
      ["black50-building", "brown50-paved", "multi-role", 1],
      ["graphic:none:red:area", "yellow100", "layout", 2],
      ["none:white:area", "blue100-line", "unclassified", undefined],
      [UNATTRIBUTED, UNATTRIBUTED, "unclassified", undefined],
    ]);
    expect(r).toMatchObject({ changed: 100, unclassified: 20, unclassifiedShare: 0.2, unusedRules: [3, 4] });
    expect(r.byClass).toMatchObject({ "multi-role": 50, layout: 30, unclassified: 20, mask: 0 });
  });

  it("matches a prefix ending in * (every graphic object's paint)", () => {
    expect(namePatternMatches("graphic:*", "graphic:none:red:area")).toBe(true);
    expect(namePatternMatches("graphic:*", "none:red:area")).toBe(false);
    expect(namePatternMatches("brown50-road", "brown50-road#3")).toBe(false);
    const c = parseClassification({ version: 1, rules: [{ from: "*", to: "graphic:*", class: "layout" }, { from: "graphic:*", to: "*", class: "layout" }] });
    expect(classify(kinds, c, "sprint").byClass).toMatchObject({ layout: 30, unclassified: 70 });
  });

  it("never classifies unattributed or unnamed pixels, even under a catch-all rule", () => {
    const c = parseClassification({ version: 1, rules: [{ from: "*", to: "*", class: "no-role" }] });
    const r = classify(new Map([[UNATTRIBUTED, 3], [kindKey(UNATTRIBUTED, "x"), 2], [kindKey("a", "b"), 5]]), c, "m");
    expect(r.byClass).toMatchObject({ "no-role": 5, unclassified: 5 });
    expect(classify(new Map(), c, "m").unclassifiedShare).toBe(0);
  });

  it("rejects an unknown class or a malformed file, naming the rule", () => {
    expect(() => parseClassification({ version: 1, rules: [{ from: "a", to: "b", class: "layout" }, { from: "a", to: "b", class: "pretty" }] })).toThrow(/rule 1/);
    expect(() => parseClassification({ rules: [] })).toThrow(/classification/);
  });

  it("classifies unattributed pixels only as residue, by a rule naming the map and a cap", () => {
    const c = parseClassification({ version: 1, rules: [{ map: "m", from: UNATTRIBUTED, to: UNATTRIBUTED, class: "residue", maxPx: 3, note: "isolated sub-pixel changes" }] });
    expect(classify(new Map([[UNATTRIBUTED, 3]]), c, "m").byClass).toMatchObject({ residue: 3, unclassified: 0 });
    // over the cap, or on another map: unclassified
    expect(classify(new Map([[UNATTRIBUTED, 4]]), c, "m").byClass).toMatchObject({ residue: 0, unclassified: 4 });
    expect(classify(new Map([[UNATTRIBUTED, 1]]), c, "n").byClass).toMatchObject({ unclassified: 1 });
    // a residue rule never classifies a named kind
    expect(classify(new Map([[kindKey("a", "b"), 1]]), c, "m").byClass).toMatchObject({ unclassified: 1 });
    expect(() => parseClassification({ version: 1, rules: [{ from: "*", to: "*", class: "residue", map: "m", maxPx: 9 }] })).toThrow(/residue rule names \(unattributed\)/);
    expect(() => parseClassification({ version: 1, rules: [{ from: UNATTRIBUTED, to: UNATTRIBUTED, class: "residue", maxPx: 9 }] })).toThrow(/map and maxPx/);
    expect(() => parseClassification({ version: 1, rules: [{ map: "m", from: UNATTRIBUTED, to: UNATTRIBUTED, class: "residue" }] })).toThrow(/map and maxPx/);
  });

  it("matches a rule with maxPx only on a kind within it", () => {
    const c = parseClassification({ version: 1, rules: [{ from: "black50-building", to: "*", class: "deviation-dropped", maxPx: 49 }, { from: "black50-building", to: "*", class: "multi-role" }] });
    expect(classify(kinds, c, "sprint").byClass).toMatchObject({ "multi-role": 50, "deviation-dropped": 0 });
  });

  it("matches a reported rule only where the candidate's report gives the kind that class", () => {
    // Layers: a dropped deviation's two rows, a pair of rows the report lists as nothing, a mask and a graphic row.
    const layers = ["brown50-road", "brown100-line", "blue100-area", "white-over-green-brown", "none:black:line"].map((name, row) => ({ name, row }));
    const rows = [
      { row: 0, source: 5, role: "brown50-road", sourceOrdered: null },
      { row: 1, source: 2, role: "brown100-line", sourceOrdered: null },
      { row: 2, source: 1, role: "blue100-area", sourceOrdered: null },
      { row: 3, source: 9, role: "white-over-green-brown", sourceOrdered: "mask" },
      { row: 4, source: 3, role: null, sourceOrdered: "graphic" },
    ] as unknown as mapImport.ColourLayersReport["rows"];
    const deviations = [
      { upper: "brown50-road", lower: "brown100-line", kept: false, byDefault: false, objects: { upper: 1, lower: 1 } },
      { upper: "brown100-line", lower: "blue100-area", kept: true, byDefault: true, objects: { upper: 1, lower: 1 } },
    ];
    const reported = reportedClasses(layers, { rows, deviations });
    expect([...reported("brown50-road", "brown100-line")]).toEqual(["deviation-dropped"]);
    // the other way round the source has them in the palette's order: not the deviation
    expect([...reported("brown100-line", "brown50-road")]).toEqual([]);
    // a kept deviation is no dropped one
    expect([...reported("brown100-line", "blue100-area")]).toEqual([]);
    expect([...reported("white-over-green-brown", "brown100-line")]).toEqual(["mask"]);
    expect([...reported("graphic:none:black:line", "blue100-area")]).toEqual(["layout"]);
    expect([...reported("no-such-layer", "blue100-area")]).toEqual([]);
    const c = parseClassification({ version: 1, rules: [{ from: "*", to: "*", class: "mask", reported: true }, { from: "*", to: "*", class: "deviation-dropped", reported: true }] });
    const r = classify(new Map([[kindKey("brown50-road", "brown100-line"), 4], [kindKey("brown100-line", "brown50-road"), 2], [kindKey("white-over-green-brown", "blue100-area"), 1]]), c, "m", reported);
    expect(r.byClass).toMatchObject({ "deviation-dropped": 4, mask: 1, unclassified: 2 });
    // without a report, no reported rule matches
    expect(classify(new Map([[kindKey("brown50-road", "brown100-line"), 4]]), c, "m").byClass).toMatchObject({ unclassified: 4 });
  });

  it("suggests a class from the two layers, as a hint", () => {
    const f = fixture();
    const layers = stackLayers(f.colours, f.docSymbols, f.symbols, f.perSymbol, [], rank);
    const byName = new Map<string, StackLayer>(layers.map((l) => [l.name, l]));
    const fake = (name: string, roles: string[], colourClass = "x"): StackLayer => ({ row: -1, roles, uses: 1, kind: "area", colourClass, name });
    for (const l of [fake("black50-building", ["black50-building"]), fake("brown50-paved", ["brown50-paved"]), fake("brown100-line", ["brown100-line"])]) byName.set(l.name, l);
    const of = (n: string) => byName.get(n);
    expect(suggestClass("graphic:none:red:area", "yellow100", of, rank)).toBe("layout");
    expect(suggestClass("black-cultivated+black100", "yellow100", of, rank)).toBe("multi-role");
    expect(suggestClass("none:white:area", "yellow100", of, rank)).toBe("mask");
    expect(suggestClass("none:red:area", "yellow100", of, rank)).toBe("no-role");
    // the source drew the paved brown over the contour brown; the palette puts the contour above
    expect(suggestClass("brown50-paved", "brown100-line", of, rank)).toBe("deviation-dropped");
    expect(suggestClass("brown100-line", "brown50-paved", of, rank)).toBeNull();
    expect(suggestClass("nope", "yellow100", of, rank)).toBeNull();
  });
});

/**
 * A stage 7 document (source order) whose one brown 50 % serves a paved
 * area and a road's infill: black, brown, then the two inserted purples; a
 * graphic object without IR (drawn by the proxies in row 0).
 */
function alignedDoc(): mapDocument.MapDocument {
  const header: mapDocument.MapDocumentInput["header"] = {
    format: { version: 1, importer: "test-1" },
    source: { kind: "ocad", version: "2018.8.3", hash: "00".repeat(32), bytes: 1 },
    unitsPerMm: 100,
    mapScale: 15000,
    georeferencing: { crs: null, paperOrigin: { x: 0, y: 0 }, gridRotationDeg: 0 },
    colours: [
      { id: "src:7", name: "Black", cmyk: [0, 0, 0, 1], sourceNumber: 7, paletteIds: ["black100"] },
      { id: "src:8", name: "Brown 50%", cmyk: [0, 0.28, 0.5, 0], sourceNumber: 8, paletteIds: ["brown50-paved"] },
      { id: "iof2022:purple-lower", name: "Purple", cmyk: [0.35, 0.85, 0, 0], paletteIds: ["purple-lower"], purpleRole: "lower" },
      { id: "iof2022:purple-upper", name: "Purple", cmyk: [0.35, 0.85, 0, 0], paletteIds: ["purple-upper"], purpleRole: "upper" },
    ],
    symbols: [
      { code: "501", name: "Paved", kind: "area", render: { type: "area", id: "s:501", code: "501", name: "Paved", fill: 1 } },
      {
        code: "503", name: "Road", kind: "line",
        render: { type: "line", id: "s:503", code: "503", name: "Road", borders: { left: { colour: 0, widthUm: 140, shiftUm: 290 }, right: { colour: 0, widthUm: 140, shiftUm: 290 }, backgroundColour: 1 } },
      },
      { code: "graphic", name: "Frame bar", kind: "area", origin: "graphic", render: null },
    ],
  };
  const ring = [0, 0, 1000, 0, 1000, 1000, 0, 1000, 0, 0];
  return mapDocument.decodeMapDocument(mapDocument.encodeMapDocument({
    header,
    objects: [
      { symbolIdx: 0, type: mapDocument.OBJECT_TYPE.area, sourceIndex: 0, coords: ring, flags: new Array(5).fill(0) },
      { symbolIdx: 1, type: mapDocument.OBJECT_TYPE.line, sourceIndex: 1, coords: [0, 500, 1000, 500], flags: [0, 0] },
      { symbolIdx: 2, type: mapDocument.OBJECT_TYPE.area, sourceIndex: 2, coords: ring, flags: new Array(5).fill(0) },
    ],
  }));
}

const rank22 = paletteRank("iof2022", "ISOM2017-2");
const streamOfDoc = (d: mapDocument.MapDocument, opts: mapDocument.DocumentRenderOptions = {}) => {
  const input = mapDocument.documentRenderInput(d, opts);
  return render.symbolise({ objects: input.objects, symbols: input.symbols, fonts: [] }).stream;
};

describe("the layered candidate", () => {
  it("recovers the source table from a stage 7 stack", () => {
    const t = sourceTableOf(alignedDoc().header.colours);
    expect(t.fromAligned).toEqual([0, 1, -1, -1]);
    expect(t.colours.map((c) => c.id)).toEqual(["src:7", "src:8"]);
    expect(t.colours.every((c) => c.paletteIds === undefined && c.purpleRole === undefined)).toBe(true);
  });

  it("splits the brown into the paved area and the road infill, re-indexes the road per reference and names one role per layer", () => {
    const doc = alignedDoc();
    const lc = layeredCandidate(doc, "ISOM2017-2", objectsPerSymbol(doc), rank22);
    expect(lc.layers.report.split).toContainEqual({ source: 1, sourceNumber: 8, roles: ["brown50-paved", "brown50-road"] });
    const names = lc.stackLayers.map((l) => l.name);
    for (const n of ["brown50-paved", "black-road-outline", "brown50-road", "purple-lower", "purple-upper"]) expect(names).toContain(n);
    expect(names.some((n) => n.includes("+"))).toBe(false);
    const row = (n: string) => names.indexOf(n);
    const road = lc.doc.header.symbols[1].render!;
    expect(render.renderColourPaths(road).map((r) => r.colour)).toEqual([row("black-road-outline"), row("black-road-outline"), row("brown50-road")]);
    expect(render.renderColourRefs(lc.doc.header.symbols[0].render!)).toEqual([row("brown50-paved")]);
    // the source's row 0 (the black) became its lowest row: the proxies draw there
    expect(lc.rowOfAligned).toEqual([row("black-road-outline"), row("brown50-paved"), row("purple-lower"), row("purple-upper")]);
    const at = row("black-road-outline");
    expect(lc.renderOptions.proxyColours).toEqual({ line: at, area: at, point: at, text: at });
  });

  it("draws every object in the same ink in both orders (the proxy-drawn graphic object included)", () => {
    const doc = alignedDoc();
    const lc = layeredCandidate(doc, "ISOM2017-2", objectsPerSymbol(doc), rank22);
    const inks = (d: mapDocument.MapDocument, opts: mapDocument.DocumentRenderOptions = {}) => {
      const s = streamOfDoc(d, opts);
      return s.passes.map((p, i) => `${s.symbolIdx[i]}:${p.kind}:${d.header.colours[p.colour].cmyk.join(",")}`).sort();
    };
    expect(inks(lc.doc, lc.renderOptions)).toEqual(inks(doc));
    expect(inks(lc.doc)).not.toEqual(inks(doc)); // without the options the proxy takes whatever is row 0 now
  });

  it("rejects a document whose source symbols draw in an inserted row", () => {
    const doc = alignedDoc();
    const bad = { ...doc, header: { ...doc.header, symbols: [{ ...doc.header.symbols[0], render: render.parseRenderSymbol({ type: "area", id: "x", code: "x", name: "x", fill: 2 }) }, ...doc.header.symbols.slice(1)] } };
    expect(() => layeredCandidate(bad, "ISOM2017-2", objectsPerSymbol(doc), rank22)).toThrow(/inserted row/);
  });

  it("pairs each pass with its row in either order (jointDocument, paintCorrespondence)", () => {
    const doc = alignedDoc();
    const lc = layeredCandidate(doc, "ISOM2017-2", objectsPerSymbol(doc), rank22);
    const joint = jointDocument(doc, lc.doc, { source: 0, candidate: lc.renderOptions.proxyColours!.line! });
    const p = joint.proxy;
    const corr = paintCorrespondence(streamOfDoc(joint.doc, { proxyColours: { line: p, area: p, point: p, text: p } }), joint.pairs);
    const names = lc.stackLayers.map((l) => l.name);
    const source = streamOfDoc(doc);
    // the brown's paints: the paved row for the area, the road row for the road
    const brown = source.passes.flatMap((x, i) => (x.colour === 1 ? [{ key: paintKey(1, x.kind, source.symbolIdx[i]), sym: source.symbolIdx[i] }] : []));
    expect(new Set(brown.map((b) => b.sym))).toEqual(new Set([0, 1]));
    for (const b of brown) expect(names[corr.candidateRow.get(b.key)!]).toBe(b.sym === 0 ? "brown50-paved" : "brown50-road");
    expect(corr.sourceRow.get(names.indexOf("brown50-road"))).toBe(1);
    expect(corr.sourceRow.get(names.indexOf("black-road-outline"))).toBe(0);
    expect(() => jointDocument(doc, { header: { ...lc.doc.header, symbols: [] } }, { source: 0, candidate: 0 })).toThrow(/symbol tables/);
  });

  it("names a source paint by the candidate layer it becomes, graphic: for a graphic object's", () => {
    const doc = alignedDoc();
    const lc = layeredCandidate(doc, "ISOM2017-2", objectsPerSymbol(doc), rank22);
    const names = lc.stackLayers.map((l) => l.name);
    const candidateRow = new Map([[paintKey(1, "fill", 0), names.indexOf("brown50-paved")], [paintKey(1, "fill", 1), names.indexOf("brown50-road")]]);
    const paints = [{ row: 1, kind: "fill" as const, symbolIdx: 0 }, { row: 1, kind: "fill" as const, symbolIdx: 1 }, { row: 0, kind: "fill" as const, symbolIdx: 2 }];
    const name = correspondingNamer(paints, candidateRow, lc.stackLayers, doc.header.symbols, (r) => lc.rowOfAligned[r]);
    expect([name(0), name(1), name(2)]).toEqual(["brown50-paved", "brown50-road", `${GRAPHIC_PREFIX}black-road-outline`]);
  });

  it("peels passes by what draws them (withoutPasses)", () => {
    const s = streamOfDoc(alignedDoc());
    const kept = withoutPasses(s, (_, symbolIdx) => symbolIdx === 1);
    expect(kept.passes.length).toBe(s.passes.length - [...s.symbolIdx].filter((x) => x === 1).length);
    expect([...kept.symbolIdx].includes(1)).toBe(false);
    expect(kept.objectIdx.length).toBe(kept.passes.length);
  });
});
