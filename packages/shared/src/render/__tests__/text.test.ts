import { describe, expect, it } from "vitest";
import { COORD_FLAG } from "../pass-stream.js";
import { pathRings } from "../path.js";
import { textSymbolSchema } from "../symbol.js";
import { emSizeUm, shapeText } from "../text.js";
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

  it("rotates about the anchor", () => {
    const r = shapeText("AB", sym(), sans, { x: 0, y: 0, angleDeg: 90 });
    expect(r.positions[2]).toBeCloseTo(0, 3);
    expect(r.positions[3]).toBeGreaterThan(0);
  });
});
