import { describe, it, expect } from "vitest";
import { ocadFontFamily, ocadLineStyle, ocadSymbolToRender, type OcadSymbolDefLike, type SymbolConversionContext } from "../ocad-symbols.js";

// Colour table of the fixture: OCAD number → stack index.
const COLOURS = new Map([[0, 2], [1, 1], [3, 0], [7, 3]]);
const table = new Map<number, OcadSymbolDefLike>();
const ctx: SymbolConversionContext = {
  colourIndex: (n) => COLOURS.get(n),
  symbolByNumber: (n) => table.get(n),
};
const c = (x: number, y: number, xFlags = 0, yFlags = 0) => ({ 0: x, 1: y, xFlags, yFlags });
const line = (over: Partial<OcadSymbolDefLike>): OcadSymbolDefLike => ({ symNum: 505000, number: "505.0", type: 2, description: "Stig", lineColor: 0, lineWidth: 25, lineStyle: 0, ...over });
const codes = (w: { code: string }[]) => w.map((x) => x.code);

describe("ocadLineStyle", () => {
  it("maps the join family and the pointed-end bit", () => {
    expect(ocadLineStyle(0)).toEqual({ cap: "flat", join: "bevel" });
    expect(ocadLineStyle(1)).toEqual({ cap: "round", join: "round" });
    expect(ocadLineStyle(4)).toEqual({ cap: "flat", join: "miter" });
    expect(ocadLineStyle(2)).toEqual({ cap: "pointed", join: "bevel" });
    expect(ocadLineStyle(6)).toEqual({ cap: "pointed", join: "miter" });
    expect(ocadLineStyle(undefined)).toEqual({ cap: "flat", join: "bevel" });
  });
});

describe("ocadFontFamily", () => {
  it("picks the metric-compatible family and flags everything else as substituted", () => {
    expect(ocadFontFamily("Arial")).toEqual({ family: "liberation-sans", substituted: false });
    expect(ocadFontFamily("Arial Narrow")).toEqual({ family: "liberation-sans-narrow", substituted: false });
    expect(ocadFontFamily("Times New Roman")).toEqual({ family: "liberation-serif", substituted: false });
    expect(ocadFontFamily("Courier New")).toEqual({ family: "liberation-mono", substituted: false });
    expect(ocadFontFamily("Verdana")).toEqual({ family: "liberation-sans", substituted: true });
    expect(ocadFontFamily("Georgia")).toEqual({ family: "liberation-serif", substituted: true });
    expect(ocadFontFamily(undefined)).toEqual({ family: "liberation-sans", substituted: true });
  });
});

