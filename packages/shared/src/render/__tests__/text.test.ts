import { describe, expect, it } from "vitest";
import { COORD_FLAG } from "../pass-stream.js";
import { pathRings } from "../path.js";
import { textSymbolSchema } from "../symbol.js";
import { PathMeasure } from "../measure.js";
import { makePath } from "../pass-stream.js";
import { emSizeUm, shapeText, shapeTextAlongPath } from "../text.js";
import { liberation } from "./fonts.js";

const cp = (s: string) => s.codePointAt(0)!;

describe("TrueTypeFont (Liberation Sans)", () => {
  const { sans, narrow } = liberation();

  it("reads the header metrics", () => {
    expect(sans.unitsPerEm).toBe(2048);
    expect(sans.ascender).toBeGreaterThan(1800);
    expect(sans.descender).toBeLessThan(-400);
    expect(narrow.unitsPerEm).toBe(2048);
  });

  it("maps codepoints and reports Arial-compatible advances", () => {
    const zero = sans.glyphId(cp("0"));
    expect(zero).toBeGreaterThan(0);
    expect(sans.advance(zero)).toBe(1139); // Arial digit advance, 2048 upm
    expect(sans.advance(sans.glyphId(cp(" ")))).toBe(569);
    expect(narrow.advance(narrow.glyphId(cp("0")))).toBeLessThan(1139);
    expect(sans.glyphId(cp("Å"))).toBeGreaterThan(0);
    expect(sans.glyphId(0x1f600)).toBe(0); // no emoji → .notdef
  });

  it("measures digit height from the outline of 0", () => {
    expect(sans.digitHeight).toBeGreaterThan(1400);
    expect(sans.digitHeight).toBeLessThan(1500);
  });

  it("has kerning pairs", () => {
    expect(sans.kerning(sans.glyphId(cp("A")), sans.glyphId(cp("V")))).toBeLessThan(0);
    expect(sans.kerning(sans.glyphId(cp("H")), sans.glyphId(cp("H")))).toBe(0);
  });

  it("extracts outlines with contours as rings and cubic segments", () => {
    const o = sans.outline(sans.glyphId(cp("O")))!;
    expect(o).toBeDefined();
    expect(o.closed).toBe(true);
    expect(pathRings(o)).toHaveLength(2);
    expect(Array.from(o.flags).some((f) => f & COORD_FLAG.bezierFirst)).toBe(true);
    const i = sans.outline(sans.glyphId(cp("I")))!;
    expect(pathRings(i)).toHaveLength(1);
    expect(Array.from(i.flags).every((f) => f === 0)).toBe(true); // straight strokes only
    const ring = sans.outline(sans.glyphId(cp("Å")))!; // composite: A + ring above
    expect(pathRings(ring).length).toBeGreaterThanOrEqual(3);
    expect(sans.outline(sans.glyphId(cp(" ")))).toBeUndefined();
  });
});

