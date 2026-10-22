import { describe, expect, it } from "vitest";
import { COORD_FLAG } from "../../render/pass-stream.js";
import type { AreaSymbol, LineSymbol, PointSymbol, TextSymbol } from "../../render/symbol.js";
import { OMAP_FLAG, symbolFromElement, type OmapCoord, type OmapLineBody, type OmapSymbol } from "../omap-reader.js";
import { dashPointRule, omapFlags, omapGoverningLine, omapSymbolKind, omapSymbolToRender } from "../omap-symbols.js";
import { parseXmlTree } from "../xml.js";

const sym = (xml: string): OmapSymbol => symbolFromElement(parseXmlTree(xml));
/** Colour priorities 0..9 map to stack indices 9..0 (priority 0 is drawn last). */
const ctx = (table: OmapSymbol[] = []) => ({
  colourIndex: (p: number) => (p >= 0 && p < 10 ? 9 - p : undefined),
  symbolById: (id: number) => table[id],
});
const convert = (s: OmapSymbol, table: OmapSymbol[] = []) => omapSymbolToRender(s, ctx(table));

const POINT = `<symbol type="1" id="0" code="101" name="Dot"><point_symbol rotatable="true" inner_radius="300" inner_color="0" outer_width="100" outer_color="2" elements="2">
<element><symbol type="2" code=""><line_symbol color="1" line_width="140" join_style="2" cap_style="1"/></symbol><object type="1"><coords count="4">-500 0 1;-200 300;200 300;500 0;</coords></object></element>
<element><symbol type="4" code=""><area_symbol inner_color="3" min_area="0" patterns="0"/></symbol><object type="1"><coords count="4">0 0;100 0;100 100;0 0 2;</coords></object></element>
</point_symbol></symbol>`;

const LINE = `<symbol type="2" id="1" code="502" name="Road"><line_symbol color="0" line_width="300" minimum_length="500" join_style="2" cap_style="1" start_offset="100" end_offset="200" dashed="true" dash_length="2000" break_length="500" dashes_in_group="2" in_group_break_length="200" half_outer_dashes="true" show_at_least_one_symbol="true" mid_symbols_per_spot="1" mid_symbol_distance="0" mid_symbol_placement="2" suppress_dash_symbol_at_ends="true" scale_dash_symbol="true">
<mid_symbol><symbol type="1" code=""><point_symbol rotatable="true" inner_radius="100" inner_color="0" outer_width="0" outer_color="-1" elements="0"/></symbol></mid_symbol>
<dash_symbol><symbol type="1" code=""><point_symbol inner_radius="150" inner_color="0" outer_width="0" outer_color="-1" elements="0"/></symbol></dash_symbol>
<start_symbol><symbol type="1" code=""><point_symbol inner_radius="50" inner_color="0" outer_width="0" outer_color="-1" elements="0"/></symbol></start_symbol>
<borders borders_different="true"><border color="0" width="140" shift="70"/><border color="2" width="100" shift="50" dashed="true" dash_length="1000" break_length="300"/></borders>
</line_symbol></symbol>`;

const AREA = `<symbol type="4" id="2" code="403" name="Open" is_hidden="true"><area_symbol inner_color="2" min_area="1000" patterns="2">
<pattern type="1" angle="0.785398" no_clipping="0" line_spacing="800" line_offset="50" offset_along_line="0" color="0" line_width="250"/>
<pattern type="2" angle="1.5708" no_clipping="2" rotatable="true" line_spacing="700" line_offset="10" offset_along_line="350" point_distance="600"><symbol type="1" code=""><point_symbol inner_radius="200" inner_color="0" outer_width="0" outer_color="-1" elements="0"/></symbol></pattern>
</area_symbol></symbol>`;

const TEXT = `<symbol type="8" id="3" code="701" name="Text"><text_symbol icon_text="A" rotatable="true"><font family="Arial" size="4000" bold="true"/><text color="0" line_spacing="1.1" paragraph_spacing="500" character_spacing="0.05" kerning="true"/><framing color="2" mode="1" line_half_width="100" shadow_x_offset="200" shadow_y_offset="200"/></text_symbol></symbol>`;

