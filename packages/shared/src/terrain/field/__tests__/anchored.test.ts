import { describe, expect, it } from "vitest";
import { S, line, ring } from "../../graph/__tests__/synthetic.js";
import { cellIndex, type ContourGraph } from "../../graph/index.js";
import {
  anchoredOffsetM, buildGroundField, buildHeightField, decodeHeightField, encodeHeightField, geodesicDistance, geodesicNearest, isConfident, sampleHeight,
  HEIGHT_NO_DATA, heightFieldHeaderSchema, type HeightField, type HeightFieldProvider,
} from "../index.js";
import { graphOf, levelsAt } from "./levels.js";

const I = 5;
const BASE = 312.4; // the absolute height of the outermost ring
const CONE = [5, 10, 15, 20].map((r) => ({ sym: S.contour, coords: ring(30, 30, r, 96) }));
const coneLevels = (g: ContourGraph) => levelsAt(g, [[30, 30, 4], [37.5, 30, 3], [42.5, 30, 2], [47.5, 30, 1], [51, 30, 0]]);
const LM: HeightFieldProvider = { id: "lantmateriet-2m", resolutionM: 2, grade: "anchor", licence: "CC BY 4.0", attribution: "© Lantmäteriet", verticalDatum: "RH 2000" };

/** The chain whose first point lies `r` mm from (30, 30). */
function chainAtRadius(g: ContourGraph, r: number): number {
  const i = g.chains.findIndex((c) => Math.abs(Math.hypot(c.pts[0] - 30, c.pts[1] - 30) - r) < 0.3);
  if (i < 0) throw new Error(`no chain at r = ${r}`);
  return i;
}

/** Absolute per-chain heights for the cone: ring r at BASE + I · (20 − r) / 5, plus `bump` metres on one ring. */
function coneHeights(g: ContourGraph, bump: Partial<Record<number, number>> = {}): Float64Array {
  const h = new Float64Array(g.chains.length).fill(NaN);
  for (const r of [5, 10, 15, 20]) h[chainAtRadius(g, r)] = BASE + (I * (20 - r)) / 5 + (bump[r] ?? 0);
  return h;
}

const metres = (f: HeightField, x: number, y: number): number => {
  const m = sampleHeight(f, { x, y });
  if (m === null) throw new Error(`no data at ${x}, ${y}`);
  return m;
};

describe("geodesicNearest (map-terrain.md §4.9)", () => {
  it("carries the nearest seed's value with the same distance as geodesicDistance", () => {
    const g = graphOf([10, 30].map((y) => ({ sym: S.contour, coords: line(0, y, 60, y) })), [0, 5, 60, 35]);
    const r = g.raster;
    const at = (x: number, y: number) => cellIndex(r, x, y);
    const seeds = new Int32Array([at(10, 15), at(50, 15)]);
    const { dist, value } = geodesicNearest(r, seeds, new Int16Array([7, -9]));
    expect([...dist]).toEqual([...geodesicDistance(r, seeds)]);
    expect(value[at(12, 16)]).toBe(7);
    expect(value[at(48, 14)]).toBe(-9);
    expect(value[at(30, 31)]).toBe(0); // across the chain: no seed reaches
  });

  it("refuses values that do not match the seeds", () => {
    const g = graphOf(CONE);
    expect(() => geodesicNearest(g.raster, new Int32Array([1, 2]), new Int16Array([1]))).toThrow(RangeError);
  });
});