describe("ocadSymbolToRender — line", () => {
  it("converts a plain line: colour index, width ×10, style, provenance id", () => {
    const { render, warnings } = ocadSymbolToRender(line({ lineStyle: 1 }), ctx);
    expect(warnings).toEqual([]);
    expect(render).toMatchObject({ type: "line", id: "src:505000", code: "505.0", name: "Stig", main: { colour: 2, widthUm: 250, cap: "round", join: "round" } });
    expect(render && render.type === "line" ? render.main?.dash : "x").toBeUndefined();
  });

  it("maps dashes with OCAD semantics: end dash length, secondary gap, 507 end gap, minSym", () => {
    // 507 footpath from the corpus: endGap is the secondary gap applied to the end dashes.
    const { render } = ocadSymbolToRender(line({ mainLength: 225, endLength: 225, mainGap: 80, secGap: 25, endGap: 25, minSym: 1 }), ctx);
    expect(render).toMatchObject({ type: "line", main: { dash: { layout: "ocad", dashUm: 2250, gapUm: 800, secondaryGapUm: 250, endGapUm: 250, minGaps: 1 } } });
    const r2 = ocadSymbolToRender(line({ mainLength: 200, endLength: 100, mainGap: 50, minSym: -1 }), ctx).render;
    expect(r2).toMatchObject({ type: "line", main: { dash: { dashUm: 2000, endDashUm: 1000, gapUm: 500 } } });
    expect(r2 && r2.type === "line" ? r2.main!.dash!.minGaps : "x").toBeUndefined();
  });

  it("maps distFromStart / distToEnd to stroke shortening", () => {
    const { render } = ocadSymbolToRender(line({ distFromStart: 30, distToEnd: 40 }), ctx);
    expect(render).toMatchObject({ type: "line", main: { shortenStartUm: 300, shortenEndUm: 400 } });
  });

  it("turns the framing line into a halo, also when the main line has no width (502 road)", () => {
    const framed = ocadSymbolToRender(line({ lineColor: 3, lineWidth: 14, frColor: 0, frWidth: 60, frStyle: 1 }), ctx).render;
    expect(framed).toMatchObject({ type: "line", main: { colour: 0, widthUm: 140, halo: { colour: 2, widthUm: 230, continuous: true } } });
    const only = ocadSymbolToRender(line({ lineWidth: 0, lineColor: 99, frColor: 0, frWidth: 60, frStyle: 1 }), ctx);
    expect(only.warnings).toEqual([]); // zero-width main line never looks up its colour
    expect(only.render).toMatchObject({ type: "line", main: { widthUm: 0, cap: "round", join: "round", halo: { colour: 2, widthUm: 300 } } });
  });

  it("maps double lines to borders and the fill to a background band (dblWidth)", () => {
    const { render } = ocadSymbolToRender(line({
      lineWidth: 0,
      doubleLine: { dblMode: 1, dblFlags: 1, dblFillColor: 7, dblLeftColor: 0, dblRightColor: 0, dblWidth: 50, dblLeftWidth: 14, dblRightWidth: 14 },
    }), ctx);
    expect(render).toMatchObject({
      type: "line",
      borders: { left: { colour: 2, widthUm: 140, shiftUm: 320 }, right: { colour: 2, widthUm: 140, shiftUm: 320 }, backgroundColour: 3, backgroundWidthUm: 500 },
    });
    expect(render && render.type === "line" ? render.main : "x").toBeUndefined();
  });

  it("dashes the left border in mode 2 and both in mode 3; mode 65535 is off", () => {
    const dbl = { dblMode: 3, dblFlags: 0, dblLeftColor: 0, dblRightColor: 0, dblWidth: 50, dblLeftWidth: 10, dblRightWidth: 10, dblLength: 199, dblGap: 26 };
    const both = ocadSymbolToRender(line({ doubleLine: dbl }), ctx).render;
    expect(both).toMatchObject({ type: "line", borders: { left: { dash: { dashUm: 1990, gapUm: 260 } }, right: { dash: { dashUm: 1990, gapUm: 260 } } } });
    const left = ocadSymbolToRender(line({ doubleLine: { ...dbl, dblMode: 2 } }), ctx).render;
    expect(left && left.type === "line" ? left.borders!.right!.dash : "x").toBeUndefined();
    expect(left).toMatchObject({ type: "line", borders: { left: { dash: { dashUm: 1990 } } } });
    const off = ocadSymbolToRender(line({ doubleLine: { ...dbl, dblMode: 65535 } }), ctx);
    expect(off.render && off.render.type === "line" ? off.render.borders : "x").toBeUndefined();
    expect(codes(off.warnings)).toEqual(["SYMBOL_FEATURE_DROPPED"]);
  });

  const dot = [{ type: 4, color: 0, diameter: 30, coords: [c(0, 0)] }];

  it("places the main symbol spaced along a solid line (endLength / mainLength / nPrimSym / minSym)", () => {
    const { render } = ocadSymbolToRender(line({ mainLength: 300, endLength: 150, nPrimSym: 2, primSymDist: 40, minSym: 0, primSymElements: dot }), ctx);
    expect(render).toMatchObject({
      type: "line",
      glyphs: [{ placement: { at: "spaced", distanceUm: 3000, firstUm: 1500, lastUm: 1500, perSpot: 2, spotSpacingUm: 400, minCount: 1 }, glyph: { rotatable: true, parts: [{ kind: "disc", colour: 2, diameterUm: 300 }] } }],
    });
  });

  it("uses dash centres on dashed lines and dash-group centres when the dashes are split", () => {
    const dashed = ocadSymbolToRender(line({ mainLength: 300, mainGap: 50, nPrimSym: 1, primSymElements: dot }), ctx).render;
    expect(dashed).toMatchObject({ type: "line", glyphs: [{ placement: { at: "dashCentres" } }] });
    const split = ocadSymbolToRender(line({ mainLength: 300, secGap: 20, nPrimSym: 1, primSymElements: dot }), ctx).render;
    expect(split).toMatchObject({ type: "line", glyphs: [{ placement: { at: "dashGroupCentres" } }], main: { dash: { dashUm: 3000, gapUm: 0, secondaryGapUm: 200 } } });
  });

  it("drops the main symbol when nPrimSym is 0 (518.3 'without tag') and honours useSymbolFlags", () => {
    const none = ocadSymbolToRender(line({ mainLength: 300, nPrimSym: 0, primSymElements: dot }), ctx).render;
    expect(none && none.type === "line" ? none.glyphs : "x").toBeUndefined();
    const ends = ocadSymbolToRender(line({
      useSymbolFlags: 1 | 2 | 4, startSymElements: dot, endSymElements: dot, cornerSymElements: dot, secSymElements: dot,
    }), ctx).render;
    expect(ends && ends.type === "line" ? ends.glyphs!.map((g) => g.placement.at) : []).toEqual(["sectionCentres", "corners", "start", "end"]);
    const noFlags = ocadSymbolToRender(line({ useSymbolFlags: 0, startSymElements: dot, endSymElements: dot, cornerSymElements: dot }), ctx).render;
    expect(noFlags && noFlags.type === "line" ? noFlags.glyphs : "x").toBeUndefined();
  });

  it("is null with SYMBOL_EMPTY when nothing is drawable, and warns on unknown colours", () => {
    const empty = ocadSymbolToRender(line({ lineWidth: 0 }), ctx);
    expect(empty.render).toBeNull();
    expect(codes(empty.warnings)).toEqual(["SYMBOL_EMPTY"]);
    const unknown = ocadSymbolToRender(line({ lineColor: 42 }), ctx);
    expect(unknown.render).toBeNull();
    expect(codes(unknown.warnings)).toEqual(["SYMBOL_COLOUR_UNKNOWN", "SYMBOL_EMPTY"]);
    expect(unknown.warnings[0].message).toContain("colour 42");
  });
});

