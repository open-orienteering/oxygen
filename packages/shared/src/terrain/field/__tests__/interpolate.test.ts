import { describe, expect, it } from "vitest";
import { cellIndex, LABEL } from "../../graph/index.js";
import { S, line, ring } from "../../graph/__tests__/synthetic.js";
import { HEIGHT_NO_DATA, bandSources, boxBlur, buildHeightField, fieldGrid, encodeHeightField, fieldCell, geodesicDistance, isConfident, sampleHeight, type HeightField } from "../index.js";
import { graphOf, levelsAt, regionAt } from "./levels.js";

/** Height in intervals at (x, y). */
const intervals = (f: HeightField, x: number, y: number): number => {
  const m = sampleHeight(f, { x, y });
  if (m === null) throw new Error(`no data at ${x}, ${y}`);
  return m / f.header.intervalM;
};

// Four parallel contours across the map, cut by the frame on both sides: levels 0 … 4 upwards.
const SLOPE = [10, 20, 30, 40].map((y) => ({ sym: S.contour, coords: line(0, y, 60, y) }));
const SLOPE_AREA: [number, number, number, number] = [0, 5, 60, 45];
const slopeLevels = (g: ReturnType<typeof graphOf>) => levelsAt(g, [9, 15, 25, 35, 41].map((y, l) => [30, y, l] as [number, number, number]));

// Four concentric rings: a hill, level 4 inside the 5 mm ring, 0 outside the 20 mm ring.
const CONE = [5, 10, 15, 20].map((r) => ({ sym: S.contour, coords: ring(30, 30, r, 96) }));
const coneLevels = (g: ReturnType<typeof graphOf>) => levelsAt(g, [[30, 30, 4], [37.5, 30, 3], [42.5, 30, 2], [47.5, 30, 1], [51, 30, 0]]);

describe("band sources and geodesic distance (map-terrain.md §4.2–4.3)", () => {
  it("seeds the high side of a chain as its lower bound and the low side as its upper bound", () => {
    const g = graphOf(SLOPE, SLOPE_AREA);
    const s = bandSources(g, slopeLevels(g));
    const band = regionAt(g, 30, 15); // level 1, between y = 10 and y = 20
    const regionOf = (cells: Int32Array) => new Set([...cells].map((i) => g.raster.labels[i]));
    expect(regionOf(s.low).has(band)).toBe(true);
    expect(regionOf(s.up).has(band)).toBe(true);
    expect(regionOf(s.low).has(regionAt(g, 30, 9))).toBe(false); // the lowest band has no lower contour
    expect(regionOf(s.up).has(regionAt(g, 30, 41))).toBe(false); // the highest band has no upper contour
    expect(s.form.length).toBe(0);
    const lowY = [...s.low].filter((i) => g.raster.labels[i] === band).map((i) => g.raster.y0 + (Math.floor(i / g.raster.width) + 0.5) * g.raster.cellMm);
    expect(Math.max(...lowY)).toBeLessThan(10.5); // the band's lower bound lies along y = 10
  });

  it("keeps geodesic distance inside the seed's region", () => {
    const g = graphOf(SLOPE, SLOPE_AREA);
    const s = bandSources(g, slopeLevels(g));
    const d = geodesicDistance(g.raster, s.low);
    const at = (x: number, y: number) => d[cellIndex(g.raster, x, y)];
    expect(at(30, 9)).toBe(65535); // below the lowest contour: unreachable from any lower bound
    // 4 mm above y = 10 is 40 cells: 80 in half-cell units, give or take the seed's offset from the line
    expect(Math.abs(at(30, 14) - 80)).toBeLessThanOrEqual(4);
    expect(at(30, 10)).toBe(65535); // the chain's own cells are not part of any region
    expect(g.raster.labels[cellIndex(g.raster, 30, 10)]).toBeLessThanOrEqual(LABEL.chain0);
  });
});