describe("the anchored field (map-terrain.md §4.9)", () => {
  it("lays the cone at its absolute chain heights, datum absolute, offset a whole interval below", () => {
    const g = graphOf(CONE);
    const f = buildHeightField(g, coneLevels(g), { intervalM: I, anchored: { chainHeightsM: coneHeights(g), source: "contours.lantmateriet-2m", provider: LM } });
    expect(f.header).toMatchObject({ datum: "absolute", source: "contours.lantmateriet-2m", zOffsetM: 310, provider: LM, intervalM: I });
    for (const [x, expected] of [[30 + 7.5, BASE + 12.5], [30 + 12.5, BASE + 7.5], [30 + 17.5, BASE + 2.5]] as const) expect(Math.abs(metres(f, x, 30) - expected)).toBeLessThan(0.1 * I);
    expect(metres(f, 30, 30)).toBeGreaterThan(BASE + 15);
    expect(metres(f, 30, 30)).toBeLessThanOrEqual(BASE + 15 + I / 2 + 0.05);
    expect(heightFieldHeaderSchema.safeParse(f.header).success).toBe(true);
  });

  it("matches the relative field shifted, on a regular ladder", () => {
    const g = graphOf(CONE);
    const rel = buildHeightField(g, coneLevels(g), { intervalM: I });
    const abs = buildHeightField(g, coneLevels(g), { intervalM: I, anchored: { chainHeightsM: coneHeights(g), source: "contours.lantmateriet-2m" } });
    // relative 0 is the floor outside the 20 mm ring, which stands at 1 interval: absolute BASE − I
    for (let x = 12; x <= 48; x += 3) expect(Math.abs(metres(abs, x, 30) - (metres(rel, x, 30) + BASE - I))).toBeLessThan(0.05);
  });

  it("bends the surface at a chain off its ladder only", () => {
    const g = graphOf(CONE);
    const flat = buildHeightField(g, coneLevels(g), { intervalM: I, anchored: { chainHeightsM: coneHeights(g), source: "contours.lantmateriet-2m" } });
    const bent = buildHeightField(g, coneLevels(g), { intervalM: I, anchored: { chainHeightsM: coneHeights(g, { 15: 1.5 }), source: "contours.lantmateriet-2m" } });
    expect(metres(bent, 30 + 15.4, 30) - metres(flat, 30 + 15.4, 30)).toBeGreaterThan(1);
    expect(Math.abs(metres(bent, 30 + 4, 30) - metres(flat, 30 + 4, 30))).toBeLessThan(0.05);
  });

  it("lets a chain without a height seed nothing; its band takes the neighbours'", () => {
    const g = graphOf(CONE);
    const h = coneHeights(g);
    h[chainAtRadius(g, 10)] = NaN;
    const f = buildHeightField(g, coneLevels(g), { intervalM: I, anchored: { chainHeightsM: h, source: "contours.lantmateriet-2m" } });
    const m = metres(f, 30 + 10, 30);
    expect(m).toBeGreaterThan(BASE + 5);
    expect(m).toBeLessThan(BASE + 15);
    expect(f.z.some((v) => v === HEIGHT_NO_DATA)).toBe(false);
  });

  it("sets confidence from the chains it is told are good", () => {
    const g = graphOf(CONE);
    const n = g.chains.length;
    const none = buildHeightField(g, coneLevels(g), { intervalM: I, anchored: { chainHeightsM: coneHeights(g), chainConfident: new Uint8Array(n), source: "contours.lantmateriet-2m" } });
    const all = buildHeightField(g, coneLevels(g), { intervalM: I, anchored: { chainHeightsM: coneHeights(g), chainConfident: new Uint8Array(n).fill(1), source: "contours.lantmateriet-2m" } });
    const cells = none.header.width * none.header.height;
    const count = (f: HeightField) => Array.from({ length: cells }, (_, i) => isConfident(f, i)).filter(Boolean).length;
    expect(count(none)).toBe(0);
    expect(count(all)).toBeGreaterThan(cells * 0.9);
  });

  it("is deterministic and round-trips; the chain heights stay out of the bytes", () => {
    const g = graphOf(CONE);
    const opts = { intervalM: I, anchored: { chainHeightsM: coneHeights(g), source: "contours.lantmateriet-2m", provider: LM } } as const;
    const a = encodeHeightField(buildHeightField(g, coneLevels(g), opts));
    expect(a).toEqual(encodeHeightField(buildHeightField(g, coneLevels(g), opts)));
    const back = decodeHeightField(a);
    expect(back.header.provider).toEqual(LM);
    expect(Object.keys(back.header)).not.toContain("chainHeightsM");
  });

  it("refuses chain heights that do not match the graph", () => {
    const g = graphOf(CONE);
    expect(() => buildHeightField(g, coneLevels(g), { anchored: { chainHeightsM: new Float64Array(1), source: "contours.x-1m" } })).toThrow(RangeError);
  });

  it("puts the offset at the whole interval at or below the lowest chain", () => {
    expect(anchoredOffsetM([312.4, 330, NaN], 5)).toBe(310);
    expect(anchoredOffsetM([-3.2], 5)).toBe(-5);
    expect(anchoredOffsetM([NaN], 5)).toBe(0);
  });
});

