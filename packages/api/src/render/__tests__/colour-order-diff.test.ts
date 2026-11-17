import { describe, expect, it } from "vitest";
import { render, type mapDocument } from "@oxygen/shared";
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
  rankTiles,
  rasterisePaints,
  sideBySide,
  splitKind,
  stackLayers,
  suggestClass,
  tileGrid,
  UNATTRIBUTED,
  UNDECODABLE,
  UNNAMED,
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

describe("nameChanges", () => {
  const names = ["brown50-paved", "black50-building", "black100"];
  const named = (id: number) => names[id];

  it("names each changed pixel by the source's and the candidate's top layer", () => {
    const mask = Uint8Array.from([1, 1, 0, 1]);
    const src = Int32Array.from([1, 2, 0, NOTHING]);
    const cand = Int32Array.from([0, 0, 1, NOTHING]);
    const k = nameChanges(mask, 4, 1, src, cand, named, named);
    expect(Object.fromEntries(k)).toEqual({ [kindKey("black50-building", "brown50-paved")]: 1, [kindKey("black100", "brown50-paved")]: 1, [UNATTRIBUTED]: 1 });
  });

  it("gives a fringe pixel (same layer on top in both, or undecodable) the majority kind of its changed neighbours", () => {
    // 3×3; centre is fringe; two neighbours say A → B, one says C → B.
    const mask = Uint8Array.from([1, 1, 1, 0, 1, 0, 0, 0, 0]);
    const src = Int32Array.from([1, 1, 2, 0, 0, 0, 0, 0, 0]);
    const cand = Int32Array.from([0, 0, 0, 0, 0, 0, 0, 0, 0]);
    const k = nameChanges(mask, 3, 3, src, cand, named, named);
    expect(Object.fromEntries(k)).toEqual({ [kindKey("black50-building", "brown50-paved")]: 3, [kindKey("black100", "brown50-paved")]: 1 });
    const lone = nameChanges(Uint8Array.from([1]), 1, 1, Int32Array.from([UNDECODABLE]), Int32Array.from([0]), named, named);
    expect(Object.fromEntries(lone)).toEqual({ [UNATTRIBUTED]: 1 });
  });

  it("counts sum to the changed pixels; the paper is named", () => {
    const mask = Uint8Array.from([1, 1, 1]);
    const k = nameChanges(mask, 3, 1, Int32Array.from([NOTHING, 0, 0]), Int32Array.from([1, 0, NOTHING]), named, named);
    expect([...k.values()].reduce((a, b) => a + b, 0)).toBe(3);
    // the middle pixel is fringe (row 0 on top in both); its two neighbours tie and the first kind in key order wins
    expect(Object.fromEntries(k)).toEqual({ [kindKey(NOTHING_NAME, "black50-building")]: 2, [kindKey("brown50-paved", NOTHING_NAME)]: 1 });
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

  it("never classifies unattributed or unnamed pixels, even under a catch-all rule", () => {
    const c = parseClassification({ version: 1, rules: [{ from: "*", to: "*", class: "no-role" }] });
    const r = classify(new Map([[UNATTRIBUTED, 3], [kindKey(UNNAMED, "x"), 2], [kindKey("a", "b"), 5]]), c, "m");
    expect(r.byClass).toMatchObject({ "no-role": 5, unclassified: 5 });
    expect(classify(new Map(), c, "m").unclassifiedShare).toBe(0);
  });

  it("rejects an unknown class or a malformed file, naming the rule", () => {
    expect(() => parseClassification({ version: 1, rules: [{ from: "a", to: "b", class: "layout" }, { from: "a", to: "b", class: "pretty" }] })).toThrow(/rule 1/);
    expect(() => parseClassification({ rules: [] })).toThrow(/classification/);
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
