import { describe, expect, it } from "vitest";
import { buildContourGraph, type ContourGraph } from "../../graph/index.js";
import { S, mapped, ring, syntheticDoc, type Obj } from "../../graph/__tests__/synthetic.js";
import { anchorLevels } from "../anchor.js";
import { anchoredHeights } from "../resolve.js";
import { ANCHOR_STATUS, HEIGHT_SOURCE, type AnchorOptions, type DemAnchor, type DemSampler, type SolvedLevels } from "../types.js";
import { seeded } from "./synthetic-dem.js";

const G = 15;
const I = 5;
const SLOPE = 0.1;
const PHASE = 2.6;
const TOP = PHASE + 50;
const LM: AnchorOptions = { intervalM: I, source: "lantmateriet-1m", grade: "anchor", demCellM: 1 };
const GLO: AnchorOptions = { intervalM: I, source: "glo30", grade: "coarse", demCellM: 30 };
const dem: DemSampler = (x, y) => TOP - SLOPE * G * Math.hypot(x, y);

/** Ten nested rings at the cone's iso-lines PHASE + I·k, k = 0 (outermost) … 9. */
function hill(): { g: ContourGraph; k: number[] } {
  const objs: Obj[] = [];
  for (let k = 0; k < 10; k++) objs.push({ sym: k % 5 === 0 ? S.index : S.contour, coords: ring(0, 0, (TOP - (PHASE + I * k)) / (SLOPE * G), 96) });
  const g = buildContourGraph(syntheticDoc(mapped(objs)))!;
  const k = g.chains.map((c) => Math.round((50 - SLOPE * G * (c.lengthMm / (2 * Math.PI))) / I));
  return { g, k };
}

/** §3's solution as a mirror: one component, levels relative (k − 3), sides uphill-left. */
function solved(g: ContourGraph, level: (i: number) => number): SolvedLevels {
  const n = g.chains.length;
  const regionComponent = new Int32Array(g.raster.regionCount + 1).fill(1);
  regionComponent[0] = 0;
  return {
    side: new Int8Array(n).fill(1),
    chainLevel: new Int32Array(n).map((_, i) => level(i)),
    chainStep: new Uint8Array(n).fill(1),
    regionComponent,
  };
}

/** The DEM failed these chains' spread test. */
function fail(a: DemAnchor, chains: number[]): DemAnchor {
  for (const i of chains) {
    a.chains.status[i] = ANCHOR_STATUS.spreadFailed;
    a.chains.height[i] = NaN;
  }
  return a;
}

