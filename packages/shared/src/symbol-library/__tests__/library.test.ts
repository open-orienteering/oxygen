/**
 * Canonical library tests per 03 §6.4: (a) schema validity, (b) every
 * Appendix A heading covered, (c) a hand-typed dimension table asserted
 * against the entries, (d) purple roles per 03 §2.4, (e) every entry
 * symbolises without warnings.
 */

import { describe, expect, it } from "vitest";
import { COORD_FLAG, makePath } from "../../render/pass-stream.js";
import type { AreaSymbol, LineSymbol, PointSymbol, RenderSymbol, TextSymbol } from "../../render/symbol.js";
import { type RenderObject, symbolise } from "../../render/symbolise.js";
import { liberation } from "../../render/__tests__/fonts.js";
import {
  type SymbolLibraryId, entriesForCode, getLibraryEntry, getSymbolLibrary, listSymbolLibraries, materialiseLibrary, parseSymbolLibrary,
  resolveEntry, symbolLibraryInputs, symbolLibrarySchema, validateLibrary,
} from "../index.js";
import { paletteIndex } from "../palette.js";

// Appendix A of 03, typed by hand — the spec's headings, not derived from the entries.
const ISOM_HEADINGS = `101 102 103 104 105.1 105.2 106 107 108 109 110 111 112 113 114 115
201 202 203.1 203.2 204 205 206 207 208 209 210 211 212 213 214 215
301 302 303 304 305 306 307 308 309 310 311 312 313
401 402 403 404 405 406 407 408 409 410 412 413 414 415 416 417 418 419
501 502 503 504 505 506 507 508 509 510 511 512 513.1 513.2 514 515 516 517 518 519 520 521 522 523 524 525 526 527 528 529 530 531 532
601 602 603
701 702 703 704 705 706 707 708 709 710 711 712 713 715`.split(/\s+/);

const ISSPROM_HEADINGS = `101 102 103 104 105.1 105.2 107 108 109 110 111 112 113 115
201 202 203 204 205 206 207 208 210 213 214
301 302 303 305 306 307 308 309 310 311 312 313
401 402 403 404 405 406 407 408 409 410 411 412 413 414 415 416 417 418 419
501 501.1 501.2 501.3 505 506 507 508 509.1 509.2 510 511 512.1 512.2 512.3 513.1 513.2 515 516 518 519 520 521 522 522.1 524 525 526 527 528 529 530 531 532 533
601
701 702 703 704 705 706 707 708 709 710.1 710.2 714 715`.split(/\s+/);

const PURPLE_ROLES: Record<SymbolLibraryId, Record<string, "lower" | "upper">> = {
  "ISOM2017-2": { 701: "lower", 702: "upper", 703: "lower", 704: "upper", 705: "lower", 706: "lower", 707: "upper", 708: "lower", 709: "upper", 710: "lower", 711: "upper", 712: "lower", 713: "lower", 715: "lower" },
  "ISSprOM2019-2": { 701: "lower", 702: "upper", 703: "lower", 704: "upper", 705: "lower", 706: "lower", 707: "upper", 708: "lower", 709: "upper", "710.1": "lower", "710.2": "upper", 714: "upper", 715: "lower" },
};

const sym = (lib: SymbolLibraryId, id: string): RenderSymbol => {
  const entry = getLibraryEntry(`${lib}:${id}`);
  if (!entry) throw new Error(`no entry ${lib}:${id}`);
  return resolveEntry(entry, paletteIndex("iof2024", lib));
};
const asLine = (s: RenderSymbol) => s as LineSymbol;
const asArea = (s: RenderSymbol) => s as AreaSymbol;
const asPoint = (s: RenderSymbol) => s as PointSymbol;
const asText = (s: RenderSymbol) => s as TextSymbol;
const spacedOf = (s: RenderSymbol, i = 0) => {
  const p = asLine(s).glyphs![i].placement;
  if (p.at !== "spaced") throw new Error(`expected spaced placement, got ${p.at}`);
  return p;
};
const ISOM_IDX = paletteIndex("iof2024", "ISOM2017-2");
const SPR_IDX = paletteIndex("iof2024", "ISSprOM2019-2");

