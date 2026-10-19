import { describe, expect, it } from "vitest";
import { PILOT, pilotSymbols } from "../__fixtures__/pilot-symbols.js";
import { COORD_FLAG } from "../pass-stream.js";
import { pathSegments, segmentLength } from "../path.js";
import { passStreamToJson } from "../stream-json.js";
import { SWATCH, swatchScene, symboliseSwatch } from "../swatch.js";
import { parseRenderSymbol } from "../symbol.js";
import { listSymbolLibraries, materialiseLibrary } from "../../symbol-library/index.js";
import { liberation } from "./fonts.js";

const fonts = () => [liberation().sans, liberation().narrow];
const umPerPx = 1000 / SWATCH.pxPerMm;

describe("swatchScene — sample geometry (map-rendering §5.1.1)", () => {
  it("line: 30 mm polyline with a corner at 12 mm and a dash point 10 mm after it", () => {
    const { objects, symbols } = swatchScene(pilotSymbols[PILOT.footpath505]);
    expect(objects).toHaveLength(1);
    const [o] = objects;
    expect(symbols[o.symbolIdx]).toBe(pilotSymbols[PILOT.footpath505]);
    expect(Array.from(o.path.coords)).toEqual([0, 0, 12000, 0, 20660, 5000, 27588, 9000]);
    expect(Array.from(o.path.flags)).toEqual([0, COORD_FLAG.corner, COORD_FLAG.dash, 0]);
    expect(o.path.closed).toBe(false);
    const length = pathSegments(o.path).reduce((s, seg) => s + segmentLength(seg), 0);
    expect(Math.abs(length - 30000)).toBeLessThan(2);
    // the dash point sits 10 mm after the corner
    const [, second] = pathSegments(o.path);
    expect(Math.abs(segmentLength(second) - 10000)).toBeLessThan(1);
  });

  it("area: closed 15 × 15 mm square, angle 0", () => {
    const { objects } = swatchScene(pilotSymbols[PILOT.roughOpen403]);
    expect(Array.from(objects[0].path.coords)).toEqual([0, 0, 15000, 0, 15000, 15000, 0, 15000]);
    expect(objects[0].path.closed).toBe(true);
    expect(objects[0].angleDeg ?? 0).toBe(0);
  });

  it("point: the symbol scaled ×3, one object at the origin, 12 mm minimum frame", () => {
    const tree = pilotSymbols[PILOT.tree418];
    const { objects, symbols, minFrame } = swatchScene(tree);
    expect(Array.from(objects[0].path.coords)).toEqual([0, 0]);
    const scaled = symbols[objects[0].symbolIdx];
    expect(scaled.type).toBe("point");
    if (scaled.type !== "point" || tree.type !== "point") throw new Error("point expected");
    const d0 = tree.glyph.parts[0].diameterUm ?? tree.glyph.parts[0].widthUm!;
    const d3 = scaled.glyph.parts[0].diameterUm ?? scaled.glyph.parts[0].widthUm!;
    expect(d3).toBe(Math.round(d0 * 3));
    expect(minFrame).toEqual({ minX: -6000, minY: -6000, maxX: 6000, maxY: 6000 });
  });

  it("text: one point object carrying the sample text", () => {
    const { objects } = swatchScene(pilotSymbols[PILOT.controlNumber704]);
    expect(objects[0].text).toBe(SWATCH.text);
    expect(Array.from(objects[0].path.coords)).toEqual([0, 0]);
  });
});

describe("symboliseSwatch — frame and determinism", () => {
  it("frame covers the stream plus a 1 mm margin and is a whole number of pixels", () => {
    for (const sym of pilotSymbols) {
      const { stream, frame } = symboliseSwatch(sym, fonts());
      const w = (frame.bounds.maxX - frame.bounds.minX) / umPerPx;
      const h = (frame.bounds.maxY - frame.bounds.minY) / umPerPx;
      expect(Math.abs(w - frame.width)).toBeLessThan(1e-6);
      expect(Math.abs(h - frame.height)).toBeLessThan(1e-6);
      expect(stream.passes.length).toBeGreaterThan(0);
    }
    const { frame } = symboliseSwatch(pilotSymbols[PILOT.tree418], fonts());
    // 12 mm minimum frame + 2 × 1 mm margin at 10 px/mm
    expect(frame.width).toBeGreaterThanOrEqual(140);
    expect(frame.height).toBeGreaterThanOrEqual(140);
  });

  it("is deterministic", () => {
    for (const sym of pilotSymbols) {
      const a = symboliseSwatch(sym, fonts());
      const b = symboliseSwatch(sym, fonts());
      expect(passStreamToJson(a.stream)).toEqual(passStreamToJson(b.stream));
      expect(a.frame).toEqual(b.frame);
    }
  });

  it("does not special-case: a source symbol and a canonical entry go through the same scene", () => {
    const lib = materialiseLibrary("ISOM2017-2");
    const i = lib.library.entries.findIndex((e) => e.id === "ISOM2017-2:505");
    const canonical = swatchScene(lib.symbols[i]);
    const source = swatchScene(parseRenderSymbol({ ...lib.symbols[i], id: "source:505" }));
    expect(Array.from(source.objects[0].path.coords)).toEqual(Array.from(canonical.objects[0].path.coords));
    expect(Array.from(source.objects[0].path.flags)).toEqual(Array.from(canonical.objects[0].path.flags));
  });

  it("every entry of the shipped libraries symbolises without warnings into a non-empty stream", () => {
    for (const { id } of listSymbolLibraries()) {
      const lib = materialiseLibrary(id as "ISOM2017-2" | "ISSprOM2019-2");
      lib.symbols.forEach((sym, i) => {
        const { stream, warnings } = symboliseSwatch(sym, fonts());
        expect({ id: lib.library.entries[i].id, warnings }).toEqual({ id: lib.library.entries[i].id, warnings: [] });
        expect(stream.passes.length, lib.library.entries[i].id).toBeGreaterThan(0);
      });
    }
  });
});
