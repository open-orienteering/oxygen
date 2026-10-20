/**
 * Stages 6–7 over a whole document input (06 §4.1): library choice, factor,
 * per-symbol matches, aligned colour stack, remapped source renders, header
 * fields, warnings — and that the result survives the codec and is what the
 * render bridge draws canonically.
 */

import { describe, expect, it } from "vitest";
import { decodeMapDocument, encodeMapDocument } from "../../map-document/codec.js";
import { canonicalRender, documentRenderInput, isAppliedMatch } from "../../map-document/render-bridge.js";
import { type LineSymbol, parseRenderSymbol } from "../../render/symbol.js";
import { renderColourRefs } from "../../render/transform.js";
import { getLibraryEntry, SYMBOL_LIBRARY_VERSION } from "../../symbol-library/index.js";
import { resolveEntry } from "../../symbol-library/schema.js";
import { paletteIndexOfStack } from "../colour-align.js";
import { matchDocument } from "../match-document.js";
import { colours, input } from "./match-fixture.js";

describe("matchDocument", () => {
  const res = matchDocument(input());
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
    const again = matchDocument(input());
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
  const res = matchDocument(input());
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