describe("shapeText", () => {
  const { sans } = liberation();
  const sym = (over: Record<string, unknown> = {}) =>
    textSymbolSchema.parse({
      type: "text", id: "t", code: "704", name: "Control number",
      fontFamily: "liberation-sans", fontSizeUm: 5000, colour: 6, ...over,
    });

  it("sizes by digit height when given", () => {
    const s = sym({ digitHeightUm: 4000 });
    expect(emSizeUm(s, sans)).toBeCloseTo((4000 * 2048) / sans.digitHeight, 6);
    expect(emSizeUm(sym(), sans)).toBe(5000);
  });

  it("advances by the font's widths and kerning, scaled to the em", () => {
    const r = shapeText("31", sym(), sans, { x: 1000, y: 2000 });
    const k = 5000 / 2048;
    expect(r.glyphs).toEqual([sans.glyphId(cp("3")), sans.glyphId(cp("1"))]);
    expect(r.positions[0]).toBe(1000);
    expect(r.positions[1]).toBe(2000);
    expect(r.positions[2]).toBeCloseTo(1000 + 1139 * k + sans.kerning(r.glyphs[0], r.glyphs[1]) * k, 6);
    expect(r.lineWidths[0]).toBeCloseTo(2 * 1139 * k + sans.kerning(r.glyphs[0], r.glyphs[1]) * k, 6);
  });

  it("aligns centre and right about the anchor", () => {
    const c = shapeText("31", sym({ align: "centre" }), sans, { x: 0, y: 0 });
    expect(c.positions[0]).toBeCloseTo(-c.lineWidths[0] / 2, 6);
    const rt = shapeText("31", sym({ align: "right" }), sans, { x: 0, y: 0 });
    expect(rt.positions[2] + 1139 * (5000 / 2048)).toBeCloseTo(0, 6);
  });

  it("does not emit space glyphs but advances past them, with word spacing", () => {
    const a = shapeText("a b", sym(), sans, { x: 0, y: 0 });
    expect(a.glyphs).toHaveLength(2);
    const k = 5000 / 2048;
    const aAdv = sans.advance(sans.glyphId(cp("a")));
    expect(a.positions[2]).toBeCloseTo((aAdv + 569) * k, 6);
    const w = shapeText("a b", sym({ wordSpacing: 0.5 }), sans, { x: 0, y: 0 });
    expect(w.positions[2] - a.positions[2]).toBeCloseTo(2500, 6);
  });

  it("breaks lines downward by lineSpacing × em", () => {
    const r = shapeText("A\nB", sym({ lineSpacing: 1.5 }), sans, { x: 0, y: 0 });
    expect(r.positions[1]).toBe(0);
    expect(r.positions[3]).toBe(-7500);
  });

  it("rotates about the anchor, and every glyph by the same angle", () => {
    const r = shapeText("AB", sym(), sans, { x: 0, y: 0, angleDeg: 90 });
    expect(r.positions[2]).toBeCloseTo(0, 3);
    expect(r.positions[3]).toBeGreaterThan(0);
    expect(r.angles).toEqual([90, 90]);
    expect(shapeText("AB", sym(), sans, { x: 0, y: 0 }).angles).toBeUndefined();
  });

  it("vertical anchor: baseline, top, bottom, middle from the font's ascender and descender", () => {
    // em 5000 µm, k = 5000 / 2048; Liberation Sans hhea ascender 1854, descender −434.
    const k = 5000 / 2048;
    const asc = 1854 * k, desc = 434 * k;
    expect(sans.ascender).toBe(1854);
    expect(sans.descender).toBe(-434);
    const y0 = (v: "baseline" | "top" | "middle" | "bottom", text = "A\nB") => shapeText(text, sym({ verticalAlign: v, lineSpacing: 1.2 }), sans, { x: 0, y: 0 }).positions[1];
    expect(y0("baseline")).toBe(0);
    expect(y0("top")).toBeCloseTo(-asc, 3);
    // Two lines: the last baseline is 6000 below the first.
    expect(y0("bottom")).toBeCloseTo(6000 + desc, 3);
    expect(y0("middle")).toBeCloseTo(-(asc - 6000 - desc) / 2, 3);
    expect(y0("middle", "A")).toBeCloseTo(-(asc - desc) / 2, 3);
  });

  it("reads the face from head.macStyle", () => {
    expect([sans.bold, sans.italic, liberation().narrow.bold]).toEqual([false, false, false]);
  });
});

describe("shapeText — tabs", () => {
  const { sans } = liberation();
  const k = 5000 / 2048;
  const sym = (over: Record<string, unknown> = {}) =>
    textSymbolSchema.parse({ type: "text", id: "t", code: "t", name: "t", fontFamily: "liberation-sans", fontSizeUm: 5000, colour: 6, ...over });

  it("a tab advances to the next custom stop from the line start and draws nothing", () => {
    const r = shapeText("1\t2", sym({ tabStops: [{ xUm: 7500 }, { xUm: 20000 }] }), sans, { x: 100, y: 0 });
    expect(r.glyphs).toEqual([sans.glyphId(cp("1")), sans.glyphId(cp("2"))]);
    expect(r.positions[2]).toBeCloseTo(100 + 7500, 6);
    const two = shapeText("1\t2\t3", sym({ tabStops: [{ xUm: 7500 }, { xUm: 20000 }] }), sans, { x: 0, y: 0 });
    expect(two.positions[4]).toBeCloseTo(20000, 6);
  });

  it("past the last stop (or with none) the next multiple of 8 space advances", () => {
    const step = 8 * 569 * k;
    const r = shapeText("1\t2", sym(), sans, { x: 0, y: 0 });
    expect(r.positions[2]).toBeCloseTo(step, 6);
    const past = shapeText("1\t2", sym({ tabStops: [{ xUm: 100 }] }), sans, { x: 0, y: 0 });
    expect(past.positions[2]).toBeCloseTo(step, 6);
    expect(r.lineWidths[0]).toBeCloseTo(step + 1139 * k, 6);
    // A stop exactly at the pen is not "beyond" it.
    const at = shapeText("\t\t2", sym({ tabStops: [{ xUm: 3000 }] }), sans, { x: 0, y: 0 });
    expect(at.positions[0]).toBeCloseTo(step, 6);
  });

  it("text without tabs shapes exactly as before (kerning across neighbours, no tab glyph)", () => {
    const a = shapeText("AV", sym(), sans, { x: 0, y: 0 });
    expect(a.positions[2]).toBeCloseTo((1366 + sans.kerning(sans.glyphId(cp("A")), sans.glyphId(cp("V")))) * k, 6);
  });
});