describe("omapFlags", () => {
  const c = (flags: number): OmapCoord => ({ x: 0, y: 0, flags });
  it("moves curve starts onto the two control points and hole points onto the next ring start", () => {
    expect(omapFlags([c(OMAP_FLAG.curveStart), c(0), c(0), c(OMAP_FLAG.holePoint | OMAP_FLAG.closePoint), c(0)], "corner")).toEqual([
      0, COORD_FLAG.bezierFirst, COORD_FLAG.bezierSecond, 0, COORD_FLAG.hole,
    ]);
  });
  it("maps dash points per the rule and gap points to the gap flag; drops close points", () => {
    expect(omapFlags([c(OMAP_FLAG.dashPoint), c(OMAP_FLAG.gapPoint), c(OMAP_FLAG.closePoint)], "dash")).toEqual([COORD_FLAG.dash, COORD_FLAG.gap, 0]);
    expect(omapFlags([c(OMAP_FLAG.dashPoint)], "corner")).toEqual([COORD_FLAG.corner]);
  });
  it("dash-point rule: dash only for dashed lines without a dash symbol", () => {
    const dashedNoSym = { ...(sym(LINE).body as OmapLineBody), dashSymbol: undefined };
    expect(dashPointRule(dashedNoSym)).toBe("dash");
    expect(dashPointRule(sym(LINE).body as OmapLineBody)).toBe("corner");
    expect(dashPointRule({ ...dashedNoSym, dashed: false })).toBe("corner");
    expect(dashPointRule(undefined)).toBe("corner");
  });
});