describe("symbol library — schema validity (a)", () => {
  it.each(Object.keys(symbolLibraryInputs) as SymbolLibraryId[])("%s parses and passes the authoring checks", (id) => {
    const lib = symbolLibrarySchema.parse(symbolLibraryInputs[id]);
    expect(validateLibrary(lib)).toEqual([]);
    expect(() => parseSymbolLibrary(symbolLibraryInputs[id])).not.toThrow();
  });

  it("libraries are what 03 §6.4 scopes for the first edition", () => {
    const libs = listSymbolLibraries();
    expect(libs.map((l) => [l.id, l.spec, l.referenceScale, l.palette])).toEqual([
      ["ISOM2017-2", "ISOM2017-2", 15_000, "iof2024"],
      ["ISSprOM2019-2", "ISSprOM2019-2", 4_000, "iof2024"],
    ]);
    expect(getSymbolLibrary("ISOM2017-2").entries.length).toBeGreaterThanOrEqual(140);
    expect(getSymbolLibrary("ISSprOM2019-2").entries.length).toBeGreaterThanOrEqual(130);
  });

  it("every entry cites its source and heading entries come before their variants", () => {
    for (const lib of listSymbolLibraries()) {
      const seenHeading = new Set<string>();
      for (const e of lib.entries) {
        expect(e.source).toMatch(new RegExp(`^${lib.spec.replace("2017-2", " 2017-2").replace("2019-2", " 2019-2")} Rev 6`));
        if (e.variant === null) seenHeading.add(e.code);
        else expect(seenHeading.has(e.code), `${e.id} has no heading entry before it`).toBe(true);
      }
    }
  });

  it("validateLibrary reports the authoring mistakes it is meant to catch", () => {
    const base = symbolLibrarySchema.parse(symbolLibraryInputs["ISOM2017-2"]);
    const [first] = base.entries;
    const broken = {
      ...base,
      entries: [
        { ...first, id: "ISOM2017-2:999" },
        { ...first, render: { type: "line" as const, main: { colour: "no-such-colour", widthUm: 100 } } },
        { ...first, code: "705", id: "ISOM2017-2:705", purpleRole: null },
        { ...first, purpleRole: "lower" as const },
        first,
        first,
      ],
    };
    const messages = validateLibrary(broken).map((p) => p.message);
    expect(messages).toEqual(expect.arrayContaining([
      expect.stringMatching(/id should be ISOM2017-2:101/),
      expect.stringMatching(/palette id "no-such-colour"/),
      expect.stringMatching(/course symbols need a purpleRole/),
      expect.stringMatching(/purpleRole is only for 7xx/),
      "duplicate id",
    ]));
  });
});

describe("symbol library — heading coverage (b)", () => {
  it("ISOM 2017-2: all 113 Appendix A headings have a heading entry", () => {
    expect(ISOM_HEADINGS).toHaveLength(113);
    const missing = ISOM_HEADINGS.filter((code) => !entriesForCode("ISOM2017-2", code).some((e) => e.variant === null));
    expect(missing).toEqual([]);
  });

  it("ISSprOM 2019-2: all 105 Appendix A headings have a heading entry", () => {
    expect(ISSPROM_HEADINGS).toHaveLength(105);
    const missing = ISSPROM_HEADINGS.filter((code) => !entriesForCode("ISSprOM2019-2", code).some((e) => e.variant === null));
    expect(missing).toEqual([]);
  });

  it("no entry uses a code outside its spec's headings", () => {
    const stray = (lib: SymbolLibraryId, headings: string[]) =>
      getSymbolLibrary(lib).entries.filter((e) => !headings.includes(e.code)).map((e) => e.id);
    expect(stray("ISOM2017-2", ISOM_HEADINGS)).toEqual([]);
    expect(stray("ISSprOM2019-2", ISSPROM_HEADINGS)).toEqual([]);
  });
});

