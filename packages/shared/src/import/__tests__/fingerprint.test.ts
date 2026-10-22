/**
 * Geometric fingerprints (03 §6.5): a symbol compared with itself scores 1,
 * related variants score below the auto threshold, structurally different
 * symbols hard-fail, and the document factor scales the comparison.
 */

import { describe, expect, it } from "vitest";
import { type LineSymbol, type PointSymbol, type RenderSymbol, parseRenderSymbol } from "../../render/symbol.js";
import { scaleRenderSymbol } from "../../render/transform.js";
import { getLibraryEntry, getSymbolLibrary } from "../../symbol-library/index.js";
import { paletteIndex, paletteStack } from "../../symbol-library/palette.js";
import { resolveEntry } from "../../symbol-library/schema.js";
import { paletteClass } from "../colour-class.js";
import { compareFingerprints, fingerprintHash, fingerprintOf, glyphBox, TOLERANCE } from "../fingerprint.js";
import { MATCH_THRESHOLDS } from "../matcher.js";

const lib = getSymbolLibrary("ISOM2017-2");
const idx = paletteIndex("iof2024", lib.spec);
const stack = paletteStack("iof2024", lib.spec);
const classOf = (i: number) => paletteClass(stack[i].id.replace(/^[^:]+:/, ""), "iof2024");
const render = (id: string): RenderSymbol => resolveEntry(getLibraryEntry(id)!, idx);
const fp = (id: string) => fingerprintOf(render(id), classOf);
const score = (a: string, b: string, factor = 1) => compareFingerprints(fp(a), fp(b), factor);

describe("fingerprintOf", () => {
  it("measures glyph extents from discs, rings and strokes", () => {
    const boulder = render("ISOM2017-2:204") as PointSymbol;
    expect(glyphBox(boulder.glyph)).toEqual({ w: 400, h: 400 });
    const control = render("ISOM2017-2:703") as PointSymbol;
    expect(glyphBox(control.glyph)).toEqual({ w: 5350, h: 5350 });
  });

  it("takes the main colour of glyph-only and border-only lines from the glyph / border", () => {
    const dotted = fp("ISOM2017-2:416"); // dotted vegetation boundary: no main stroke
    expect(dotted.type === "line" && dotted.mainClass).toEqual({ hue: "black", percent: 100 });
    const trench = fp("ISOM2017-2:215"); // two border strokes only
    expect(trench.type === "line" && trench.mainClass).toEqual({ hue: "black", percent: 100 });
  });

  it("reads a double line's infill as the main stroke, however it is stated", () => {
    const road = fp("ISOM2017-2:502"); // borders + backgroundColour in the library
    expect(road.type === "line" && road.mainClass).toEqual({ hue: "brown", percent: 50 });
    expect(road.type === "line" && road.mainWidth).toBe(300); // 2 × 220 − 140
    const stated = parseRenderSymbol({ type: "line", id: "x", code: "502", name: "x", main: { colour: idx.get("brown50-road")!, widthUm: 300 }, borders: { left: { colour: idx.get("black-road-outline")!, widthUm: 140, shiftUm: 220 }, right: { colour: idx.get("black-road-outline")!, widthUm: 140, shiftUm: 220 } } }) as LineSymbol;
    expect(compareFingerprints(fingerprintOf(stated, classOf), road).score).toBe(1);
  });

  it("ignores white knock-outs when choosing a point's colour and knows when orientation is moot", () => {
    const tree = fp("ISOM2017-2:418"); // green dot with a white dot inside
    expect(tree.type === "point" && tree.dominantClass).toEqual({ hue: "green", percent: 100 });
    expect(tree.type === "point" && tree.symmetric).toBe(true);
    const pit = fp("ISOM2017-2:112");
    expect(pit.type === "point" && pit.symmetric).toBe(false);
  });
});