describe("omapSymbolToRender", () => {
  it("point: disc, ring (outer diameter), element stroke / fill with y flipped and flags converted", () => {
    const { render, warnings } = convert(sym(POINT));
    expect(warnings).toEqual([]);
    const p = render as PointSymbol;
    expect(p.type).toBe("point");
    expect(p.id).toBe("src:0");
    expect(p.orientation).toBe("object");
    expect(p.glyph.rotatable).toBe(true);
    expect(p.glyph.parts[0]).toEqual({ kind: "disc", colour: 9, diameterUm: 600 });
    expect(p.glyph.parts[1]).toEqual({ kind: "ring", colour: 7, diameterUm: 800, widthUm: 100 });
    expect(p.glyph.parts[2]).toMatchObject({ kind: "stroke", colour: 8, widthUm: 140, cap: "round", join: "round" });
    expect(p.glyph.parts[2].geometry).toEqual({ coords: [-500, 0, -200, -300, 200, -300, 500, 0], flags: [0, COORD_FLAG.bezierFirst, COORD_FLAG.bezierSecond, 0] });
    expect(p.glyph.parts[3]).toMatchObject({ kind: "fill", colour: 6, geometry: { coords: [0, 0, 100, 0, 100, -100, 0, 0], flags: [0, 0, 0, 0], closed: true } });
  });

  it("line: omap dash layout, borders centred at w/2 + shift, mid / dash / start glyphs, offsets", () => {
    const { render, warnings } = convert(sym(LINE));
    expect(warnings).toEqual([]);
    const l = render as LineSymbol;
    expect(l.type).toBe("line");
    expect(l.minimum).toEqual({ lengthUm: 500 });
    expect(l.main).toMatchObject({
      colour: 9, widthUm: 300, cap: "round", join: "round", shortenStartUm: 100, shortenEndUm: 200,
      dash: { layout: "omap", dashUm: 2000, gapUm: 500, dashesInGroup: 2, secondaryGapUm: 200, halfOuterDashes: true, showAtLeastOne: true },
    });
    expect(l.borders).toEqual({
      left: { colour: 9, widthUm: 140, shiftUm: 220 },
      right: { colour: 7, widthUm: 100, shiftUm: 200, dash: { layout: "omap", dashUm: 1000, gapUm: 300 } },
    });
    expect(l.glyphs!.map((g) => g.placement)).toEqual([{ at: "gapCentres" }, { at: "corners", ignoreEnds: true }, { at: "start" }]);
    expect(l.glyphs![1].scaleAtCorners).toBe(true);
    expect(l.glyphs![0].glyph.rotatable).toBe(true);
    expect(l.glyphs![1].glyph.rotatable).toBe(false);
  });

  it("point: nested point elements become discs / rings centred on the element coordinate (finish double ring)", () => {
    const s = sym(`<symbol type="1" id="0" code="706" name="Finish"><point_symbol rotatable="false" inner_radius="3325" inner_color="-1" outer_width="350" outer_color="0" elements="1"><element><symbol type="1" code=""><point_symbol inner_radius="2325" inner_color="-1" outer_width="350" outer_color="0" elements="1"><element><symbol type="1" code=""><point_symbol inner_radius="100" inner_color="1" outer_width="0" outer_color="-1" elements="0"/></symbol><object type="0"><coords count="1">500 -700;</coords></object></element></point_symbol></symbol><object type="0"><coords count="1">0 0;</coords></object></element></point_symbol></symbol>`);
    const { render, warnings } = convert(s);
    expect(warnings).toEqual([]);
    const p = render as PointSymbol;
    expect(p.glyph.parts).toEqual([
      { kind: "ring", colour: 9, diameterUm: 7350, widthUm: 350 },
      { kind: "ring", colour: 9, diameterUm: 5350, widthUm: 350 },
      { kind: "disc", colour: 8, diameterUm: 200, cx: 500, cy: 700 },
    ]);
  });

  it("line: undashed mid symbols are spaced with end lengths, per-spot count and minimum counts", () => {
    const s = sym(`<symbol type="2" id="1" code="516" name="Fence"><line_symbol color="0" line_width="140" join_style="1" cap_style="0" segment_length="3000" end_length="1500" show_at_least_one_symbol="true" minimum_mid_symbol_count="0" minimum_mid_symbol_count_when_closed="2" mid_symbols_per_spot="2" mid_symbol_distance="400"><mid_symbol><symbol type="1" code=""><point_symbol rotatable="true" inner_radius="0" inner_color="-1" outer_width="0" outer_color="-1" elements="1"><element><symbol type="2" code=""><line_symbol color="0" line_width="140"/></symbol><object type="1"><coords count="2">0 0;0 -400;</coords></object></element></point_symbol></symbol></mid_symbol></line_symbol></symbol>`);
    const l = convert(s).render as LineSymbol;
    expect(l.glyphs![0].placement).toEqual({ at: "spaced", distanceUm: 3000, firstUm: 1500, lastUm: 1500, perSpot: 2, spotSpacingUm: 400, minCount: 1, minCountClosed: 2 });
    expect(l.glyphs![0].glyph.parts[0].geometry!.coords).toEqual([0, 0, 0, 400]);
  });

  it("line: pointed caps taper over start_offset / end_offset and keep the full length; invisible lines are empty", () => {
    // Mapper's LineSymbol: on a pointed cap the offsets are the cap lengths. It also writes pointed_cap_length (OOM ISOM 106: 747 ×3).
    const line106 = (attrs: string) => convert(sym(`<symbol type="2" id="1" code="106" name="Earth wall"><line_symbol color="0" line_width="250" cap_style="3" ${attrs}/></symbol>`)).render as LineSymbol;
    const l = line106(`pointed_cap_length="747" start_offset="747" end_offset="747"`);
    expect(l.main).toMatchObject({ cap: "pointed", widthUm: 250, taper: { startUm: 747, endUm: 747 } });
    expect([l.main!.shortenStartUm, l.main!.shortenEndUm]).toEqual([undefined, undefined]);
    expect(line106(`start_offset="500" end_offset="0"`).main!.taper).toEqual({ startUm: 500 });
    // A file with only pointed_cap_length (offsets 0): both ends.
    expect(line106(`pointed_cap_length="600"`).main!.taper).toEqual({ startUm: 600, endUm: 600 });
    expect(line106(``).main!.taper).toBeUndefined();
    const r = convert(sym(`<symbol type="2" id="1" code="x" name="n"><line_symbol color="-1" line_width="0"/></symbol>`));
    expect(r.render).toBeNull();
    expect(r.warnings.map((w) => w.code)).toEqual(["SYMBOL_EMPTY"]);
  });

  it("area: fill, hatch angle in degrees, point pattern cell = point distance × line spacing, clipping", () => {
    const { render, warnings } = convert(sym(AREA));
    expect(warnings).toEqual([]);
    const a = render as AreaSymbol;
    expect(a.type).toBe("area");
    expect(a.fill).toBe(7);
    expect(a.minimum).toEqual({ areaUm2: 1000 });
    expect(a.hatches).toHaveLength(1);
    expect(a.hatches![0]).toMatchObject({ colour: 9, widthUm: 250, spacingUm: 800, offsetUm: 50, rotate: "never" });
    expect(a.hatches![0].angleDeg).toBeCloseTo(45, 3);
    expect(a.patterns![0]).toMatchObject({ cellWidthUm: 600, cellHeightUm: 700, offsetXUm: 350, offsetYUm: 10, shiftedRows: false, clip: "centreInside", rotate: "manual" });
    expect(a.patterns![0].angleDeg).toBeCloseTo(90, 2);
    expect(a.patterns![0].glyph.parts[0]).toEqual({ kind: "disc", colour: 9, diameterUm: 400 });
  });

  it("text: em size, bold weight, framing line → halo, shadow framing → shadow (y flipped), font substitution noted", () => {
    const { render, warnings } = convert(sym(TEXT));
    expect(warnings).toEqual([]);
    const t = render as TextSymbol;
    expect(t).toMatchObject({ type: "text", fontFamily: "liberation-sans", fontSizeUm: 4000, weight: 700, italic: false, colour: 9, align: "left", lineSpacing: 1.1, paragraphSpacingUm: 500, charSpacing: 0.05, halo: { colour: 7, widthUm: 100 } });
    const r = convert(sym(`<symbol type="8" id="3" code="702" name="T"><text_symbol><font family="Sans Serif" size="3000" underline="true"/><text color="0" line_spacing="1"/><framing color="1" mode="2" shadow_x_offset="100" shadow_y_offset="100"/></text_symbol></symbol>`));
    expect(r.warnings.map((w) => w.message)).toEqual(['702: font "Sans Serif" drawn with liberation-sans', "702: underline"]);
    expect((r.render as TextSymbol).halo).toBeUndefined();
    // Mapper's offsets are y-down; the IR's are y-up (the user's Nackareservatet .omap: 100 / -100 = right and down).
    expect((r.render as TextSymbol).shadow).toEqual({ colour: 8, offsetXUm: 100, offsetYUm: -100 });
    const still = convert(sym(`<symbol type="8" id="3" code="702" name="T"><text_symbol><font family="Arial" size="3000"/><text color="0"/><framing color="1" mode="2" shadow_x_offset="0" shadow_y_offset="0"/></text_symbol></symbol>`));
    expect(still.warnings).toEqual([]);
    expect((still.render as TextSymbol).shadow).toBeUndefined();
  });

  it("reports unknown colours once per use and drops the feature", () => {
    const r = convert(sym(`<symbol type="2" id="1" code="x" name="n"><line_symbol color="42" line_width="100"/></symbol>`));
    expect(r.render).toBeNull();
    expect(r.warnings.map((w) => w.code)).toEqual(["SYMBOL_COLOUR_UNKNOWN", "SYMBOL_EMPTY"]);
  });

  describe("combined symbols", () => {
    const table: OmapSymbol[] = [
      sym(`<symbol type="4" id="0" code="301.1" name="Water"><area_symbol inner_color="5" min_area="0" patterns="0"/></symbol>`),
      sym(`<symbol type="2" id="1" code="301.4" name="Bank"><line_symbol color="0" line_width="180" join_style="1" cap_style="0"/></symbol>`),
      sym(`<symbol type="16" id="2" code="301" name="Lake"><combined_symbol parts="2"><part symbol="0"/><part symbol="1"/></combined_symbol></symbol>`),
      sym(`<symbol type="2" id="3" code="508" name="Ride"><line_symbol color="0" line_width="140" dashed="true" dash_length="2000" break_length="250"/></symbol>`),
      sym(`<symbol type="16" id="4" code="508.1" name="Ride, easy"><combined_symbol parts="2"><part symbol="3"/><part private="true"><symbol type="2" code=""><line_symbol color="4" line_width="450"/></symbol></part></combined_symbol></symbol>`),
      sym(`<symbol type="16" id="5" code="509" name="Railway"><combined_symbol parts="2"><part private="true"><symbol type="2" code=""><line_symbol color="0" line_width="350" dashed="true" dash_length="1500" break_length="1000"/></symbol></part><part private="true"><symbol type="2" code=""><line_symbol color="3" line_width="350"><borders><border color="0" width="100" shift="0"/></borders></line_symbol></symbol></part></combined_symbol></symbol>`),
      sym(`<symbol type="16" id="6" code="502.2" name="Dual carriageway"><combined_symbol parts="2"><part private="true"><symbol type="2" code=""><line_symbol color="2" line_width="780"><borders><border color="3" width="140" shift="70"/></borders></line_symbol></symbol></part><part private="true"><symbol type="2" code=""><line_symbol color="2" line_width="140"><borders><border color="0" width="320" shift="160"/></borders></line_symbol></symbol></part></combined_symbol></symbol>`),
      sym(`<symbol type="2" id="7" code="511.1" name="Power line"><line_symbol color="-1" line_width="1340"><dash_symbol><symbol type="1" code=""><point_symbol inner_radius="100" inner_color="0" outer_width="0" outer_color="-1" elements="0"/></symbol></dash_symbol><borders><border color="0" width="140" shift="0"/></borders></line_symbol></symbol>`),
      sym(`<symbol type="16" id="8" code="511.2" name="Major power line"><combined_symbol parts="2"><part symbol="7"/><part private="true"><symbol type="2" code=""><line_symbol color="-1" line_width="0"><dash_symbol><symbol type="1" code=""><point_symbol inner_radius="300" inner_color="0" outer_width="0" outer_color="-1" elements="0"/></symbol></dash_symbol></line_symbol></symbol></part></combined_symbol></symbol>`),
      sym(`<symbol type="16" id="9" code="412" name="Cultivated"><combined_symbol parts="3"><part symbol="0"/><part private="true"><symbol type="4" code=""><area_symbol inner_color="-1" min_area="0" patterns="1"><pattern type="2" angle="0" line_spacing="800" point_distance="800"><symbol type="1" code=""><point_symbol inner_radius="100" inner_color="0" outer_width="0" outer_color="-1" elements="0"/></symbol></pattern></area_symbol></symbol></part><part private="true"><symbol type="1" code=""><point_symbol inner_radius="100" inner_color="0" outer_width="0" outer_color="-1" elements="0"/></symbol></part></combined_symbol></symbol>`),
      sym(`<symbol type="16" id="10" code="bad" name="Bad"><combined_symbol parts="3"><part symbol="10"/><part symbol="99"/><part/></combined_symbol></symbol>`),
    ];

    it("area + line → area with the line as its border", () => {
      const r = convert(table[2], table);
      expect(r.warnings).toEqual([]);
      const a = r.render as AreaSymbol;
      expect(a).toMatchObject({ type: "area", id: "src:2", code: "301", fill: 4 });
      expect(a.border!.main).toMatchObject({ colour: 9, widthUm: 180 });
    });

    it("dashed line + wider solid line → continuous halo (508.x rides)", () => {
      const r = convert(table[4], table);
      expect(r.warnings).toEqual([]);
      const l = r.render as LineSymbol;
      expect(l.main).toMatchObject({ colour: 9, widthUm: 140, dash: { dashUm: 2000 }, halo: { colour: 5, widthUm: 155, continuous: true } });
    });

    it("dashed line + bordered solid line → borders with a background band (509 railway)", () => {
      const r = convert(table[5], table);
      expect(r.warnings).toEqual([]);
      const l = r.render as LineSymbol;
      expect(l.main).toMatchObject({ colour: 9, widthUm: 350, dash: { dashUm: 1500, gapUm: 1000 } });
      expect(l.borders).toEqual({ left: { colour: 9, widthUm: 100, shiftUm: 175 }, right: { colour: 9, widthUm: 100, shiftUm: 175 }, backgroundColour: 6, backgroundWidthUm: 350 });
    });

    it("two bordered solid lines → narrowest is main, wider becomes the halo, its borders a second pair (502.2)", () => {
      const r = convert(table[6], table);
      expect(r.warnings).toEqual([]);
      const l = r.render as LineSymbol;
      expect(l.main).toMatchObject({ colour: 7, widthUm: 140, halo: { colour: 7, widthUm: 320, continuous: true } });
      expect(l.borders).toEqual({
        left: { colour: 9, widthUm: 320, shiftUm: 230 }, right: { colour: 9, widthUm: 320, shiftUm: 230 },
        extraPairs: [{ left: { colour: 6, widthUm: 140, shiftUm: 460 }, right: { colour: 6, widthUm: 140, shiftUm: 460 } }],
      });
    });

    it("glyph-only parts append their glyphs (511.2 power line)", () => {
      const r = convert(table[8], table);
      expect(r.warnings).toEqual([]);
      const l = r.render as LineSymbol;
      expect(l.main).toBeUndefined();
      expect(l.borders!.left!.shiftUm).toBe(670);
      expect(l.glyphs!.map((g) => g.glyph.parts[0].diameterUm)).toEqual([200, 600]);
    });

    it("area + area merges fills and patterns; point parts are dropped with a warning (412)", () => {
      const r = convert(table[9], table);
      const a = r.render as AreaSymbol;
      expect(a.fill).toBe(4);
      expect(a.patterns).toHaveLength(1);
      expect(r.warnings).toEqual([{ code: "SYMBOL_FEATURE_DROPPED", message: "412: point part of combined symbol" }]);
    });

    it("self references, missing references and empty parts are reported", () => {
      const r = convert(table[10], table);
      expect(r.render).toBeNull();
      expect(r.warnings.map((w) => w.message)).toEqual([
        "bad: combined symbol references itself",
        "bad: combined part references missing symbol 99",
        "bad: combined symbol draws nothing",
      ]);
      expect(r.warnings.map((w) => w.code)).toEqual(["SYMBOL_REFERENCE_INVALID", "SYMBOL_REFERENCE_INVALID", "SYMBOL_EMPTY"]);
    });

    it("kind and governing line follow the parts", () => {
      const byId = (id: number) => table[id];
      expect(omapSymbolKind(table[2], byId)).toBe("area");
      expect(omapSymbolKind(table[4], byId)).toBe("line");
      expect(omapSymbolKind(table[9], byId)).toBe("area");
      expect(omapSymbolKind(table[0], byId)).toBe("area");
      expect(omapSymbolKind(table[10], byId)).toBeUndefined();
      expect(omapGoverningLine(table[4], byId)?.dashed).toBe(true);
      expect(omapGoverningLine(table[5], byId)?.dashLength).toBe(1500);
      expect(omapGoverningLine(table[6], byId)?.lineWidth).toBe(780);
      expect(omapGoverningLine(table[0], byId)).toBeUndefined();
    });
  });
});
