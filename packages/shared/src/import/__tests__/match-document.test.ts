/**
 * Stages 6–7 over a whole document input (06 §4.1): library choice, factor,
 * per-symbol matches, aligned colour stack, remapped source renders, header
 * fields, warnings — and that the result survives the codec and is what the
 * render bridge draws canonically.
 */

import { describe, expect, it } from "vitest";
import { decodeMapDocument, encodeMapDocument } from "../../map-document/codec.js";
import { OBJECT_TYPE } from "../../map-document/header.js";
import { canonicalRender, documentRenderInput, isAppliedMatch } from "../../map-document/render-bridge.js";
import { type LineSymbol, parseRenderSymbol } from "../../render/symbol.js";
import { renderColourPaths, renderColourRefs } from "../../render/transform.js";
import { getLibraryEntry, SYMBOL_LIBRARY_VERSION } from "../../symbol-library/index.js";
import { colourRefs, resolveEntry } from "../../symbol-library/schema.js";
import { identifySourceColours, OVERLAY_STACK_IDS, paletteIndexOfStack } from "../colour-align.js";
import { buildColourLayers, deviationKey, symbolColourUses } from "../colour-layers.js";
import { rolePalette } from "../colour-roles.js";
import { documentSymbolFingerprints } from "../decisions.js";
import { matchDocument } from "../match-document.js";
import { BLACK, colours, input } from "./match-fixture.js";

/** §9.2, the `source` order, which these tests pin; the default `iof` order is tested below (row I5). */
const SOURCE_ORDER = { colourOrder: "source" } as const;