describe("ocadSymbolToRender — point", () => {
  it("converts elements into glyph parts and reads the rotatable flag", () => {
    const sym: OcadSymbolDefLike = {
      symNum: 706000, number: "706.0", type: 1, flags: 1, description: "Mål",
      elements: [
        { type: 3, color: 7, diameter: 700, lineWidth: 35, coords: [c(0, 0)] },
        { type: 3, color: 7, diameter: 500, lineWidth: 35, coords: [c(0, 0)] },
        { type: 1, flags: 1, color: 0, lineWidth: 20, coords: [c(-10, 0), c(10, 0, 1), c(20, 5, 2), c(30, 0)] },
        { type: 2, color: 0, coords: [c(0, 0), c(10, 0), c(10, 10)] },
        { type: 4, color: 0, diameter: 10, coords: [c(5, 5)] },
      ],
    };
    const { render, warnings } = ocadSymbolToRender(sym, ctx);
    expect(warnings).toEqual([]);
    expect(render).toMatchObject({ type: "point", orientation: "object", glyph: { rotatable: true } });
    const parts = render && render.type === "point" ? render.glyph.parts : [];
    expect(parts.map((p) => p.kind)).toEqual(["ring", "ring", "stroke", "fill", "disc"]);
    expect(parts[0]).toMatchObject({ colour: 3, diameterUm: 7000, widthUm: 350, cx: 0, cy: 0 });
    expect(parts[2]).toMatchObject({ colour: 2, widthUm: 200, cap: "round", join: "round" });
    expect(Array.from(parts[2].geometry!.coords)).toEqual([-100, 0, 100, 0, 200, 50, 300, 0]);
    expect(Array.from(parts[2].geometry!.flags!)).toEqual([0, 1, 2, 0]);
    expect(parts[3].geometry!.closed).toBe(true);
    expect(parts[4]).toMatchObject({ diameterUm: 100, cx: 50, cy: 50 });
  });

  it("faces north when not rotatable, and is null when no element has a known colour", () => {
    const north = ocadSymbolToRender({ symNum: 1, number: "204.0", type: 1, flags: 0, elements: [{ type: 4, color: 0, diameter: 10, coords: [c(0, 0)] }] }, ctx).render;
    expect(north).toMatchObject({ type: "point", orientation: "north", glyph: { rotatable: false } });
    const bad = ocadSymbolToRender({ symNum: 2, number: "205.0", type: 1, elements: [{ type: 4, color: 55, diameter: 10, coords: [c(0, 0)] }] }, ctx);
    expect(bad.render).toBeNull();
    expect(codes(bad.warnings)).toEqual(["SYMBOL_COLOUR_UNKNOWN", "SYMBOL_EMPTY"]);
  });
});