describe("symbol library — dimension table, ISOM 2017-2 Rev 6 (c)", () => {
  const L = (id: string) => asLine(sym("ISOM2017-2", id));
  const A = (id: string) => asArea(sym("ISOM2017-2", id));
  const P = (id: string) => asPoint(sym("ISOM2017-2", id));

  it("contours", () => {
    expect(L("101").main).toMatchObject({ widthUm: 140, cap: "round", join: "round", colour: ISOM_IDX.get("brown100-line") });
    expect(L("102").main).toMatchObject({ widthUm: 250 });
    expect(L("103").main).toMatchObject({ widthUm: 100, dash: { layout: "ocad", dashUm: 2000, gapUm: 200 } });
    expect(L("104").main).toMatchObject({ widthUm: 250 }); // Rev 6: 0.18 → 0.25
    expect(spacedOf(L("104"))).toMatchObject({ distanceUm: 500 });
  });

  it("landform glyphs and ends (B10)", () => {
    // Slope lines point to +y at angle 0 (OCAD 0,0 → 0,40; Mapper 0,0 → 0,−470 y-down): 0.4 mm beyond the contour's edge.
    expect(P("101.b")).toMatchObject({ orientation: "object", glyph: { parts: [{ widthUm: 140, geometry: { coords: [0, 0, 0, 470] } }] } });
    expect(P("103.b")).toMatchObject({ orientation: "object", glyph: { parts: [{ widthUm: 100, geometry: { coords: [0, 0, 0, 450] } }] } });
    // 107: pointed ends tapering over 0.75 mm.
    expect(L("107").main).toMatchObject({ widthUm: 250, cap: "pointed", taper: { startUm: 750, endUm: 750 } });
    // 111: "the symbol is orientated to north".
    expect(P("111").orientation).toBe("north");
  });

  it("rock", () => {
    expect(L("201").main).toMatchObject({ widthUm: 350 });
    expect(spacedOf(L("201"))).toMatchObject({ distanceUm: 500 });
    expect(L("201").glyphs![0].glyph.parts[0]).toMatchObject({ widthUm: 120 });
    expect(L("202").main).toMatchObject({ widthUm: 250 });
    expect(P("204").glyph.parts[0]).toMatchObject({ kind: "disc", diameterUm: 400 });
    expect(P("205").glyph.parts[0]).toMatchObject({ kind: "disc", diameterUm: 600 });
    expect(A("214").fill).toBe(ISOM_IDX.get("black-area-screen"));
    expect(A("213")).toMatchObject({ fill: ISOM_IDX.get("yellow50"), patterns: [{ cellWidthUm: 450, angleDeg: 45 }] });
  });

  it("water", () => {
    expect(A("301")).toMatchObject({ fill: ISOM_IDX.get("blue100-area"), border: { main: { widthUm: 120 } } }); // Rev 6: 0.18 → 0.12
    expect(A("302").border!.main).toMatchObject({ widthUm: 100, colour: ISOM_IDX.get("blue100-line") });
    expect(L("304").main).toMatchObject({ widthUm: 300 });
    expect(L("305").main).toMatchObject({ widthUm: 180 });
    expect(L("306").main).toMatchObject({ widthUm: 180, dash: { dashUm: 1250, gapUm: 250 } });
    expect(A("307").hatches![0]).toMatchObject({ widthUm: 250, spacingUm: 500 });
    expect(A("308").hatches![0]).toMatchObject({ widthUm: 100, spacingUm: 300 });
  });

  it("vegetation", () => {
    expect(A("402").patterns![0]).toMatchObject({ cellWidthUm: 700, angleDeg: 45, glyph: { parts: [{ diameterUm: 400, colour: ISOM_IDX.get("white-over-yellow") }] } });
    expect(A("404").patterns![0]).toMatchObject({ cellWidthUm: 800, glyph: { parts: [{ diameterUm: 500 }] } });
    expect(A("406.b").hatches![0]).toMatchObject({ widthUm: 400, spacingUm: 1500 });
    expect(A("407").hatches![0]).toMatchObject({ widthUm: 120, spacingUm: 840 });
    expect(A("409").hatches![0]).toMatchObject({ widthUm: 140, spacingUm: 420 });
    expect(A("412").patterns![0]).toMatchObject({ cellWidthUm: 800, glyph: { parts: [{ diameterUm: 200 }] } });
    expect(L("415").main).toMatchObject({ widthUm: 100 });
    expect(spacedOf(L("416"))).toMatchObject({ distanceUm: 450, minCount: 5 });
    expect(L("416").glyphs![0].glyph.parts[0]).toMatchObject({ diameterUm: 220 });
    // Green dot ø 0.6 with the 0.2 white dot inside (Rev 6 "aid to the colour vision impaired"), not a white mask.
    expect(P("418").glyph.parts).toMatchObject([{ kind: "disc", diameterUm: 600 }, { kind: "disc", diameterUm: 200 }]);
  });

  it("man-made", () => {
    expect(L("502").borders).toMatchObject({ left: { widthUm: 140, shiftUm: 220 }, right: { widthUm: 140, shiftUm: 220 }, backgroundColour: ISOM_IDX.get("brown50-road") });
    expect(L("503").main).toMatchObject({ widthUm: 350 });
    expect(L("504").main).toMatchObject({ widthUm: 350, dash: { dashUm: 3000, gapUm: 250 } });
    expect(L("505").main).toMatchObject({ widthUm: 250, dash: { dashUm: 2000, gapUm: 250 } });
    expect(L("506").main).toMatchObject({ widthUm: 180, dash: { dashUm: 1000, gapUm: 250 } });
    expect(L("507").main!.dash).toMatchObject({ dashUm: 2250, gapUm: 800, secondaryGapUm: 250 });
    expect(L("508").main).toMatchObject({ widthUm: 140, dash: { dashUm: 2000, gapUm: 250 } });
    expect(L("508.b").main!.halo).toMatchObject({ colour: ISOM_IDX.get("yellow100"), widthUm: 155, continuous: true });
    // 509 (B10): white dashes 1.0 / 1.5 over a black 0.45 band (0.1 rails at 0.35 CC), black 1.5 at both ends.
    expect(L("509").main).toMatchObject({
      colour: ISOM_IDX.get("white-railway"), widthUm: 250, dash: { layout: "ocad", dashUm: 1000, gapUm: 1500 }, shortenStartUm: 1500, shortenEndUm: 1500,
    });
    expect(L("509").borders).toEqual({ backgroundColour: ISOM_IDX.get("black100"), backgroundWidthUm: 450 });
    // 510 / 511 (B10): pylons on corner points (flagged vertices, ends only when flagged); 510 bars 0.3 beyond the line's edge.
    expect(L("510").glyphs).toMatchObject([{ placement: { at: "corners" }, glyph: { parts: [{ widthUm: 140, geometry: { coords: [0, -370, 0, 370] } }] } }]);
    expect(L("511").glyphs).toMatchObject([{ placement: { at: "corners" }, glyph: { parts: [{ widthUm: 200, geometry: { coords: [0, -570, 0, 570] } }] } }]);
    expect(L("511.b").glyphs).toMatchObject([{ placement: { at: "corners" } }]);
    for (const id of ["510", "511", "511.b"]) expect(L(id).glyphs![0].placement, id).toEqual({ at: "corners" });
    expect(L("513.1").main).toMatchObject({ widthUm: 140 });
    expect(spacedOf(L("513.1"))).toMatchObject({ distanceUm: 2000 });
    expect(L("513.1").glyphs![0].glyph.parts[0]).toMatchObject({ diameterUm: 400 });
    expect(L("515").main).toMatchObject({ widthUm: 250 });
    expect(spacedOf(L("515"))).toMatchObject({ distanceUm: 3000, perSpot: 2, spotSpacingUm: 800 });
    expect(L("516").main).toMatchObject({ widthUm: 140 });
    expect(spacedOf(L("516"))).toMatchObject({ distanceUm: 2000 });
    expect(spacedOf(L("518"))).toMatchObject({ distanceUm: 2500, perSpot: 2, spotSpacingUm: 600 });
    expect(A("520").fill).toBe(ISOM_IDX.get("olive"));
    expect(A("521").fill).toBe(ISOM_IDX.get("black100"));
    expect(A("522")).toMatchObject({ fill: ISOM_IDX.get("black20-canopy"), border: { main: { widthUm: 100 } } });
    expect(L("523").main).toMatchObject({ widthUm: 160, dash: { dashUm: 500, gapUm: 250 } });
    expect(P("526").glyph.parts).toMatchObject([{ kind: "disc", diameterUm: 140 }, { kind: "ring", diameterUm: 800, widthUm: 160 }]);
    expect(spacedOf(L("529"))).toMatchObject({ distanceUm: 2000, perSpot: 2, spotSpacingUm: 600 });
    expect(L("532")).toMatchObject({ main: { widthUm: 400 }, borders: { left: { widthUm: 100, shiftUm: 250 } } });
    expect(spacedOf(L("532"))).toMatchObject({ distanceUm: 500, minCount: 3 });
  });

  it("course planning", () => {
    expect(P("703").glyph.parts[0]).toMatchObject({ kind: "ring", diameterUm: 5350, widthUm: 350 }); // ø 5.0 (CC) + 0.35
    expect(P("706").glyph.parts).toMatchObject([{ diameterUm: 4350 }, { diameterUm: 6350 }]);
    expect(asText(sym("ISOM2017-2", "704"))).toMatchObject({ digitHeightUm: 4000, colour: ISOM_IDX.get("purple-upper") });
    expect(L("705").main).toMatchObject({ widthUm: 350, colour: ISOM_IDX.get("purple-lower") });
    expect(L("707").main).toMatchObject({ widthUm: 350, dash: { dashUm: 2000, gapUm: 500 }, colour: ISOM_IDX.get("purple-upper") });
    expect(L("708").main).toMatchObject({ widthUm: 700 });
    expect(A("709").hatches![0]).toMatchObject({ widthUm: 250, spacingUm: 1200, angleDeg: 45, colour: ISOM_IDX.get("purple-upper") });
    expect(spacedOf(L("711"))).toMatchObject({ distanceUm: 5000, minCount: 2 });
    expect(P("712").glyph.parts[0]).toMatchObject({ widthUm: 1330 });
    expect(getLibraryEntry("ISOM2017-2:701")!.minimum).toBeUndefined();
    expect(getLibraryEntry("ISOM2017-2:707")!.minimum).toEqual({ lengthUm: 4500 });
  });
});