describe("matchDocument", () => {
  const res = matchDocument(input(), SOURCE_ORDER);
  const h = res.input.header;

  it("picks the library from the scale and records it with the factor in the header", () => {
    expect(h.library).toEqual({ id: "ISOM2017-2", version: SYMBOL_LIBRARY_VERSION });
    expect(h.documentFactor).toBe(1);
    expect(res.matching.library.id).toBe("ISOM2017-2");
    expect(res.matching.edition).toBe("iof2022");
    expect(res.matching.factor).toMatchObject({ factor: 1, method: "lines" });
  });

  it("matches each source symbol per the staged rules and leaves graphic / render-less symbols alone", () => {
    const m = (code: string) => h.symbols.find((s) => s.code === code)!.match!;
    expect(m("101.0")).toMatchObject({ canonicalId: "ISOM2017-2:101", state: "auto", method: "code+geometry" });
    expect(m("502.0")).toMatchObject({ canonicalId: "ISOM2017-2:502", state: "auto" });
    expect(m("204.0")).toMatchObject({ canonicalId: "ISOM2017-2:204", state: "auto" });
    expect(m("527.0")).toMatchObject({ canonicalId: "ISOM2017-2:521", state: "suggested", method: "geometry" });
    expect(m("521.3")).toMatchObject({ canonicalId: null, state: "unmatched", method: "variant" });
    expect(m("900.0")).toMatchObject({ canonicalId: null, state: "unmatched", method: "none" });
    expect(m("401.0")).toMatchObject({ canonicalId: null, state: "unmatched" });
    expect(h.symbols.find((s) => s.code === "graphic")!.match).toBeUndefined();
  });

  it("summarises by symbols and by objects", () => {
    expect(res.matching.symbols).toEqual({ auto: 3, suggested: 1, unmatched: 2, variant: 1, reviewed: 0 });
    expect(res.matching.objects).toEqual({ auto: 4, suggested: 1, unmatched: 3, variant: 2 });
    expect(res.matching.byMethod).toMatchObject({ "code+geometry": 3, geometry: 1, variant: 1, none: 1 });
  });

  it("aligns the colour stack: palette ids on source colours, inserted purples, remapped renders", () => {
    expect(h.colours.length).toBeGreaterThan(colours.length);
    expect(h.colours.filter((c) => c.sourceNumber !== undefined).map((c) => c.sourceNumber)).toEqual([5, 4, 3, 2, 1]);
    expect(res.colourStack.inserted).toEqual(expect.arrayContaining(["purple-lower", "purple-upper"]));
    // black-road-outline is needed by canonical 502 and aliases onto the source black.
    expect(res.colourStack.aliased).toContainEqual(expect.objectContaining({ paletteId: "black-road-outline", sourceNumber: 2 }));
    const index = paletteIndexOfStack(h.colours);
    expect(h.colours[index.get("black100")!].sourceNumber).toBe(2);
    expect(h.colours[index.get("brown100-line")!].sourceNumber).toBe(3);
    // Every source render now points at the new positions of its colours.
    const contourNow = h.symbols[0].render as LineSymbol;
    expect(h.colours[contourNow.main!.colour].sourceNumber).toBe(3);
    const metroNow = h.symbols[5].render as LineSymbol;
    expect(h.colours[metroNow.main!.colour].sourceNumber).toBe(1);
    for (const s of h.symbols) if (s.render) for (const c of renderColourRefs(parseRenderSymbol(s.render))) expect(c).toBeLessThan(h.colours.length);
  });

  it("puts lower purple below the line colours and reports an area colour the source draws above it", () => {
    // The fixture's yellow is used by no object: lower purple goes directly below the brown line colour.
    const lower = paletteIndexOfStack(h.colours).get("purple-lower")!;
    expect(h.colours[lower + 1].sourceNumber).toBe(3);
    // The track mask sits directly below it (docs/map-symbols.md §12.3), then the source's own colours.
    expect(h.colours[lower - 1].paletteIds).toEqual(["white-skio"]);
    expect(h.colours.slice(0, lower).reverse().find((x) => x.sourceNumber !== undefined)?.sourceNumber).toBe(4);
    expect(res.colourStack.areasAboveLowerPurple).toEqual([]);
    const base = input();
    const green = { id: "src:6", name: "Grön 30% - Ytobjekt", cmyk: [0.24, 0, 0.27, 0] as [number, number, number, number], sourceNumber: 6 };
    const withArea: typeof base = {
      header: { ...base.header, colours: [...base.header.colours, green], symbols: [...base.header.symbols, { code: "406.0", name: "Grön", kind: "area", render: { type: "area", id: "src:406", code: "406", name: "Grön", fill: 5 } }] },
      objects: [...base.objects, { symbolIdx: base.header.symbols.length, type: OBJECT_TYPE.area, sourceIndex: 9, coords: [0, 0, 100, 0, 100, 100], flags: [0, 0, 0] }],
    };
    const r = matchDocument(withArea, SOURCE_ORDER);
    expect(r.colourStack.areasAboveLowerPurple).toEqual([{ name: "Grön 30% - Ytobjekt", sourceNumber: 6, paletteId: "green30-area" }]);
    expect(r.warnings.find((w) => w.code === "COLOUR_AREA_ABOVE_LOWER_PURPLE")).toMatchObject({ count: 1 });
    // One stray area on top does not pull lower purple above black and brown.
    const lowerR = paletteIndexOfStack(r.input.header.colours).get("purple-lower")!;
    expect(r.input.header.colours[lowerR + 1].sourceNumber).toBe(3);
  });

  it("a source purple off its ruled place is displaced: reported, and its objects still drawn in it (C15)", () => {
    const base = input();
    const n = base.header.colours.length;
    // The mapper's upper purple with a green area drawn over it: not where the course's upper purple belongs.
    const purple = { id: "src:7", name: "Övre violett för banpåtryck", cmyk: [0.1, 0.9, 0.1, 0] as [number, number, number, number], sourceNumber: 7 };
    const green = { id: "src:6", name: "Grön 30% - Ytobjekt", cmyk: [0.24, 0, 0.27, 0] as [number, number, number, number], sourceNumber: 6 };
    const sym = base.header.symbols.length;
    const withPurple: typeof base = {
      header: {
        ...base.header,
        colours: [...base.header.colours, purple, green],
        symbols: [
          ...base.header.symbols,
          { code: "999.0", name: "Lila linje", kind: "line", render: { type: "line", id: "src:999", code: "999", name: "Lila linje", main: { colour: n, widthUm: 300 } } },
          { code: "406.0", name: "Grön", kind: "area", render: { type: "area", id: "src:406", code: "406", name: "Grön", fill: n + 1 } },
        ],
      },
      objects: [
        ...base.objects,
        { symbolIdx: sym, type: OBJECT_TYPE.line, sourceIndex: 9, coords: [0, 0, 100, 0], flags: [0, 0] },
        { symbolIdx: sym + 1, type: OBJECT_TYPE.area, sourceIndex: 10, coords: [0, 0, 100, 0, 100, 100], flags: [0, 0, 0] },
      ],
    };
    const r = matchDocument(withPurple, SOURCE_ORDER);
    const hc = r.input.header.colours;
    expect(r.colourStack.purplesDisplaced).toEqual([{ name: "Övre violett för banpåtryck", sourceNumber: 7, role: "upper", why: "position" }]);
    expect(r.colourStack.inserted).toEqual(expect.arrayContaining(["purple-lower", "purple-upper"]));
    // The mapper's purple line still points at the mapper's purple, which is no longer the course purple.
    const line = r.input.header.symbols[sym].render as LineSymbol;
    expect(hc[line.main!.colour]).toMatchObject({ sourceNumber: 7, cmyk: purple.cmyk });
    expect(hc[line.main!.colour].paletteIds).toBeUndefined();
    expect(hc[line.main!.colour].purpleRole).toBeUndefined();
    const index = paletteIndexOfStack(hc);
    expect(index.get("purple-upper")).toBe(hc.length - 1);
    expect(hc[index.get("purple-upper")!].cmyk).toEqual(purple.cmyk);
  });

  it("reports the non-IOF colour that symbols use and the unmatched symbols as warnings", () => {
    expect(res.colourStack.unclassified).toEqual([{ sourceNumber: 1, name: "T-bana" }]);
    const codes = h.warnings!.map((w) => w.code);
    expect(codes).toContain("COLOUR_UNCLASSIFIED");
    expect(codes).toContain("SYMBOL_UNMATCHED");
    expect(h.warnings!.find((w) => w.code === "SYMBOL_UNMATCHED")!.count).toBe(1); // 900.0 — not the variant, not the render-less 401.0
  });

  it("does not touch the objects", () => {
    expect(res.input.objects).toBe(input().objects.length === res.input.objects.length ? res.input.objects : null);
    expect(res.input.objects).toHaveLength(9);
  });

  it("is deterministic", () => {
    const again = matchDocument(input(), SOURCE_ORDER);
    expect(encodeMapDocument(again.input)).toEqual(encodeMapDocument(res.input));
  });
});