describe("ocadSymbolToRender — area", () => {
  const area = (over: Partial<OcadSymbolDefLike>): OcadSymbolDefLike => ({ symNum: 403000, number: "403.0", type: 3, description: "Öppen mark", ...over });

  it("maps fill, single and cross hatching (pitch = hatchDist) and the rotatable flag", () => {
    const fill = ocadSymbolToRender(area({ fillOn: true, fillColor: 7 }), ctx).render;
    expect(fill).toMatchObject({ type: "area", fill: 3 });
    expect(fill && fill.type === "area" ? [fill.hatches, fill.patterns, fill.border] : "x").toEqual([undefined, undefined, undefined]);
    const hatch = ocadSymbolToRender(area({ hatchMode: 2, hatchColor: 0, hatchLineWidth: 12, hatchDist: 60, hatchAngle1: 450, hatchAngle2: 1350, flags: 1 }), ctx).render;
    expect(hatch).toMatchObject({ type: "area", hatches: [
      { colour: 2, widthUm: 120, spacingUm: 600, angleDeg: 45, rotate: "manual" },
      { colour: 2, widthUm: 120, spacingUm: 600, angleDeg: 135, rotate: "manual" },
    ] });
    const single = ocadSymbolToRender(area({ hatchMode: 1, hatchColor: 0, hatchLineWidth: 12, hatchDist: 60, hatchAngle1: 0 }), ctx).render;
    expect(single && single.type === "area" ? single.hatches!.length : 0).toBe(1);
    expect(single).toMatchObject({ type: "area", hatches: [{ rotate: "never" }] });
  });

  it("maps structures: cell size, shifted rows, structDraw clip mode, irregular warning", () => {
    const el = [{ type: 4, color: 0, diameter: 40, coords: [c(0, 0)] }];
    const grid = ocadSymbolToRender(area({ structMode: 1, structWidth: 150, structHeight: 120, structAngle: 300, structDraw: 2, elements: el }), ctx).render;
    expect(grid).toMatchObject({ type: "area", patterns: [{ cellWidthUm: 1500, cellHeightUm: 1200, angleDeg: 30, shiftedRows: false, clip: "centreInside", rotate: "never", glyph: { parts: [{ kind: "disc" }] } }] });
    const shifted = ocadSymbolToRender(area({ structMode: 2, structWidth: 150, structHeight: 120, elements: el, structIrregularVarX: 50 }), ctx);
    expect(shifted.render).toMatchObject({ type: "area", patterns: [{ shiftedRows: true, clip: "clip" }] });
    expect(codes(shifted.warnings)).toEqual(["IRREGULAR_PATTERN_REGULARISED"]);
    const cut = ocadSymbolToRender(area({ structMode: 1, structWidth: 150, structHeight: 120, structDraw: 1, elements: el }), ctx).render;
    expect(cut).toMatchObject({ type: "area", patterns: [{ clip: "completelyInside" }] });
    const partial = ocadSymbolToRender(area({ structMode: 1, structWidth: 150, structHeight: 120, structDraw: 3, elements: el }), ctx).render;
    expect(partial).toMatchObject({ type: "area", patterns: [{ clip: "partiallyInside" }] });
  });

  it("borrows the border from the referenced line symbol, including its warnings", () => {
    table.set(524000, line({ symNum: 524000, number: "524.0", lineColor: 0, lineWidth: 18, lineStyle: 1 }));
    table.set(999000, { symNum: 999000, number: "999.0", type: 1 });
    const bordered = ocadSymbolToRender(area({ fillOn: true, fillColor: 7, borderOn: true, borderSym: 524000 }), ctx);
    expect(bordered.render).toMatchObject({ type: "area", fill: 3, border: { main: { colour: 2, widthUm: 180, cap: "round" } } });
    const notLine = ocadSymbolToRender(area({ fillOn: true, fillColor: 7, borderOn: true, borderSym: 999000 }), ctx);
    expect(codes(notLine.warnings)).toEqual(["SYMBOL_FEATURE_DROPPED"]);
    const missing = ocadSymbolToRender(area({ fillOn: true, fillColor: 7, borderOn: true, borderSym: 123 }), ctx);
    expect(codes(missing.warnings)).toEqual(["SYMBOL_FEATURE_DROPPED"]);
    expect(missing.render).toMatchObject({ type: "area", fill: 3 });
  });

  it("is null when fill is off and nothing else is drawn", () => {
    const r = ocadSymbolToRender(area({ fillOn: false, fillColor: 7 }), ctx);
    expect(r.render).toBeNull();
    expect(codes(r.warnings)).toEqual(["SYMBOL_EMPTY"]);
  });
});