describe("symbol library — dimension table, ISSprOM 2019-2 Rev 6 (c)", () => {
  const L = (id: string) => asLine(sym("ISSprOM2019-2", id));
  const A = (id: string) => asArea(sym("ISSprOM2019-2", id));
  const P = (id: string) => asPoint(sym("ISSprOM2019-2", id));

  it("landforms and rock", () => {
    expect(L("101").main).toMatchObject({ widthUm: 210, cap: "round", colour: SPR_IDX.get("brown100") });
    expect(L("102").main).toMatchObject({ widthUm: 300 });
    expect(L("103").main).toMatchObject({ widthUm: 150, dash: { dashUm: 3000, gapUm: 300 } });
    expect(L("104").main).toMatchObject({ widthUm: 270 });
    // B10: slope lines to +y (0.75 / 0.6 mm outside measure from the contour's centre), 107 tapers over 0.75 mm.
    expect(P("101.b")).toMatchObject({ orientation: "object", glyph: { parts: [{ widthUm: 210, geometry: { coords: [0, 0, 0, 645] } }] } });
    expect(P("103.b")).toMatchObject({ orientation: "object", glyph: { parts: [{ widthUm: 150, geometry: { coords: [0, 0, 0, 525] } }] } });
    expect(L("107").main).toMatchObject({ widthUm: 370, cap: "pointed", taper: { startUm: 750, endUm: 750 } });
    expect(P("111").orientation).toBe("north");
    expect(L("105.1").main).toMatchObject({ widthUm: 270 }); // Rev 6: 0.18 → 0.27
    expect(L("105.1").glyphs![0].glyph.parts[0]).toMatchObject({ diameterUm: 700 }); // Rev 6: 0.6 → 0.7
    expect(spacedOf(L("105.1"))).toMatchObject({ distanceUm: 3750 });
    expect(spacedOf(L("105.2"))).toMatchObject({ distanceUm: 1900 });
    expect(P("109").glyph.parts[0]).toMatchObject({ diameterUm: 750 });
    expect(A("113").patterns![0].glyph.parts[0]).toMatchObject({ diameterUm: 300 }); // Rev 6
    expect(L("201").main).toMatchObject({ widthUm: 500 });
    expect(L("201").glyphs![0].glyph.parts[0]).toMatchObject({ widthUm: 180 });
    expect(L("202").main).toMatchObject({ widthUm: 300, cap: "round" });
    expect(P("204").glyph.parts[0]).toMatchObject({ diameterUm: 600 });
    expect(P("205").glyph.parts[0]).toMatchObject({ diameterUm: 900 });
    expect(A("210").patterns![0].glyph.parts[0]).toMatchObject({ diameterUm: 250 }); // Rev 6
  });

  it("water and vegetation", () => {
    expect(A("301")).toMatchObject({ fill: SPR_IDX.get("blue100-area"), border: { main: { widthUm: 180, colour: SPR_IDX.get("black100") } } });
    expect(A("302")).toMatchObject({ fill: SPR_IDX.get("blue30-area"), border: { main: { widthUm: 180, colour: SPR_IDX.get("blue100-pointline") } } });
    expect(L("305").main).toMatchObject({ widthUm: 210 });
    expect(L("306").main).toMatchObject({ widthUm: 210, dash: { dashUm: 1870, gapUm: 370 } });
    expect(A("308").hatches![0]).toMatchObject({ widthUm: 120, spacingUm: 380 });
    expect(A("402").patterns![0]).toMatchObject({ cellWidthUm: 750, glyph: { parts: [{ diameterUm: 600 }] } });
    expect(A("404").patterns![0]).toMatchObject({ cellWidthUm: 1000, glyph: { parts: [{ diameterUm: 700 }] } }); // Rev 6: 0.8 → 0.7
    expect(A("411").fill).toBe(SPR_IDX.get("darkgreen-area"));
    expect(A("413").patterns![0]).toMatchObject({ cellWidthUm: 1200, glyph: { parts: [{ diameterUm: 680 }] } });
    expect(L("415").main).toMatchObject({ widthUm: 150 }); // Rev 6: 0.1 → 0.15
    expect(spacedOf(L("416"))).toMatchObject({ distanceUm: 600, minCount: 5 });
    expect(P("417").glyph.parts).toMatchObject([{ diameterUm: 1400 }, { kind: "ring", diameterUm: 1200, widthUm: 250 }]);
  });

  it("man-made", () => {
    expect(A("501")).toMatchObject({ fill: SPR_IDX.get("brown30-paved"), border: { main: { widthUm: 100, colour: SPR_IDX.get("black-road-outline") } } });
    expect(A("501.b").fill).toBe(SPR_IDX.get("brown50-paved"));
    expect(L("501.2").main).toMatchObject({ widthUm: 100, dash: { dashUm: 700, gapUm: 200 }, shortenStartUm: 150, shortenEndUm: 150 });
    expect(L("505").borders).toMatchObject({ backgroundColour: SPR_IDX.get("brown30-road"), backgroundWidthUm: 350, left: { widthUm: 120, dash: { dashUm: 2000, gapUm: 250 } } });
    expect(L("506").main).toMatchObject({ widthUm: 270, dash: { dashUm: 1500, gapUm: 370 } });
    expect(L("507").main!.dash).toMatchObject({ dashUm: 3370, gapUm: 1500, secondaryGapUm: 370 });
    expect(L("508").main).toMatchObject({ widthUm: 210, dash: { dashUm: 4500, gapUm: 750 } });
    expect(L("509.1").main).toMatchObject({
      colour: SPR_IDX.get("white-railway"), widthUm: 250, dash: { layout: "ocad", dashUm: 1000, gapUm: 1500 }, shortenStartUm: 1500, shortenEndUm: 1500,
    });
    expect(L("509.1").borders).toEqual({ backgroundColour: SPR_IDX.get("black100"), backgroundWidthUm: 450 });
    expect(L("510").glyphs).toMatchObject([{ placement: { at: "corners" }, glyph: { parts: [{ widthUm: 140, geometry: { coords: [0, -370, 0, 370] } }] } }]);
    expect(L("511").glyphs).toMatchObject([{ placement: { at: "corners" }, glyph: { parts: [{ widthUm: 200, geometry: { coords: [0, -1120, 0, 1120] } }] } }]);
    for (const id of ["510", "511", "511.b"]) expect(L(id).glyphs![0].placement, id).toEqual({ at: "corners" });
    expect(L("509.2").borders).toMatchObject({ left: { widthUm: 80, shiftUm: 150 }, right: { widthUm: 80, shiftUm: 150 } }); // Rev 6: 0.08, black 100 %
    expect(spacedOf(L("512.2"))).toMatchObject({ distanceUm: 500, minCount: 2 });
    expect(A("512.3").hatches![0]).toMatchObject({ widthUm: 600, angleDeg: 45, colour: SPR_IDX.get("white-two-level") });
    expect(L("513.1").main).toMatchObject({ widthUm: 210 });
    expect(L("513.1").glyphs![0].glyph.parts[0]).toMatchObject({ diameterUm: 600 });
    expect(spacedOf(L("513.1"))).toMatchObject({ distanceUm: 3750 });
    expect(L("515").main).toMatchObject({ widthUm: 400 });
    expect(spacedOf(L("516"))).toMatchObject({ distanceUm: 3750 });
    expect(L("518").main).toMatchObject({ widthUm: 400 });
    expect(spacedOf(L("518"))).toMatchObject({ distanceUm: 3750, perSpot: 2, spotSpacingUm: 900 });
    expect(A("521")).toMatchObject({ fill: SPR_IDX.get("black50-building"), border: { main: { widthUm: 140 } } });
    expect(P("524").glyph.parts[0]).toMatchObject({ diameterUm: 1200 });
    expect(P("526").glyph.parts).toMatchObject([{ diameterUm: 200 }, { kind: "ring", diameterUm: 1000, widthUm: 220 }]);
    expect(A("533").patterns![0]).toMatchObject({ cellWidthUm: 750, angleDeg: 45, glyph: { parts: [{ diameterUm: 550, colour: SPR_IDX.get("black50-building") }] } });
  });

  it("course planning", () => {
    expect(P("701").glyph.parts[0].geometry!.coords).toHaveLength(6);
    expect(P("703").glyph.parts[0]).toMatchObject({ kind: "ring", diameterUm: 6350, widthUm: 350 }); // ø 6.0 (CC)
    expect(P("706").glyph.parts).toMatchObject([{ diameterUm: 5350 }, { diameterUm: 7350 }]);
    expect(asText(sym("ISSprOM2019-2", "704"))).toMatchObject({ digitHeightUm: 4000, colour: SPR_IDX.get("purple-upper") });
    expect(asText(sym("ISSprOM2019-2", "704.b")).halo).toMatchObject({ colour: SPR_IDX.get("white-upper"), widthUm: 150 });
    expect(L("708").main).toMatchObject({ widthUm: 1000 });
    expect(A("709").hatches![0]).toMatchObject({ widthUm: 400, spacingUm: 1200 }); // Rev 6: 0.25 → 0.4
    expect(P("710.1").glyph.parts[0]).toMatchObject({ widthUm: 500 }); // Rev 6: 0.35 → 0.5
    expect(A("714")).toMatchObject({ fill: SPR_IDX.get("purple50"), border: { main: { widthUm: 100, colour: SPR_IDX.get("purple-upper") } } });
  });
});