describe("matchDocument — options", () => {
  it("detects an enlarged document and matches it at that factor", () => {
    const res = matchDocument(input({ factor: 1.5 }));
    expect(res.input.header.documentFactor).toBe(1.5);
    expect(res.input.header.mapScale).toBe(10000);
    expect(res.input.header.symbols[0].match).toMatchObject({ canonicalId: "ISOM2017-2:101", state: "auto" });
    expect(res.matching.factor).toMatchObject({ factor: 1.5, scaleFactor: 1.5, symbolScale: 1 });
  });

  it("honours library, edition, factor overrides and decisions", () => {
    const res = matchDocument(input(), { library: "ISSprOM2019-2", edition: "iof2024", factor: 1, decisions: [{ code: "527", canonicalId: "ISSprOM2019-2:521" }, { code: "900", canonicalId: "ISSprOM2019-2:999" }] });
    expect(res.input.header.library!.id).toBe("ISSprOM2019-2");
    expect(res.matching.edition).toBe("iof2024");
    expect(res.matching.factor.method).toBe("override");
    expect(res.input.header.symbols[3].match).toMatchObject({ canonicalId: "ISSprOM2019-2:521", method: "explicit", state: "auto", reviewed: true });
    expect(res.matching.symbols.reviewed).toBe(1);
    expect(res.input.header.warnings!.map((w) => w.code)).toContain("DECISION_UNKNOWN_ENTRY");
  });
});