describe("ocadSymbolToRender — text", () => {
  const text = (over: Partial<OcadSymbolDefLike>): OcadSymbolDefLike => ({
    symNum: 821000, number: "821.0", type: 4, description: "Text", fontName: "Arial", fontColor: 0, fontSize: 120, weight: 700, italic: true,
    charSpace: 5, wordSpace: 100, alignment: 1, lineSpace: 110, paraSpace: 20, ...over,
  });

  it("maps size (1/10 pt → µm), weight, spacing and alignment", () => {
    const { render, warnings } = ocadSymbolToRender(text({}), ctx);
    expect(warnings).toEqual([]);
    expect(render).toMatchObject({
      type: "text", fontFamily: "liberation-sans", fontSizeUm: 4233, weight: 700, italic: true, colour: 2,
      align: "centre", lineSpacing: 1.1, paragraphSpacingUm: 200, charSpacing: 0.05,
    });
    expect(render && render.type === "text" ? render.wordSpacing : "x").toBeUndefined();
    expect(ocadSymbolToRender(text({ alignment: 2 }), ctx).render).toMatchObject({ align: "right" });
    expect(ocadSymbolToRender(text({ alignment: 3 }), ctx).render).toMatchObject({ align: "justify" });
    expect(ocadSymbolToRender(text({ alignment: 0 }), ctx).render).toMatchObject({ align: "left" });
  });

  it("approximates word spacing, substitutes fonts, and warns about what it drops", () => {
    const r = ocadSymbolToRender(text({ fontName: "Verdana", wordSpace: 150, alignment: 8 | 1, frMode: 2, lbOn: true, pointSymOn: true }), ctx);
    expect(r.render).toMatchObject({ type: "text", fontFamily: "liberation-sans", align: "centre" });
    expect(r.render && r.render.type === "text" ? r.render.wordSpacing : 0).toBeCloseTo(0.139, 3);
    expect(codes(r.warnings)).toEqual(["FONT_SUBSTITUTED", "SYMBOL_FEATURE_DROPPED", "SYMBOL_FEATURE_DROPPED", "SYMBOL_FEATURE_DROPPED", "SYMBOL_FEATURE_DROPPED"]);
    expect(r.warnings.map((w) => w.message)).toEqual([
      expect.stringContaining("Verdana"),
      expect.stringContaining("vertical text alignment top"),
      expect.stringContaining("framing mode 2"),
      expect.stringContaining("line below"),
      expect.stringContaining("point symbol"),
    ]);
  });

  it("treats line text (type 6) as text and is null for unknown colours and types", () => {
    expect(ocadSymbolToRender(text({ type: 6 }), ctx).render).toMatchObject({ type: "text" });
    const bad = ocadSymbolToRender(text({ fontColor: 77 }), ctx);
    expect(bad.render).toBeNull();
    expect(codes(bad.warnings)).toEqual(["SYMBOL_COLOUR_UNKNOWN"]);
    const rect = ocadSymbolToRender({ symNum: 850001, number: "850.1", type: 7 }, ctx);
    expect(rect.render).toBeNull();
    expect(codes(rect.warnings)).toEqual(["SYMBOL_TYPE_UNSUPPORTED"]);
  });
});