describe("the surface (map-terrain.md §4.4–4.8)", () => {
  it("lays a slope within 0.1 interval of the plane", () => {
    const g = graphOf(SLOPE, SLOPE_AREA);
    const f = buildHeightField(g, slopeLevels(g));
    for (let x = 10; x <= 50; x += 5) for (let y = 11; y <= 39; y += 1.3) expect(Math.abs(intervals(f, x, y) - y / 10)).toBeLessThan(0.1);
  });

  it("raises a cone linearly between its rings and domes its top by at most half an interval", () => {
    const g = graphOf(CONE);
    const f = buildHeightField(g, coneLevels(g));
    for (let a = 0; a < 2 * Math.PI; a += Math.PI / 7)
      for (let r = 6; r <= 19; r += 0.7) {
        const h = intervals(f, 30 + r * Math.cos(a), 30 + r * Math.sin(a));
        expect(Math.abs(h - (1 + (20 - r) / 5))).toBeLessThan(0.1);
      }
    const centre = intervals(f, 30, 30);
    expect(centre).toBeGreaterThan(4.3);
    expect(centre).toBeLessThanOrEqual(4.5);
    let last = -Infinity;
    for (let r = 4.5; r >= 0; r -= 0.5) {
      const h = intervals(f, 30 + r, 30);
      expect(h).toBeGreaterThanOrEqual(last - 1e-9);
      last = h;
    }
  });

  it("sinks a pit by at most half an interval below its contour", () => {
    const g = graphOf([{ sym: S.contour, coords: ring(30, 30, 8) }]);
    const f = buildHeightField(g, levelsAt(g, [[30, 30, 0], [39, 30, 1]]));
    const centre = intervals(f, 30, 30);
    expect(centre).toBeGreaterThanOrEqual(0.5);
    expect(centre).toBeLessThan(0.7);
    expect(intervals(f, 30 + 7, 30)).toBeGreaterThan(centre);
  });

  it("puts a form line at half an interval above the contour below", () => {
    const g = graphOf([...SLOPE, { sym: S.form, coords: line(0, 15, 60, 15) }], SLOPE_AREA);
    const f = buildHeightField(g, slopeLevels(g));
    for (let x = 10; x <= 50; x += 5) expect(Math.abs(intervals(f, x, 15) - 1.5)).toBeLessThan(0.1);
  });

  it("carries a multi-step chain's whole drop", () => {
    // the chain at y = 20 stands for three contours: level 1 below, 4 above
    const g = graphOf(SLOPE, SLOPE_AREA);
    const f = buildHeightField(g, levelsAt(g, [[30, 9, 0], [30, 15, 1], [30, 25, 4], [30, 35, 5], [30, 41, 6]]));
    const r = f.header.cellMm * 2; // two smoothing radii (one cell each at 1:15 000)
    for (let x = 10; x <= 50; x += 10) expect(intervals(f, x, 20 + 2 * r + 0.1) - intervals(f, x, 20 - 2 * r - 0.1)).toBeGreaterThanOrEqual(2 - 0.05);
  });

  it("treats a chain level on both sides as a form line", () => {
    const g = graphOf(SLOPE, SLOPE_AREA);
    const f = buildHeightField(g, levelsAt(g, [[30, 9, 0], [30, 15, 1], [30, 25, 1], [30, 35, 2], [30, 41, 3]]));
    expect(Math.abs(intervals(f, 30, 20) - 1.5)).toBeLessThan(0.1);
  });

  it("has data in every mapped cell and none outside", () => {
    const g = graphOf(CONE);
    const f = buildHeightField(g, coneLevels(g));
    const { width, height } = f.header;
    let inside = 0;
    for (let cy = 0; cy < height; cy++)
      for (let cx = 0; cx < width; cx++) {
        const x = f.header.x0 + (cx + 0.5) * f.header.cellMm, y = f.header.y0 + (cy + 0.5) * f.header.cellMm;
        const fine = g.raster.labels[cellIndex(g.raster, x, y)];
        const v = f.z[cy * width + cx];
        if (fine > 0) {
          inside++;
          expect(v).not.toBe(HEIGHT_NO_DATA);
        } else if (fine === LABEL.outside) expect(v).toBe(HEIGHT_NO_DATA);
      }
    expect(inside).toBeGreaterThan(1000);
    expect(f.header.zMin).toBeGreaterThanOrEqual(0);
    expect(f.header.zMax).toBeLessThanOrEqual(4.5 * 64);
  });

  it("clears the confidence bit in weak regions and where flagged chains bound a band", () => {
    const g = graphOf(SLOPE, SLOPE_AREA);
    const lv = slopeLevels(g);
    lv.regionWeak[regionAt(g, 30, 15)] = 1;
    const at = (y: number) => g.chains.findIndex((c) => Math.abs(c.pts[1] - y) < 1e-6);
    lv.flagged[at(30)] = lv.flagged[at(40)] = 1; // both bounds of the band 30–40, the only bound of the band above 40
    const f = buildHeightField(g, lv);
    const conf = (x: number, y: number) => isConfident(f, fieldCell(f, { x, y }));
    expect(conf(30, 9)).toBe(true);
    expect(conf(30, 15)).toBe(false);
    expect(conf(30, 35)).toBe(false);
    expect(conf(30, 41)).toBe(false);
  });

  it("is deterministic to the byte", () => {
    const g = graphOf(CONE);
    expect(encodeHeightField(buildHeightField(g, coneLevels(g)))).toEqual(encodeHeightField(buildHeightField(graphOf(CONE), coneLevels(graphOf(CONE)))));
  });
});