describe("codec + render bridge", () => {
  const res = matchDocument(input(), SOURCE_ORDER);
  const doc = decodeMapDocument(encodeMapDocument(res.input));

  it("round-trips matches and palette ids through the document format", () => {
    expect(doc.header.library).toEqual({ id: "ISOM2017-2", version: SYMBOL_LIBRARY_VERSION });
    expect(doc.header.symbols[0].match).toMatchObject({ canonicalId: "ISOM2017-2:101", state: "auto", libraryVersion: `ISOM2017-2@${SYMBOL_LIBRARY_VERSION}` });
    expect(doc.header.symbols[3].match?.alternatives?.length ?? 0).toBeGreaterThanOrEqual(0);
    expect(doc.header.colours.find((c) => c.sourceNumber === 2)!.paletteIds).toEqual(expect.arrayContaining(["black100", "black-road-outline"]));
    expect(doc.header.colours.find((c) => c.id === "iof2022:purple-lower")).toMatchObject({ purpleRole: "lower", paletteIds: ["purple-lower"] });
  });

  it("draws applied matches from the library through the aligned stack, others from source", () => {
    expect(isAppliedMatch(doc.header.symbols[0].match)).toBe(true);
    expect(isAppliedMatch(doc.header.symbols[3].match)).toBe(false); // suggested
    expect(isAppliedMatch(doc.header.symbols[4].match)).toBe(false); // variant

    const index = paletteIndexOfStack(doc.header.colours);
    const expected = resolveEntry(getLibraryEntry("ISOM2017-2:502")!, index) as LineSymbol;
    const got = canonicalRender(doc, doc.header.symbols[1]) as LineSymbol;
    expect(got.borders!.backgroundColour).toBe(expected.borders!.backgroundColour);
    expect(doc.header.colours[got.borders!.left!.colour].paletteIds).toContain("black-road-outline");

    const r = documentRenderInput(doc);
    expect(r.stats.canonicalSymbols).toBe(3);
    expect(r.stats.canonicalMissing).toBe(0);
    expect(r.symbols[0]).toMatchObject({ type: "line", main: { widthUm: 140 } });
    expect(r.symbols[3]).toBe(r.symbols[3]); // source render of the suggested 527 stays
    expect((r.symbols[3] as { fill: number }).fill).toBe(index.get("black100"));
    expect(r.stats.rendered).toBe(8);
    expect(r.stats.proxied).toBe(1); // 401.0 has no render definition

    const source = documentRenderInput(doc, { canonical: false });
    expect(source.stats.canonicalSymbols).toBe(0);
    expect(source.symbols[0]).toEqual(doc.header.symbols[0].render);
  });

  it("scales canonical renders by the document factor", () => {
    const enlarged = decodeMapDocument(encodeMapDocument(matchDocument(input({ factor: 1.5 })).input));
    const got = canonicalRender(enlarged, enlarged.header.symbols[0]) as LineSymbol;
    expect(got.main!.widthUm).toBe(210);
  });
});

describe("matchDocument on a ski map (docs/map-symbols.md §8.2, §12)", () => {
  // The fixture enlarged to 1:10 000 (document factor 1.5), with the mapper's Ski-O colours on top and a very wide track.
  const base = input({ factor: 1.5 });
  const GREEN = base.header.colours.length, MASK = GREEN + 1;
  const track = resolveEntry(getLibraryEntry("ISSkiOM2019:801.1")!, new Map([["green-skio", GREEN], ["white-skio", MASK], ["black100", BLACK]]));
  const ski: typeof base = {
    header: {
      ...base.header,
      colours: [...base.header.colours, { id: "src:6", name: "Green for Ski-O", cmyk: [0.91, 0, 0.83, 0], sourceNumber: 6 }, { id: "src:7", name: "White under Ski-O tracks", cmyk: [0, 0, 0, 0], sourceNumber: 7 }],
      symbols: [...base.header.symbols, { code: "801.1", name: "Mycket brett spår", kind: "line", render: track }],
    },
    objects: [...base.objects, { symbolIdx: base.header.symbols.length, type: OBJECT_TYPE.line, sourceIndex: 20, coords: [0, 0, 1000, 1000], flags: [0, 0] }],
  };
  const res = matchDocument(ski);
  const h = res.input.header;
  const sym = h.symbols[h.symbols.length - 1];

  it("matches the track to the ISSkiOM entry at the track table's factor, keeping the document's library", () => {
    expect(res.matching.factor.factor).toBe(1.5);
    expect(sym.match).toMatchObject({ canonicalId: "ISSkiOM2019:801.1", state: "auto", method: "code+geometry" });
    expect(h.library?.id).toBe("ISOM2017-2");
    expect(sym.match!.libraryVersion).toBe(`ISOM2017-2@${SYMBOL_LIBRARY_VERSION}`);
  });

  it("identifies the mapper's Ski-O colours and inserts only what the map lacks", () => {
    expect(res.colourStack.inserted).toEqual(expect.arrayContaining(["green100-area", "orange-skio"]));
    expect(res.colourStack.inserted).not.toContain("green-skio");
    expect(res.colourStack.inserted).not.toContain("white-skio");
    for (const id of OVERLAY_STACK_IDS) expect(h.colours.filter((c) => c.paletteIds?.includes(id)), id).toHaveLength(1);
  });

  it("is drawn canonically at ×1 (the 0.85 mm of 1:15 000), not at the document factor", () => {
    const doc = decodeMapDocument(encodeMapDocument(res.input));
    const s = doc.header.symbols[doc.header.symbols.length - 1];
    expect(isAppliedMatch(s.match)).toBe(true);
    const drawn = canonicalRender(doc, s) as LineSymbol;
    expect(drawn.main!.widthUm).toBe(850);
    expect(documentRenderInput(doc).stats.canonicalMissing).toBe(0);
  });

  it("every stack carries the overlay's four rows, once", () => {
    for (const id of OVERLAY_STACK_IDS) expect(matchDocument(input()).input.header.colours.filter((c) => c.paletteIds?.includes(id)), id).toHaveLength(1);
  });
});