describe("shapeText — box text", () => {
  const { sans } = liberation();
  const em = 2048; // k = 1: advances in font units are µm
  const sym = (over: Record<string, unknown> = {}) =>
    textSymbolSchema.parse({ type: "text", id: "t", code: "t", name: "t", fontFamily: "liberation-sans", fontSizeUm: em, colour: 6, lineSpacing: 1, ...over });
  const zero = 1139, space = 569;
  const lineYs = (r: { positions: number[] }) => [...new Set(r.positions.filter((_, i) => i % 2 === 1).map((v) => Math.round(v)))];

  it("wraps at spaces when the next word's ink would cross the box width", () => {
    // "00 00 00": each word 2278 wide; two words + space = 5125.
    const r = shapeText("00 00 00", sym(), sans, { x: 0, y: 0, box: { widthUm: 5200, heightUm: 9000 } });
    expect(r.lineWidths.map(Math.round)).toEqual([2 * zero * 2 + space, 2 * zero]);
    expect(lineYs(r)).toEqual([-1854, -1854 - em]);
    expect(r.glyphs).toHaveLength(6);
  });

  it("a word wider than the box breaks per glyph", () => {
    const r = shapeText("0000", sym(), sans, { x: 0, y: 0, box: { widthUm: 2500, heightUm: 9000 } });
    expect(r.lineWidths.map(Math.round)).toEqual([2 * zero, 2 * zero]);
    // A box narrower than one glyph still makes progress.
    expect(shapeText("00", sym(), sans, { x: 0, y: 0, box: { widthUm: 10, heightUm: 9000 } }).lineWidths).toHaveLength(2);
  });

  it("an explicit break is a paragraph: paragraphSpacingUm is added between paragraphs only", () => {
    const r = shapeText("00 00\n0", sym({ paragraphSpacingUm: 500 }), sans, { x: 0, y: 0, box: { widthUm: 2500, heightUm: 9000 } });
    expect(lineYs(r)).toEqual([-1854, -1854 - em, -1854 - 2 * em - 500]);
    // Anchor text ignores paragraph spacing, as before.
    const a = shapeText("0\n0", sym({ paragraphSpacingUm: 500 }), sans, { x: 0, y: 0 });
    expect(lineYs(a)).toEqual([0, -em]);
  });

  it("aligns inside the box width; justify stretches spaces on every line but a paragraph's last", () => {
    const box = { widthUm: 6000, heightUm: 9000 };
    expect(shapeText("0", sym({ align: "right" }), sans, { x: 0, y: 0, box }).positions[0]).toBeCloseTo(6000 - zero, 6);
    expect(shapeText("0", sym({ align: "centre" }), sans, { x: 0, y: 0, box }).positions[0]).toBeCloseTo((6000 - zero) / 2, 6);
    const j = shapeText("0 0 0 00 0", sym({ align: "justify" }), sans, { x: 0, y: 0, box });
    // Line 1 "0 0 0" is stretched to the box; the last line "00 0" is left.
    expect(j.lineWidths[0]).toBeCloseTo(6000, 6);
    expect(j.positions[4] + zero).toBeCloseTo(6000, 6);
    expect(j.lineWidths[1]).toBeCloseTo(3 * zero + space, 6);
    // Anchor text: justify = left.
    expect(shapeText("0 0", sym({ align: "justify" }), sans, { x: 0, y: 0 }).positions[2]).toBeCloseTo(zero + space, 6);
  });

  it("vertical placement in the box: top (and baseline) hangs from the top edge, middle centres, bottom sits on the bottom", () => {
    const box = { widthUm: 9000, heightUm: 10000 };
    const asc = 1854, desc = 434;
    const y = (v?: string) => shapeText("0\n0", sym(v ? { verticalAlign: v } : {}), sans, { x: 0, y: 0, box }).positions[1];
    expect(y()).toBe(-asc);
    expect(y("baseline")).toBe(-asc);
    expect(y("top")).toBe(-asc);
    const block = asc + em + desc;
    expect(y("bottom")).toBeCloseTo(-(10000 - block + asc), 6);
    expect(y("middle")).toBeCloseTo(-((10000 - block) / 2 + asc), 6);
  });

  it("turns with the object angle about the box's top-left corner", () => {
    const r = shapeText("0", sym(), sans, { x: 1000, y: 2000, angleDeg: 90, box: { widthUm: 9000, heightUm: 9000 } });
    expect(r.positions[0]).toBeCloseTo(1000 + 1854, 3);
    expect(r.positions[1]).toBeCloseTo(2000, 3);
    expect(r.angles).toEqual([90]);
  });

  it("extent: the box width (box text) or the widest line, digit height of the first line down to the last baseline", () => {
    const b = shapeText("0\n0", sym(), sans, { x: 0, y: 0, box: { widthUm: 9000, heightUm: 9000 } });
    expect(b.extent![0]).toBe(0);
    expect(b.extent![2]).toBe(9000);
    expect(b.extent![3]).toBeCloseTo(-1854 + sans.digitHeight, 6);
    expect(b.extent![1]).toBeCloseTo(-1854 - em, 6);
    const a = shapeText("00\n0", sym({ align: "centre" }), sans, { x: 0, y: 0 });
    expect(a.extent![0]).toBeCloseTo(-zero, 6);
    expect(a.extent![2]).toBeCloseTo(zero, 6);
    expect(a.extent![3]).toBeCloseTo(sans.digitHeight, 6);
    expect(a.extent![1]).toBe(-em);
  });
});