describe("the field grid (map-terrain.md §4.6)", () => {
  it("takes 0.2 mm cells on a 0.1 mm raster and records the interval and scale", () => {
    const g = graphOf(CONE);
    const f = buildHeightField(g, coneLevels(g), { intervalM: 2.5 });
    expect(f.header.cellMm).toBeCloseTo(0.2, 12);
    expect(f.header.x0).toBe(g.raster.x0);
    expect(f.header.width).toBe(Math.ceil(g.raster.width / 2));
    expect(f.header).toMatchObject({ intervalM: 2.5, zScaleM: 2.5 / 64, zOffsetM: 0, datum: "relative", source: "contours", groundMPerMm: 15 });
  });

  it("grows the cell by whole graph cells to stay within the budget", () => {
    const g = graphOf(CONE);
    const cells = Math.ceil(g.raster.width / 2) * Math.ceil(g.raster.height / 2);
    const f = buildHeightField(g, coneLevels(g), { maxCells: Math.floor(cells / 2) });
    expect(f.header.cellMm).toBeCloseTo(0.3, 12);
    expect(f.header.width * f.header.height).toBeLessThanOrEqual(cells / 2);
    const side = buildHeightField(g, coneLevels(g), { maxSide: 100 });
    expect(Math.max(side.header.width, side.header.height)).toBeLessThanOrEqual(100);
  });

  it("refuses a budget below one cell", () => {
    expect(() => fieldGrid({ cellMm: 0.1, width: 10, height: 10 }, { maxCells: 0 })).toThrow(RangeError);
    expect(() => fieldGrid({ cellMm: 0.1, width: 10, height: 10 }, { maxSide: 0.5 })).toThrow(RangeError);
  });
});

describe("edge rules (map-terrain.md §4.2, 4.6–4.8)", () => {
  it("seeds a leaky chain as a form line on both sides", () => {
    // the open line's band runs around it (map-terrain.md §2.6): it says nothing about up or down
    const g = graphOf([{ sym: S.contour, coords: ring(30, 20, 5) }, { sym: S.contour, coords: line(40, 30, 50, 30) }]);
    const leakyChain = g.chains.findIndex((c) => !c.closed);
    expect(g.leaky[leakyChain]).toBe(1);
    const lv = levelsAt(g, [[30, 20, 1], [45, 25, 0]]);
    lv.side[leakyChain] = 1; // even a decided side is ignored on a leaky chain
    const s = bandSources(g, lv);
    const near = (cells: Int32Array) => [...cells].filter((i) => {
      const x = g.raster.x0 + ((i % g.raster.width) + 0.5) * g.raster.cellMm, y = g.raster.y0 + (Math.floor(i / g.raster.width) + 0.5) * g.raster.cellMm;
      return x > 42 && x < 48 && Math.abs(y - 30) < 0.5;
    }).length;
    expect(near(s.form)).toBeGreaterThan(50);
    expect(near(s.low) + near(s.up)).toBe(0);
    expect(Math.abs(intervals(buildHeightField(g, lv), 45, 30.3) - 0.5)).toBeLessThan(0.15);
  });

  it("does not count undecided or conflicted chains as good for confidence", () => {
    const g = graphOf(SLOPE, SLOPE_AREA);
    const lv = slopeLevels(g);
    const at = (y: number) => g.chains.findIndex((c) => Math.abs(c.pts[1] - y) < 1e-6);
    lv.side[at(10)] = 0; // the floors still differ, so the chain still bounds the bands; it is just not good evidence
    lv.conflict[at(40)] = 0.6;
    const f = buildHeightField(g, lv);
    const conf = (y: number) => isConfident(f, fieldCell(f, { x: 30, y }));
    expect([conf(9), conf(25), conf(41)]).toEqual([false, true, false]);
    expect(Math.abs(intervals(f, 30, 15) - 1.5)).toBeLessThan(0.1); // the heights do not change
  });

  it("clamps heights beyond ±512 intervals", () => {
    const g = graphOf(SLOPE, SLOPE_AREA);
    const f = buildHeightField(g, levelsAt(g, [[30, 9, 0], [30, 15, 600], [30, 25, 601], [30, 35, 602], [30, 41, 603]]));
    expect(f.header.zMax).toBe(32767);
    expect(f.z[fieldCell(f, { x: 30, y: 41 })]).toBe(32767);
  });

  it("blurs over data cells only and keeps no-data out", () => {
    const N = NaN;
    const src = Float32Array.from([1, 2, 3, 4, N, 6, 7, 8, 100]);
    const noData = Uint8Array.from([0, 0, 0, 0, 0, 0, 0, 0, 1]);
    const out = boxBlur(src, noData, 3, 3, 1);
    expect(out[4]).toBeCloseTo((1 + 2 + 3 + 4 + 6 + 7 + 8) / 7, 6); // the hole filled from its data neighbours, not the no-data 100
    expect(out[0]).toBeCloseTo((1 + 2 + 4) / 3, 6);
    expect(Number.isNaN(out[8])).toBe(true);
  });
});