describe("anchoredHeights (§6.8)", () => {
  it("keeps the DEM median of accepted chains", () => {
    const { g, k } = hill();
    const a = anchorLevels(g, dem, LM);
    const h = anchoredHeights(g, a, solved(g, (i) => k[i] - 3));
    for (let i = 0; i < g.chains.length; i++) {
      expect(h.source[i]).toBe(HEIGHT_SOURCE.dem);
      expect(h.height[i]).toBe(a.chains.median[i]);
    }
    expect(h.report.share.dem).toBeCloseTo(1);
    expect(h.report.drift).toEqual({ "0": 1 });
    expect(h.componentOffset.get(1)).toBeCloseTo(PHASE + 3 * I, 1);
    expect(h.coarse).toBe(false);
  });

  it("gives a spread-failed chain its neighbours' height and §3's step", () => {
    const { g, k } = hill();
    const five = k.indexOf(5);
    const a = fail(anchorLevels(g, dem, LM), [five]);
    const h = anchoredHeights(g, a, solved(g, (i) => k[i] - 3));
    expect(h.source[five]).toBe(HEIGHT_SOURCE.neighbours);
    expect(h.height[five]).toBeCloseTo(PHASE + 5 * I, 1);
    expect(h.bounded[five]).toBe(0);
  });

  it("bounds a chain whose §3 level disagrees with its anchored neighbours", () => {
    const { g, k } = hill();
    const five = k.indexOf(5);
    const a = fail(anchorLevels(g, dem, LM), [five]);
    // §3's levels drift by one from chain 6 inward: chain 5's candidates are h4 + I and h6 − 2I.
    const six = k.indexOf(6);
    const h = anchoredHeights(g, a, solved(g, (i) => (k[i] >= 6 ? k[i] - 2 : k[i] - 3)));
    expect(h.height[five]).toBeGreaterThanOrEqual(a.chains.median[k.indexOf(4)] - 1e-9);
    expect(six).toBeGreaterThanOrEqual(0);
    expect(h.bounded[five]).toBe(1);
    const h6 = a.chains.median[k.indexOf(6)];
    expect(h.height[five]).toBeLessThanOrEqual(h6 + 1e-9);
    expect(h.report.bounded).toBeGreaterThan(0);
  });

  it("clamps a height between its anchored neighbours", () => {
    const { g, k } = hill();
    const five = k.indexOf(5);
    const a = fail(anchorLevels(g, dem, LM), [five]);
    // §3: ring 4 at 1, ring 5 at 4, ring 6 at 5 — candidates h4 + 3I and h6 − I; the longer ring 4 wins the median, above h6.
    const h = anchoredHeights(g, a, solved(g, (i) => (k[i] === 5 ? 4 : k[i] >= 6 ? k[i] - 1 : k[i] - 3)));
    expect(h.bounded[five]).toBe(1);
    expect(h.height[five]).toBeCloseTo(a.chains.median[k.indexOf(6)], 9);
  });

  it("finds anchored chains at exactly three bands", () => {
    const { g, k } = hill();
    const a = fail(anchorLevels(g, dem, LM), [3, 4, 5, 6, 7].map((v) => k.indexOf(v)));
    const h = anchoredHeights(g, a, solved(g, (i) => k[i] - 3));
    const five = k.indexOf(5);
    expect(h.source[five]).toBe(HEIGHT_SOURCE.neighbours);
    expect(h.height[five]).toBeCloseTo(PHASE + 5 * I, 1);
  });

  it("gives a chain §3 left undecided no component: no height from §3, no part in the offset", () => {
    const { g, k } = hill();
    const five = k.indexOf(5);
    const a = fail(anchorLevels(g, dem, LM), [five]);
    const s = solved(g, (i) => k[i] - 3);
    s.side[five] = 0;
    s.chainStep[five] = 0;
    const h = anchoredHeights(g, a, s);
    expect(h.source[five]).toBe(HEIGHT_SOURCE.none);
    // Accepted and undecided: the DEM height is kept, but it is not in the drift report.
    const a2 = anchorLevels(g, dem, LM);
    const h2 = anchoredHeights(g, a2, s);
    expect(h2.source[five]).toBe(HEIGHT_SOURCE.dem);
    expect(Object.values(h2.report.drift).reduce((p, q) => p + q, 0)).toBeCloseTo(1);
  });

  it("searches up to three bands for anchored chains", () => {
    const { g, k } = hill();
    const a = fail(anchorLevels(g, dem, LM), [4, 5, 6].map((v) => k.indexOf(v)));
    const h = anchoredHeights(g, a, solved(g, (i) => k[i] - 3));
    const five = k.indexOf(5);
    expect(h.source[five]).toBe(HEIGHT_SOURCE.neighbours);
    expect(h.height[five]).toBeCloseTo(PHASE + 5 * I, 1);
  });

  it("falls back to the component offset beyond three bands", () => {
    const { g, k } = hill();
    const a = fail(anchorLevels(g, dem, LM), [1, 2, 3, 4, 5, 6, 7, 8].map((v) => k.indexOf(v)));
    const h = anchoredHeights(g, a, solved(g, (i) => k[i] - 3));
    const five = k.indexOf(5);
    expect(h.source[five]).toBe(HEIGHT_SOURCE.component);
    expect(h.height[five]).toBeCloseTo(PHASE + 5 * I, 1);
    expect(h.source[k.indexOf(2)]).toBe(HEIGHT_SOURCE.neighbours);
  });

  it("gives no height without an accepted chain in the component, or without a level", () => {
    const { g, k } = hill();
    const a = fail(anchorLevels(g, dem, LM), g.chains.map((_, i) => i));
    const h = anchoredHeights(g, a, solved(g, (i) => (k[i] === 9 ? -2147483648 : k[i] - 3)));
    for (let i = 0; i < g.chains.length; i++) {
      expect(h.source[i]).toBe(HEIGHT_SOURCE.none);
      expect(h.height[i]).toBeNaN();
    }
    expect(h.report.share.none).toBeCloseTo(1);
  });

  it("reports §3's level drift against the DEM, in intervals", () => {
    const { g, k } = hill();
    const a = anchorLevels(g, dem, LM);
    // §3's levels drift by one interval inside rings 7–9.
    const h = anchoredHeights(g, a, solved(g, (i) => k[i] - 3 + (k[i] >= 7 ? 1 : 0)));
    expect(Object.keys(h.report.drift).sort()).toEqual(["-1", "0"]);
    expect(h.report.drift["0"]).toBeGreaterThan(h.report.drift["-1"]);
  });

  it("an unpromoted coarse model gives a component offset and bounds drift beyond ±1 interval", () => {
    const rnd = seeded(11);
    const objs: Obj[] = [];
    const radii: number[] = [];
    for (let j = 0; j < 12; j++) {
      const r = 3 + j * 2.5 + rnd() * 2;
      radii.push(r);
      objs.push({ sym: S.contour, coords: ring(0, 0, r, 96) });
    }
    const g = buildContourGraph(syntheticDoc(mapped(objs)))!;
    const a = anchorLevels(g, dem, GLO);
    expect(a.levelsAllowed).toBe(false);
    // §3 sees one level per ring, outermost lowest; the inner three drift up by two intervals.
    const order = g.chains.map((c, i) => [c.lengthMm, i]).sort((p, q) => q[0] - p[0]).map((p) => p[1]);
    const rank = new Int32Array(g.chains.length);
    order.forEach((i, r) => (rank[i] = r));
    const h = anchoredHeights(g, a, solved(g, (i) => rank[i] + (rank[i] >= 9 ? 2 : 0)));
    expect(h.coarse).toBe(true);
    for (let i = 0; i < g.chains.length; i++) {
      expect(h.source[i]).toBe(HEIGHT_SOURCE.component);
      expect(Math.abs(h.height[i] - a.chains.median[i])).toBeLessThanOrEqual(1.5 * I);
    }
    expect(h.report.driftShifted).toBeGreaterThan(0);
  });

  it("is deterministic", () => {
    const { g, k } = hill();
    const run = () => anchoredHeights(g, fail(anchorLevels(g, dem, LM), [k.indexOf(5)]), solved(g, (i) => k[i] - 3));
    expect(run()).toEqual(run());
  });
});