describe("symbol library — purple roles (d)", () => {
  it.each(Object.keys(PURPLE_ROLES) as SymbolLibraryId[])("%s course symbols carry the role of 03 §2.4", (lib) => {
    for (const [code, role] of Object.entries(PURPLE_ROLES[lib])) {
      const entries = entriesForCode(lib, code);
      expect(entries.length, `${lib}:${code}`).toBeGreaterThan(0);
      for (const e of entries) {
        expect(e.purpleRole, e.id).toBe(role);
        // The colours used agree with the role: lower-purple entries never draw in upper purple and vice versa.
        const colours = JSON.stringify(e.render);
        if (role === "lower") expect(colours, e.id).not.toContain("purple-upper");
        else expect(colours, e.id).not.toContain("purple-lower");
      }
    }
    const non7xx = getSymbolLibrary(lib).entries.filter((e) => !e.code.startsWith("7"));
    expect(non7xx.every((e) => e.purpleRole === null)).toBe(true);
  });

  it("ISSprOM-only and ISOM-only course symbols are not cross-listed", () => {
    expect(entriesForCode("ISSprOM2019-2", "711")).toEqual([]);
    expect(entriesForCode("ISSprOM2019-2", "712")).toEqual([]);
    expect(entriesForCode("ISOM2017-2", "714")).toEqual([]);
    expect(entriesForCode("ISOM2017-2", "710.1")).toEqual([]);
  });
});