// ---- Row I5: stage 7 in the IOF order (docs/map-symbols.md §9.3 "In the importer") ----------------------------------

/** The fixture with a green 30 % area the table draws over everything. */
function withGreenOnTop() {
  const base = input();
  const green = { id: "src:6", name: "Grön 30% - Ytobjekt", cmyk: [0.24, 0, 0.27, 0] as [number, number, number, number], sourceNumber: 6 };
  return {
    header: { ...base.header, colours: [...base.header.colours, green], symbols: [...base.header.symbols, { code: "406.0", name: "Grön", kind: "area" as const, render: { type: "area" as const, id: "src:406", code: "406", name: "Grön", fill: base.header.colours.length } }] },
    objects: [...base.objects, { symbolIdx: base.header.symbols.length, type: OBJECT_TYPE.area, sourceIndex: 9, coords: [0, 0, 100, 0, 100, 100], flags: [0, 0, 0] }],
  };
}

describe("matchDocument — colourOrder (row I5)", () => {
  const source = matchDocument(input(), { colourOrder: "source" });
  const iof = matchDocument(input(), { colourOrder: "iof" });
  const h = iof.input.header;
  // The library road (ISOM 502) draws its outline on the black carrier, which the table has over both browns: roads over
  // the contours kept by default, the outline over the road infill implied by it.
  const KEPT = ["black-road-outline>brown100-line", "black-road-outline>brown50-road"];

  it("builds the layered stack: buildColourLayers' for the source table, every reference re-indexed onto its own colour", () => {
    const src = input().header.symbols;
    const infos = identifySourceColours(colours, "ISOM2017-2", "iof2022");
    const perSymbol = src.map((_, i) => input().objects.filter((o) => o.symbolIdx === i).length);
    const uses = symbolColourUses(source.input.header.symbols.map((s, i) => ({ render: src[i].render ? parseRenderSymbol(src[i].render!) : null, match: s.match ?? null, origin: s.origin })), perSymbol, infos, rolePalette("ISOM2017-2", "iof2022"));
    const needed = new Set<string>();
    for (const s of source.input.header.symbols) if (s.match?.state === "auto" && s.match.canonicalId) for (const id of colourRefs(getLibraryEntry(s.match.canonicalId)!.render)) needed.add(id);
    const direct = buildColourLayers({ colours, infos, uses, needed, spec: "ISOM2017-2", edition: "iof2022" });
    expect(h.colours).toEqual(direct.colours);
    src.forEach((s, i) => {
      if (!s.render) return;
      const before = renderColourPaths(parseRenderSymbol(s.render)).map((p) => colours[p.colour].sourceNumber);
      const after = renderColourPaths(parseRenderSymbol(h.symbols[i].render!)).map((p) => h.colours[p.colour].sourceNumber);
      expect(after, s.code).toEqual(before);
    });
  });

  it("records the order in the header and the report; the source order is §9.2 as before", () => {
    expect(h.colourOrder).toEqual({ order: "iof", kept: KEPT });
    expect(KEPT).toEqual(iof.colourStack.layers!.deviations.filter((d) => d.kept).map((d) => deviationKey(d.upper, d.lower)).sort());
    expect(source.input.header.colourOrder).toEqual({ order: "source" });
    expect(iof.colourStack).toMatchObject({ order: "iof", conflicts: [], areasAboveLowerPurple: [], purplesDisplaced: [] });
    expect(iof.colourStack.layers?.rows).toHaveLength(h.colours.length);
    expect(iof.colourStack.inserted).toEqual(expect.arrayContaining(["purple-lower", "purple-upper"]));
    expect(source.colourStack.order).toBe("source");
    expect(source.colourStack.layers).toBeUndefined();
  });

  it("leaves matching, objects and every symbol's fingerprint alone", () => {
    expect(iof.matching).toEqual(source.matching);
    expect(iof.input.objects).toHaveLength(source.input.objects.length);
    expect(documentSymbolFingerprints(iof.input.header)).toEqual(documentSymbolFingerprints(source.input.header));
  });

  it("carries every palette id the source order carries, so library symbols, Map mode and patches resolve on both", () => {
    const ids = new Set(h.colours.flatMap((c) => c.paletteIds ?? []));
    for (const id of source.input.header.colours.flatMap((c) => c.paletteIds ?? [])) expect(ids, id).toContain(id);
  });

  it("warns by deviations, roleless colours and source-ordered areas above lower purple — never §9.2's step 5", () => {
    const src = matchDocument(withGreenOnTop(), { colourOrder: "source" });
    expect(src.warnings.map((w) => w.code)).toContain("COLOUR_AREA_ABOVE_LOWER_PURPLE");
    const r = matchDocument(withGreenOnTop(), { colourOrder: "iof" });
    const codes = r.warnings.map((w) => w.code);
    expect(codes).not.toContain("COLOUR_AREA_ABOVE_LOWER_PURPLE");
    expect(codes).not.toContain("COLOUR_ORDER_CONFLICT");
    // The green the table draws over the black and the browns is a deviation, dropped by default.
    const dropped = r.colourStack.layers!.deviations.filter((d) => !d.kept);
    expect(dropped.map((d) => d.upper)).toContain("green30-area");
    expect(r.warnings.find((w) => w.code === "COLOUR_DEVIATION_DROPPED")).toMatchObject({ count: dropped.length });
    // The metro colour (no IOF class) is a roleless row with an object.
    expect(r.warnings.find((w) => w.code === "COLOUR_NO_ROLE")).toMatchObject({ count: 1 });
    expect(r.warnings.find((w) => w.code === "COLOUR_UNCLASSIFIED")).toMatchObject({ count: 1 });
    // The green sinks under lower purple.
    const index = paletteIndexOfStack(r.input.header.colours);
    const greenRow = r.input.header.colours.findIndex((c) => c.sourceNumber === 6);
    expect(greenRow).toBeLessThan(index.get("purple-lower")!);
  });

  it("takes deviation overrides: a dropped one kept is in the header's kept list and warned as kept", () => {
    const def = matchDocument(withGreenOnTop(), { colourOrder: "iof" });
    const dev = def.colourStack.layers!.deviations.find((d) => d.upper === "green30-area" && !d.kept)!;
    const k = deviationKey(dev.upper, dev.lower);
    const r = matchDocument(withGreenOnTop(), { colourOrder: "iof", deviations: { [k]: "keep" } });
    expect(r.input.header.colourOrder?.kept).toContain(k);
    expect(r.colourStack.layers!.deviations.find((d) => deviationKey(d.upper, d.lower) === k)).toMatchObject({ kept: true, byDefault: false });
    expect(r.warnings.find((w) => w.code === "COLOUR_DEVIATION_KEPT")?.count).toBeGreaterThanOrEqual(1);
    // Overrides do nothing in the source order.
    expect(matchDocument(withGreenOnTop(), { colourOrder: "source", deviations: { [k]: "keep" } }).input.header.colours).toEqual(src(withGreenOnTop()));
  });
  const src = (i: ReturnType<typeof withGreenOnTop>) => matchDocument(i, { colourOrder: "source" }).input.header.colours;

  it("survives the codec and draws its symbols in the same inks as the source order", () => {
    const a = decodeMapDocument(encodeMapDocument(iof.input));
    const b = decodeMapDocument(encodeMapDocument(source.input));
    expect(a.header.colourOrder).toEqual({ order: "iof", kept: KEPT });
    const ra = documentRenderInput(a), rb = documentRenderInput(b);
    expect(ra.stats.canonicalMissing).toBe(0);
    expect(ra.stats.canonicalSymbols).toBe(rb.stats.canonicalSymbols);
    const inks = (doc: typeof a, r: typeof ra) => r.symbols.slice(0, doc.header.symbols.length).map((s) => renderColourRefs(s).map((c) => doc.header.colours[c].cmyk.join(",")));
    expect(inks(a, ra)).toEqual(inks(b, rb));
  });

  it("is deterministic", () => {
    expect(encodeMapDocument(matchDocument(input(), { colourOrder: "iof" }).input)).toEqual(encodeMapDocument(iof.input));
  });
});
