import { describe, expect, it } from "vitest";
import { canonicalCode, classifyTerrainSymbol, cliffTagSide, contourInputs } from "../index.js";
import { S, SYMBOLS, line, rect, ring, syntheticDoc } from "./synthetic.js";

const doc = syntheticDoc([]);
const sym = (i: number) => doc.header.symbols[i];

describe("classifyTerrainSymbol (map-terrain.md §1.1)", () => {
  it("classifies by canonical code and symbol kind", () => {
    expect(classifyTerrainSymbol(sym(S.contour))).toBe("contour");
    expect(classifyTerrainSymbol(sym(S.index))).toBe("index");
    expect(classifyTerrainSymbol(sym(S.form))).toBe("form");
    expect(classifyTerrainSymbol(sym(S.tick))).toBe("tick");
    expect(classifyTerrainSymbol(sym(S.formTick))).toBe("formTick");
    expect(classifyTerrainSymbol(sym(S.cliffTagged))).toBe("cliff");
    expect(classifyTerrainSymbol(sym(S.cliff))).toBe("cliff");
    expect(classifyTerrainSymbol(sym(S.water))).toBe("water");
  });

  it("reads a suggested, unreviewed match like an applied one", () => {
    expect(sym(S.suggestedCliff).match?.state).toBe("suggested");
    expect(classifyTerrainSymbol(sym(S.suggestedCliff))).toBe("cliff");
  });

  it("skips hidden symbols", () => {
    expect(classifyTerrainSymbol(sym(S.hiddenContour))).toBeNull();
  });

  it("puts other terrain-numbered symbols in `other` (mask only), falling back to the source code", () => {
    expect(classifyTerrainSymbol(sym(S.vegetation))).toBe("other");
    expect(classifyTerrainSymbol(sym(S.road))).toBe("other");
    expect(classifyTerrainSymbol(sym(S.contourAsArea))).toBe("other");
    expect(classifyTerrainSymbol(sym(S.sourceOnly))).toBe("other");
    expect(classifyTerrainSymbol(sym(S.course))).toBeNull();
  });

  it("strips the library from the canonical id", () => {
    expect(canonicalCode(sym(S.tick))).toBe("101.b");
    expect(canonicalCode(sym(S.sourceOnly))).toBe("");
  });
});

describe("cliffTagSide (§1.2)", () => {
  it("reads the tag side from the definition's glyph strokes", () => {
    // ISOM draws the tags right of the drawing direction (negative local y).
    expect(cliffTagSide(sym(S.cliffTagged))).toBe(-1);
    expect(cliffTagSide(sym(S.suggestedCliff))).toBe(-1);
    expect(cliffTagSide(sym(S.cliff))).toBe(0);
  });

  it("is +1 for tags on the left and 0 without a definition", () => {
    const tagged = sym(S.cliffTagged);
    const flipped = JSON.parse(JSON.stringify(tagged));
    for (const g of flipped.render.glyphs) for (const p of g.glyph.parts) p.geometry.coords[3] = -p.geometry.coords[3];
    expect(cliffTagSide(flipped)).toBe(1);
    expect(cliffTagSide({ ...tagged, render: null })).toBe(0);
  });
});

describe("contourInputs (§1)", () => {
  const d = syntheticDoc([
    { sym: S.contour, coords: ring(20, 20, 5) },
    { sym: S.index, coords: line(0, 0, 10, 0) },
    { sym: S.form, coords: line(0, 5, 10, 5) },
    { sym: S.tick, coords: [3, 4], angleDeciDeg: 900 },
    { sym: S.formTick, coords: [5, 5], angleDeciDeg: -450 },
    { sym: S.cliffTagged, coords: line(30, 0, 30, 10) },
    { sym: S.cliff, coords: line(40, 0, 40, 10) },
    { sym: S.water, coords: rect(50, 0, 55, 5) },
    { sym: S.vegetation, coords: rect(0, 0, 60, 40) },
    { sym: S.hiddenContour, coords: line(0, 30, 10, 30) },
    { sym: S.contour, coords: [1, 1, 1.01, 1] },
    { sym: S.course, coords: [7, 7] },
  ]);
  const inp = contourInputs(d);
  /** Objects are stored in Hilbert order; tests name them by their source position. */
  const src = (object: number) => d.attrs.sourceIndex[object];

  it("collects each class in document order with its object index", () => {
    expect(inp.contours.map((p) => [src(p.object), p.closed, p.index]).sort()).toEqual([
      [0, true, false],
      [1, false, true],
    ]);
    expect(inp.formLines.map((p) => src(p.object))).toEqual([2]);
    for (const list of [inp.contours, inp.cliffs]) expect(list.map((p) => p.object)).toEqual(list.map((p) => p.object).sort((a, b) => a - b));
    expect(inp.cliffs.map((c) => [src(c.object), c.tagSide]).sort()).toEqual([
      [5, -1],
      [6, 0],
    ]);
    expect(inp.water).toHaveLength(1);
    expect(inp.water[0].rings[0]).toHaveLength(10);
    expect(inp.counts).toEqual({ contourObjects: 2, indexObjects: 1, formObjects: 1, ticks: 1, formTicks: 1, cliffObjects: 2, taggedCliffs: 1, waterAreas: 1 });
  });

  it("drops a contour piece under 0.02 mm but counts its object", () => {
    expect(inp.contours.some((p) => src(p.object) === 10)).toBe(false);
  });

  it("reads ticks as position and counter-clockwise angle in radians", () => {
    expect(inp.ticks.map((t) => ({ ...t, object: src(t.object) }))).toEqual([{ x: 3, y: 4, angleRad: Math.PI / 2, object: 3 }]);
    expect(inp.formTicks[0].angleRad).toBeCloseTo(-Math.PI / 4, 12);
  });

  it("gives every classified part to the mask, and nothing else", () => {
    // 8 classified objects with one part each, plus the 0.02 mm piece (dropped as a contour, still terrain extent).
    expect(inp.extentParts).toHaveLength(10);
  });

  it("converts the scale to ground metres per paper mm", () => {
    expect(inp.groundMPerMm).toBe(15);
    expect(contourInputs(syntheticDoc([], 4000)).groundMPerMm).toBe(4);
  });
});
