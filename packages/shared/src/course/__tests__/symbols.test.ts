import { describe, expect, it } from "vitest";
import { courseSymbols } from "../symbols.js";
import { arcPath, circleWithGaps } from "../arcs.js";
import { courseColourStack } from "../colour-stack.js";
import { paletteStack } from "../../symbol-library/palette.js";
import type { DocumentColour } from "../../map-document/header.js";
import { COORD_FLAG } from "../../render/pass-stream.js";
import type { LineSymbol, PointSymbol, TextSymbol } from "../../render/symbol.js";

const stack = (spec: "ISOM2017-2" | "ISSprOM2019-2") =>
  courseColourStack(paletteStack("iof2024", spec).map((c): DocumentColour => ({ ...c, paletteIds: [c.id.slice(c.id.indexOf(":") + 1)] })));

describe("courseSymbols (course-layer.md §3.1)", () => {
  it("resolves ISOM 7xx at the library dimensions, roles from the entries", () => {
    const { index } = stack("ISOM2017-2");
    const s = courseSymbols({ libraryId: "ISOM2017-2", documentFactor: 1 }, index, {});
    expect(s.circleRadiusUm).toBe(2500);
    expect(s.finishRadiusUm).toBe(3000);
    expect(s.startRadiusUm).toBeCloseTo(6000 / Math.sqrt(3), -1);
    expect(s.lineWidthUm).toBe(350);
    expect(s.digitHeightUm).toBe(4000);
    const circle = s.symbols[s.idx.circle] as LineSymbol;
    expect(circle.main).toMatchObject({ colour: index.get("purple-lower"), widthUm: 350, cap: "flat" });
    const number = s.symbols[s.idx.number] as TextSymbol;
    expect(number).toMatchObject({ colour: index.get("purple-upper"), align: "centre", digitHeightUm: 4000 });
    expect(number.halo).toBeUndefined();
    expect((s.symbols[s.idx.leader] as LineSymbol).main!.colour).toBe(index.get("purple-upper"));
    expect((s.symbols[s.idx.markedRoute] as LineSymbol).main!.colour).toBe(index.get("purple-upper"));
    expect((s.symbols[s.idx.whiteout] as { fill?: number }).fill).toBe(index.get("white-upper"));
    expect((s.symbols[s.idx.start] as PointSymbol).orientation).toBe("object");
  });

  it("scales by the document factor (ISOM at 1:10 000 → 7.5 mm circles)", () => {
    const { index } = stack("ISOM2017-2");
    const s = courseSymbols({ libraryId: "ISOM2017-2", documentFactor: 1.5 }, index, {});
    expect(s.circleRadiusUm).toBeCloseTo(3750, 6);
    expect(s.lineWidthUm).toBeCloseTo(525, 6);
    expect(s.digitHeightUm).toBeCloseTo(6000, 6);
  });

  it("ISSprOM: 6 mm circles, upper-purple numbers, 711 borrowed from ISOM", () => {
    const { index } = stack("ISSprOM2019-2");
    const s = courseSymbols({ libraryId: "ISSprOM2019-2", documentFactor: 1 }, index, {});
    expect(s.circleRadiusUm).toBe(3000);
    expect((s.symbols[s.idx.number] as TextSymbol).colour).toBe(index.get("purple-upper"));
    expect(s.symbols[s.idx.forbiddenRoute].id).toBe("ISOM2017-2:711");
  });

  it("appearance multipliers: circle geometry, line widths, digit height", () => {
    const { index } = stack("ISOM2017-2");
    const s = courseSymbols({ libraryId: "ISOM2017-2", documentFactor: 1 }, index, { circle: 1.2, line: 2, number: 1.25 });
    expect(s.circleRadiusUm).toBeCloseTo(3000, 6);
    expect((s.symbols[s.idx.circle] as LineSymbol).main!.widthUm).toBe(700);
    expect(s.finishRadiusUm).toBeCloseTo(3600, 6);
    expect(s.lineWidthUm).toBe(700);
    expect(s.digitHeightUm).toBe(5000);
    const start = s.symbols[s.idx.start] as PointSymbol;
    expect(start.glyph.parts[0].widthUm).toBe(700);
  });

  it("knockout numbers: upper purple with a 0.15 mm upper-white outline", () => {
    const { index } = stack("ISOM2017-2");
    const s = courseSymbols({ libraryId: "ISOM2017-2", documentFactor: 1 }, index, { numberStyle: "knockout" });
    const number = s.symbols[s.idx.number] as TextSymbol;
    expect(number.colour).toBe(index.get("purple-upper"));
    expect(number.halo).toEqual({ colour: index.get("white-upper"), widthUm: 150 });
    expect((s.symbols[s.idx.leader] as LineSymbol).main!.colour).toBe(index.get("purple-upper"));
  });
});

describe("arcs", () => {
  const onCircle = (coords: Int32Array, flags: Uint8Array, r: number) => {
    for (let i = 0; i < flags.length; i++) {
      if (flags[i] & (COORD_FLAG.bezierFirst | COORD_FLAG.bezierSecond)) continue;
      expect(Math.hypot(coords[2 * i], coords[2 * i + 1])).toBeCloseTo(r, -1);
    }
  };
  const midpoint = (c: Int32Array, i: number) => {
    // Cubic at t = 0.5 from the four points starting at vertex i.
    const p = (k: number) => [c[2 * (i + k)], c[2 * (i + k) + 1]];
    const [a, b, d, e] = [p(0), p(1), p(2), p(3)];
    return [0, 1].map((j) => (a[j] + 3 * b[j] + 3 * d[j] + e[j]) / 8);
  };

  it("a full circle is one closed path of four cubics within 1 µm of the circle", () => {
    const [path] = circleWithGaps(0, 0, 2500, []);
    expect(path.closed).toBe(true);
    expect(path.flags.length).toBe(13);
    onCircle(path.coords, path.flags, 2500);
    for (const i of [0, 3, 6, 9]) expect(Math.abs(Math.hypot(...midpoint(path.coords, i)) - 2500)).toBeLessThan(1);
  });

  it("gaps leave open arcs; an arc through north is one path", () => {
    const paths = circleWithGaps(0, 0, 2500, [{ start: 80, end: 100 }]);
    expect(paths).toHaveLength(1);
    expect(paths[0].closed).toBe(false);
    // Starts at compass 100° (just south of east) and ends at 80°.
    const [x0, y0] = [paths[0].coords[0], paths[0].coords[1]];
    expect(Math.atan2(x0, y0) * (180 / Math.PI)).toBeCloseTo(100, 0);
    const n = paths[0].flags.length;
    expect(Math.atan2(paths[0].coords[2 * n - 2], paths[0].coords[2 * n - 1]) * (180 / Math.PI)).toBeCloseTo(80, 0);
    expect(circleWithGaps(0, 0, 2500, [{ start: 80, end: 100 }, { start: 260, end: 280 }])).toHaveLength(2);
  });

  it("arcPath runs clockwise for a decreasing angle", () => {
    const p = arcPath(0, 0, 1000, 90, 0);
    expect([p.coords[0], p.coords[1]]).toEqual([0, 1000]);
    expect([p.coords[6], p.coords[7]]).toEqual([1000, 0]);
  });
});