describe("the header's DEM sources (map-terrain.md §5.1, §7.0 answer 3)", () => {
  const base = { version: 1, cellMm: 0.2, x0: 0, y0: 0, width: 1, height: 1, groundMPerMm: 15, intervalM: 5, zScaleM: 5 / 64, zOffsetM: 0, datum: "absolute", zMin: 0, zMax: 0 };
  it("accepts contours and the DEM forms, and nothing else", () => {
    for (const source of ["contours", "ground.lantmateriet-2m", "contours.glo30-30m"]) expect(heightFieldHeaderSchema.safeParse({ ...base, source }).success).toBe(true);
    for (const source of ["ground", "dem.lantmateriet-2m", "ground.Lantmateriet", "ground.", "ground.a/b", `ground.${"a".repeat(49)}`]) expect(heightFieldHeaderSchema.safeParse({ ...base, source }).success).toBe(false);
  });
  it("checks the provider block", () => {
    expect(heightFieldHeaderSchema.safeParse({ ...base, source: "ground.lantmateriet-2m", provider: LM }).success).toBe(true);
    expect(heightFieldHeaderSchema.safeParse({ ...base, source: "ground.lantmateriet-2m", provider: { ...LM, grade: "fine" } }).success).toBe(false);
    expect(heightFieldHeaderSchema.safeParse({ ...base, source: "ground.lantmateriet-2m", provider: { ...LM, attribution: "" } }).success).toBe(false);
  });
});

describe("the ground field (map-terrain.md §7.4)", () => {
  const grid = { version: 1, cellMm: 0.2, x0: 10, y0: 20, width: 50, height: 40, groundMPerMm: 15, intervalM: 5 };
  const plane = (x: number, y: number) => 400 + 0.1 * (x - 10) * 15 + 0.05 * (y - 20) * 15;

  it("samples the DEM at the cell centres on the given grid", () => {
    const f = buildGroundField(plane, { grid, source: "ground.lantmateriet-2m", provider: { ...LM, resolutionM: 2 } });
    expect(f.header).toMatchObject({ ...grid, datum: "absolute", source: "ground.lantmateriet-2m", zOffsetM: 400, provider: { resolutionM: 2 } });
    for (const [x, y] of [[10.1, 20.1], [15, 25], [19.9, 27.9]]) expect(Math.abs(metres(f, x, y) - plane(x, y))).toBeLessThan(0.05);
    expect(isConfident(f, 0)).toBe(true);
  });

  it("averages a box where a cell spans several DEM cells, and is unconfident for a coarse model", () => {
    // a checker of ±10 m at 1 m: a 3 m cell (0.2 mm at 1:15 000) averages it out
    const checker = (x: number, y: number) => 100 + (((Math.floor(x * 15) + Math.floor(y * 15)) & 1) === 0 ? 10 : -10);
    const f = buildGroundField(checker, { grid, source: "ground.glo30-30m", provider: { ...LM, id: "glo30-30m", resolutionM: 1, grade: "coarse" } });
    for (const [x, y] of [[12, 22], [17, 26]]) expect(Math.abs(metres(f, x, y) - 100)).toBeLessThan(3);
    expect(isConfident(f, 0)).toBe(false);
  });

  it("marks no-data where the DEM has none, and only there", () => {
    const holey = (x: number, y: number) => (x < 15 ? NaN : plane(x, y));
    const f = buildGroundField(holey, { grid, source: "ground.lantmateriet-2m", provider: LM });
    expect(f.z[0]).toBe(HEIGHT_NO_DATA);
    expect(f.z[grid.width - 1]).not.toBe(HEIGHT_NO_DATA);
    const empty = buildGroundField(() => NaN, { grid, source: "ground.lantmateriet-2m", provider: LM });
    expect(empty.header).toMatchObject({ zMin: 0, zMax: 0, zOffsetM: 0 });
    expect(empty.z.every((v) => v === HEIGHT_NO_DATA)).toBe(true);
  });
});