describe("shapeTextAlongPath — line text", () => {
  const { sans } = liberation();
  const sym = (over: Record<string, unknown> = {}) =>
    textSymbolSchema.parse({ type: "text", id: "t", code: "t", name: "t", fontFamily: "liberation-sans", fontSizeUm: 2048, colour: 6, ...over });
  const zero = 1139;
  const along = (text: string, coords: number[], over: Record<string, unknown> = {}) =>
    shapeTextAlongPath(text, sym(over), sans, new PathMeasure(makePath(coords)));

  it("on a straight path: origins at the pen positions, every angle the path's", () => {
    const r = along("000", [0, 0, 10000, 0]);
    expect(r.positions.map(Math.round)).toEqual([0, 0, zero, 0, 2 * zero, 0]);
    expect(r.angles).toEqual([0, 0, 0]);
    const up = along("00", [0, 0, 0, 10000]);
    expect(up.angles!.map(Math.round)).toEqual([90, 90]);
    expect(up.positions.map(Math.round)).toEqual([0, 0, 0, zero]);
  });

  it("around a corner each glyph turns to the chord from its origin to one advance on", () => {
    const r = along("0000", [0, 0, 1500, 0, 1500, 10000]);
    expect(r.angles![0]).toBe(0);
    // Glyph 1 starts at 1139 (on the first leg) and ends 1139 further, round the corner: (1500, 778).
    expect(r.angles![1]).toBeCloseTo((Math.atan2(2 * zero - 1500, 1500 - zero) * 180) / Math.PI, 3);
    expect(r.angles![2]).toBeCloseTo(90, 6);
    expect(r.positions[4]).toBeCloseTo(1500, 3);
    expect(r.positions[5]).toBeCloseTo(2 * zero - 1500, 3);
  });

  it("left keeps the glyph that crosses the end; right drops it; centre centres without it", () => {
    const L = 2 * zero + 500;
    expect(along("0000", [0, 0, L, 0]).glyphs).toHaveLength(3);
    const right = along("0000", [0, 0, L, 0], { align: "right" });
    expect(right.glyphs).toHaveLength(2);
    expect(right.positions[0]).toBeCloseTo(500, 3);
    const centre = along("0000", [0, 0, L, 0], { align: "centre" });
    expect(centre.glyphs).toHaveLength(3);
    expect(centre.positions[0]).toBeCloseTo(250, 3);
    const fits = along("00", [0, 0, 10000, 0], { align: "centre" });
    expect(fits.positions[0]).toBeCloseTo((10000 - 2 * zero) / 2, 3);
  });

  it("justify spreads the glyphs over the whole path", () => {
    const r = along("000", [0, 0, 10000, 0], { align: "justify" });
    expect(r.positions[4] + zero).toBeCloseTo(10000, 3);
    expect(r.positions[2]).toBeCloseTo((10000 - zero) / 2, 3);
  });

  it("vertical alignment moves the baseline across the path, turned with the glyph", () => {
    const y = (v: string) => along("0", [0, 0, 10000, 0], { verticalAlign: v }).positions[1];
    expect(y("baseline")).toBe(0);
    expect(y("top")).toBeCloseTo(-sans.digitHeight, 3);
    expect(y("middle")).toBeCloseTo(-sans.digitHeight / 2, 3);
    expect(y("bottom")).toBeCloseTo(434, 3);
    const up = along("0", [0, 0, 0, 10000], { verticalAlign: "top" });
    expect(up.positions[0]).toBeCloseTo(sans.digitHeight, 3);
  });

  it("line breaks and tabs read as spaces; spaces advance and draw nothing; no extent", () => {
    const r = along("0\n0", [0, 0, 10000, 0]);
    expect(r.glyphs).toHaveLength(2);
    expect(r.positions[2]).toBeCloseTo(zero + 569, 3);
    expect(r.extent).toBeUndefined();
    expect(along("0", [0, 0, 0, 0]).glyphs).toEqual([]);
  });
});