describe("compareFingerprints", () => {
  it("scores a symbol against itself at 1", () => {
    for (const e of lib.entries) {
      const f = fingerprintOf(resolveEntry(e, idx), classOf);
      expect(compareFingerprints(f, f).score, e.id).toBe(1);
    }
  });

  it("keeps variants of the same family below the auto threshold", () => {
    expect(score("ISOM2017-2:202", "ISOM2017-2:202.b").score).toBeLessThan(MATCH_THRESHOLDS.auto); // cliff with / without tags
    expect(score("ISOM2017-2:505", "ISOM2017-2:506").score).toBeLessThan(MATCH_THRESHOLDS.auto); // footpath vs small footpath
    expect(score("ISOM2017-2:101", "ISOM2017-2:102").score).toBeLessThan(MATCH_THRESHOLDS.auto); // contour vs index contour
    expect(score("ISOM2017-2:204", "ISOM2017-2:205").score).toBeLessThan(MATCH_THRESHOLDS.auto); // boulder vs large boulder
  });

  it("hard-fails on type, colour class, dash and fill structure", () => {
    expect(score("ISOM2017-2:521", "ISOM2017-2:505").hardFail).toMatch(/type/);
    expect(score("ISOM2017-2:101", "ISOM2017-2:304").hardFail).toMatch(/main colour/); // brown vs blue line
    expect(score("ISOM2017-2:505", "ISOM2017-2:503").hardFail).toMatch(/dashed|borders|main colour/);
    expect(score("ISOM2017-2:401", "ISOM2017-2:403").hardFail).toMatch(/fill colour/); // yellow 100 vs 50
    expect(score("ISOM2017-2:204", "ISOM2017-2:109").hardFail).toMatch(/colour/); // black dot vs brown dot
  });

  it("compares glyph-only lines by their glyph colour, and a stroked vs glyph-only line softly", () => {
    const r = score("ISOM2017-2:416", "ISOM2017-2:309"); // black dots vs blue dots
    expect(r.hardFail).toMatch(/main colour/);
    const r2 = score("ISOM2017-2:215", "ISOM2017-2:416"); // borders-only vs glyph-only, both black
    expect(r2.hardFail).toMatch(/borders/);
    const r3 = score("ISOM2017-2:416", "ISOM2017-2:415"); // dotted vs solid thin black line
    expect(r3.hardFail).toBeUndefined();
    expect(r3.score).toBeLessThan(MATCH_THRESHOLDS.suggest);
  });

  it("tolerates small deviations and rejects large ones, relative to the symbol for glyph boxes", () => {
    const contour = render("ISOM2017-2:101") as LineSymbol;
    const slightlyWide: LineSymbol = { ...contour, main: { ...contour.main!, widthUm: contour.main!.widthUm + TOLERANCE.widthUm } };
    expect(compareFingerprints(fingerprintOf(slightlyWide, classOf), fp("ISOM2017-2:101")).score).toBe(1);
    const tooWide: LineSymbol = { ...contour, main: { ...contour.main!, widthUm: contour.main!.widthUm + 3 * TOLERANCE.widthUm } };
    expect(compareFingerprints(fingerprintOf(tooWide, classOf), fp("ISOM2017-2:101")).score).toBe(0);

    const control = render("ISOM2017-2:703") as PointSymbol;
    const ring6: PointSymbol = { ...control, glyph: { ...control.glyph, parts: [{ ...control.glyph.parts[0], diameterUm: 6000 }] } };
    const r = compareFingerprints(fingerprintOf(ring6, classOf), fp("ISOM2017-2:703"));
    expect(r.score).toBeGreaterThan(0); // 650 µm off a 5.35 mm ring is within 2 × 10 %
    expect(r.score).toBeLessThan(MATCH_THRESHOLDS.auto);
  });

  it("applies the document factor to canonical dimensions", () => {
    const enlarged = scaleRenderSymbol(render("ISOM2017-2:101"), 1.5);
    const f = fingerprintOf(enlarged, classOf);
    expect(compareFingerprints(f, fp("ISOM2017-2:101"), 1.5).score).toBe(1);
    expect(compareFingerprints(f, fp("ISOM2017-2:101"), 1).score).toBe(0);
  });
});

describe("fingerprintHash", () => {
  it("scores OCAD's railway and power line constructions as auto against the B10 entries", () => {
    // Sprint's 509.100: white 0.26 dashes 1.01 / 1.5 over a black 0.45 band (OCAD double-line fill).
    const railway = parseRenderSymbol({
      type: "line", id: "x", code: "509.100", name: "Railway",
      main: { colour: idx.get("white-railway")!, widthUm: 260, dash: { layout: "ocad", dashUm: 1010, gapUm: 1500 } },
      borders: { backgroundColour: idx.get("black100")!, backgroundWidthUm: 450 },
    }) as LineSymbol;
    const canonRailway = fp("ISOM2017-2:509");
    expect(canonRailway).toMatchObject({ mainClass: { hue: "white" }, dashed: true, background: true, borders: false });
    const r = compareFingerprints(fingerprintOf(railway, classOf), canonRailway);
    expect(r.hardFail).toBeUndefined();
    expect(r.score).toBeGreaterThanOrEqual(MATCH_THRESHOLDS.auto);
    // Club-2026's 510.0: OCAD corner symbol (bar ±0.37) on a 0.14 line → corners, as the library now places pylons.
    const power = parseRenderSymbol({
      type: "line", id: "x", code: "510.0", name: "Power line",
      main: { colour: idx.get("black100")!, widthUm: 140 },
      glyphs: [{ glyph: { parts: [{ kind: "stroke", colour: idx.get("black100")!, widthUm: 140, geometry: { coords: [0, -370, 0, 370] } }], rotatable: true }, placement: { at: "corners" } }],
    }) as LineSymbol;
    const p = compareFingerprints(fingerprintOf(power, classOf), fp("ISOM2017-2:510"));
    expect(p.reasons.filter((x) => x.startsWith("glyph placement") || x.startsWith("glyph box"))).toEqual([]);
    expect(p.score).toBeGreaterThanOrEqual(MATCH_THRESHOLDS.auto);
  });

  it("is stable for equal fingerprints and differs for different ones", () => {
    expect(fingerprintHash(fp("ISOM2017-2:101"))).toBe(fingerprintHash(fp("ISOM2017-2:101")));
    expect(fingerprintHash(fp("ISOM2017-2:101"))).not.toBe(fingerprintHash(fp("ISOM2017-2:102")));
    expect(fingerprintHash(fp("ISOM2017-2:101"))).toMatch(/^[0-9a-f]{8}$/);
  });
});