describe("symbol library — materialisation and symbolisation (e)", () => {
  const fonts = () => [liberation().sans];
  const F = COORD_FLAG;

  /** One representative object per symbol type: a line with a corner and a dash point, a 20 × 20 mm square, a point, a label. */
  function objectFor(idx: number, s: RenderSymbol): RenderObject {
    switch (s.type) {
      case "line":
        return { symbolIdx: idx, path: makePath([0, 0, 15000, 0, 15000, 12000, 30000, 12000], [0, F.corner, F.dash, 0]) };
      case "area":
        return { symbolIdx: idx, path: makePath([0, 0, 20000, 0, 20000, 20000, 0, 20000], undefined, true), angleDeg: 30 };
      case "point":
        return { symbolIdx: idx, path: makePath([5000, 5000]), angleDeg: 45 };
      case "text":
        return { symbolIdx: idx, path: makePath([5000, 5000]), text: "31" };
    }
  }

  it.each(Object.keys(symbolLibraryInputs) as SymbolLibraryId[])("%s: every entry resolves and symbolises to at least one pass without warnings", (id) => {
    const m = materialiseLibrary(id);
    expect(m.symbols).toHaveLength(m.library.entries.length);
    const maxColour = m.colours.length - 1;
    for (const s of m.symbols) {
      for (const c of JSON.stringify(s).matchAll(/"(?:colour|fill|backgroundColour)":(\d+)/g)) {
        expect(Number(c[1])).toBeLessThanOrEqual(maxColour);
      }
    }
    const objects = m.symbols.map((s, i) => objectFor(i, s));
    const { stream, warnings } = symbolise({ objects, symbols: m.symbols, fonts: fonts() });
    expect(warnings).toEqual([]);
    const perObject = new Map<number, number>();
    for (const o of stream.objectIdx) perObject.set(o, (perObject.get(o) ?? 0) + 1);
    const silent = m.symbols.filter((_, i) => !perObject.has(i)).map((s) => s.id);
    expect(silent).toEqual([]);
  });

  it("materialising with the 2022 palette keeps indices and changes only CMYK", () => {
    const a = materialiseLibrary("ISOM2017-2", "iof2024");
    const b = materialiseLibrary("ISOM2017-2", "iof2022");
    expect(b.symbols).toEqual(a.symbols);
    expect(b.colours.map((c) => c.id.replace(/^iof2022:/, ""))).toEqual(a.colours.map((c) => c.id.replace(/^iof2024:/, "")));
    const brown = (m: typeof a) => m.colours.find((c) => c.id.endsWith(":brown100-line"))!.cmyk;
    expect(brown(a)).toEqual([0.25, 0.75, 1, 0]);
    expect(brown(b)).toEqual([0, 0.56, 1, 0.18]);
  });

  it.each(["ISOM2017-2", "ISSprOM2019-2"] as SymbolLibraryId[])("%s 107 erosion gully: the stroke pass carries the pointed cap and the 0.75 mm taper (B10)", (lib) => {
    const s = sym(lib, "107");
    const { stream, warnings } = symbolise({ objects: [{ symbolIdx: 0, path: makePath([0, 0, 5000, 0]) }], symbols: [s], fonts: fonts() });
    expect(warnings).toEqual([]);
    expect(stream.passes).toMatchObject([{ kind: "stroke", cap: "pointed", taper: { startUm: 750, endUm: 750 } }]);
  });

  it("resolved symbols carry the entry's id, code and English name", () => {
    const s = sym("ISOM2017-2", "302.b");
    expect(s).toMatchObject({ id: "ISOM2017-2:302.b", code: "302", name: "Shallow body of water, dashed outline" });
  });
});
