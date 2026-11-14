import { describe, expect, it } from "vitest";
import { buildContourGraph, type ContourGraph } from "../../graph/index.js";
import { S, mapped, ring, syntheticDoc, type Obj } from "../../graph/__tests__/synthetic.js";
import { anchorLevels } from "../anchor.js";
import { ANCHOR_STATUS, NO_LEVEL, type AnchorOptions, type DemSampler } from "../types.js";
import { seeded } from "./synthetic-dem.js";

const G = 15;
const I = 5;
const SLOPE = 0.1; // m per ground m: 1.5 m per paper mm
const LM: AnchorOptions = { intervalM: I, source: "lantmateriet-1m", grade: "anchor", demCellM: 1 };
const GLO: AnchorOptions = { intervalM: I, source: "glo30", grade: "coarse", demCellM: 30 };

interface HillSpec {
  cx: number;
  cy: number;
  phase: number;
  /** Contour levels k (height phase + I·k); index contours at k ≡ 0 mod 5. */
  levels: number[];
  /** The cone's top, metres. */
  top: number;
  /** Index contours at k ≡ indexAt mod 5 (default 0). */
  indexAt?: number;
}

/** Rings at the DEM's own iso-lines of a cone: the mapper drew the ground exactly. */
function hillObjects(h: HillSpec): Obj[] {
  return h.levels.map((k) => {
    const r = (h.top - (h.phase + I * k)) / (SLOPE * G);
    return { sym: k % 5 === (h.indexAt ?? 0) ? S.index : S.contour, coords: ring(h.cx, h.cy, r, 96) };
  });
}

const coneDem = (hs: HillSpec[]): DemSampler => (x, y) => {
  let best = -Infinity;
  for (const h of hs) best = Math.max(best, h.top - SLOPE * G * Math.hypot(x - h.cx, y - h.cy));
  return best;
};

const graphOf = (objs: Obj[]): ContourGraph => buildContourGraph(syntheticDoc(mapped(objs)))!;
const hillA: HillSpec = { cx: 0, cy: 0, phase: 2.6, levels: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], top: 2.6 + 50 };

describe("anchorLevels (§6.4, §6.7, §6.9)", () => {
  it("anchors a shifted ladder: every chain accepted, snapped at its level, height the median", () => {
    const g = graphOf(hillObjects(hillA));
    const a = anchorLevels(g, coneDem([hillA]), LM);
    expect(a.levelsAllowed).toBe(true);
    expect(a.ladders).toHaveLength(1);
    expect(a.ladders[0].phaseM).toBeCloseTo(2.6, 0);
    const levels: number[] = [];
    for (let i = 0; i < g.chains.length; i++) {
      expect(a.chains.status[i]).toBe(ANCHOR_STATUS.snapped);
      expect(a.chains.height[i]).toBe(a.chains.median[i]);
      expect(a.chains.side[i]).toBe(1);
      expect(Math.abs(a.chains.residual[i])).toBeLessThan(0.3 * I);
      levels.push(a.chains.ladderLevel[i]);
    }
    expect(levels.sort((x, y) => x - y)).toEqual([...hillA.levels]);
    expect(a.report.share.snapped).toBeCloseTo(1);
    expect(a.report.share.sideDecided).toBeCloseTo(1);
    expect(a.report.interval.rAtI).toBeGreaterThan(0.95);
    expect(a.report.index.snappedShare).toBeCloseTo(1);
    expect(a.report.index.onOneResiduePerArea).toBeCloseTo(1);
    expect(a.report.areas).toHaveLength(1);
    expect(a.report.areas[0].indexResidue).toBe(0);
    expect(a.report.intervalSuspect).toBe(false);
  });

  it("hands §3 the DEM side as its ExternalSide", () => {
    const g = graphOf(hillObjects(hillA));
    const a = anchorLevels(g, coneDem([hillA]), LM);
    expect(a.external.source).toBe("lantmateriet-1m");
    expect(a.external.side).toBeInstanceOf(Int8Array);
    expect(a.external.side.length).toBe(g.chains.length);
    expect([...a.external.side]).toEqual([...a.chains.side]);
  });

  it("keeps the unsnapped median under noise", () => {
    const g = graphOf(hillObjects(hillA));
    const base = coneDem([hillA]);
    const noisy: DemSampler = (x, y) => base(x, y) + 0.6 * Math.sin(x * 7.3 + y * 3.1) * Math.cos(x * 2.9 - y * 5.7);
    const a = anchorLevels(g, noisy, LM);
    for (let i = 0; i < g.chains.length; i++) {
      expect(a.chains.status[i]).toBe(ANCHOR_STATUS.snapped);
      expect(a.chains.halfIqr[i]).toBeGreaterThan(0.01);
      expect(a.chains.height[i]).toBe(a.chains.median[i]);
    }
  });

  it("leaves a chain across the slope spread-failed, with no height", () => {
    const objs = [...hillObjects(hillA), { sym: S.contour, coords: ring(12, 0, 8, 64) }];
    const g = graphOf(objs);
    const a = anchorLevels(g, coneDem([hillA]), LM);
    const centreX = (p: Float64Array) => p.reduce((a, v, j) => (j % 2 ? a : a + v), 0) / (p.length / 2);
    const odd = g.chains.findIndex((c) => centreX(c.pts) > 6);
    expect(odd).toBeGreaterThanOrEqual(0);
    expect(a.chains.status[odd]).toBe(ANCHOR_STATUS.spreadFailed);
    expect(a.chains.height[odd]).toBeNaN();
    expect(a.chains.ladderLevel[odd]).toBe(NO_LEVEL);
    expect(a.report.share.spreadFailed).toBeGreaterThan(0);
  });

  it("marks chains outside the DEM uncovered", () => {
    const g = graphOf(hillObjects(hillA));
    const base = coneDem([hillA]);
    const a = anchorLevels(g, (x, y) => (x > 15 ? NaN : base(x, y)), LM);
    const outer = g.chains.map((c, i) => [c.lengthMm, i]).sort((p, q) => q[0] - p[0])[0][1];
    expect(a.chains.status[outer]).toBe(ANCHOR_STATUS.uncovered);
    expect(a.chains.side[outer]).toBe(0);
    expect(a.report.coverage).toBeLessThan(1);
  });

  it("levels two ladders per area, never per map", () => {
    const hillB: HillSpec = { cx: 140, cy: 0, phase: 0.1, levels: [3, 4, 5, 6, 7, 8, 9, 10, 11, 12], top: 0.1 + 65 };
    const g = graphOf([...hillObjects(hillA), ...hillObjects(hillB)]);
    const a = anchorLevels(g, coneDem([hillA, hillB]), LM);
    expect(a.ladders).toHaveLength(2);
    expect(a.report.areas).toHaveLength(2);
    for (let i = 0; i < g.chains.length; i++) {
      expect(a.chains.status[i]).toBe(ANCHOR_STATUS.snapped);
      const onB = g.chains[i].pts[0] > 70;
      expect(a.chains.phase[i]).toBeCloseTo(onB ? 0.1 : 2.6, 0);
      expect(a.chains.phase[i] + I * a.chains.ladderLevel[i]).toBeCloseTo(a.chains.median[i], 0);
    }
    expect(a.report.index.onOneResiduePerArea).toBeCloseTo(1);
    expect(a.report.interval.rAtI).toBeLessThan(0.6);
  });

  it("splits one ladder's area where the map's index contours change residue", () => {
    // Two hills on one ladder, 1.1 km apart (one connected area), with index contours on different levels.
    const hillB: HillSpec = { cx: 73, cy: 0, phase: 2.6, levels: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], top: 2.6 + 50, indexAt: 1 };
    const g = graphOf([...hillObjects(hillA), ...hillObjects(hillB)]);
    const a = anchorLevels(g, coneDem([hillA, hillB]), LM);
    expect(a.ladders).toHaveLength(1);
    expect(a.report.areas).toHaveLength(2);
    expect(a.report.areas.map((x) => x.indexResidue).sort()).toEqual([0, 1]);
    expect(a.report.index.onOneResiduePerArea).toBeCloseTo(1);
    expect(a.report.index.inAreasShare).toBeCloseTo(1);
    const onB = (i: number) => g.chains[i].pts[0] > 36;
    const areaA = a.chains.area[g.chains.findIndex((_, i) => !onB(i))];
    for (let i = 0; i < g.chains.length; i++) expect(a.chains.area[i] === areaA).toBe(!onB(i));
  });

  it("a coarse model with a clear ladder is promoted", () => {
    const g = graphOf(hillObjects(hillA));
    const a = anchorLevels(g, coneDem([hillA]), GLO);
    expect(a.grade).toBe("coarse");
    expect(a.levelsAllowed).toBe(true);
    expect(a.report.share.snapped).toBeCloseTo(1);
  });

  it("a coarse model without R(I) ≥ 0.6 gives no per-chain heights or levels", () => {
    const rnd = seeded(11);
    const objs: Obj[] = [];
    for (let k = 0; k < 12; k++) objs.push({ sym: S.contour, coords: ring(0, 0, 3 + k * 2.5 + rnd() * 2, 96) });
    const g = graphOf(objs);
    const a = anchorLevels(g, coneDem([hillA]), GLO);
    expect(a.report.interval.rAtI).toBeLessThan(0.6);
    expect(a.levelsAllowed).toBe(false);
    for (let i = 0; i < g.chains.length; i++) {
      expect(a.chains.status[i]).toBe(ANCHOR_STATUS.coarse);
      expect(a.chains.height[i]).toBeNaN();
      expect(a.chains.ladderLevel[i]).toBe(NO_LEVEL);
    }
    expect(a.chains.side.every((s) => s === 1)).toBe(true);
  });

  it("without a ladder every accepted chain is unsnapped", () => {
    // Short rings (under 60 m of ground) contribute nothing to the ladders.
    const objs: Obj[] = [0.45, 0.6].map((r) => ({ sym: S.contour, coords: ring(0, 0, r, 24) }));
    const g = graphOf(objs);
    const a = anchorLevels(g, coneDem([hillA]), LM);
    expect(a.ladders).toHaveLength(0);
    for (let i = 0; i < g.chains.length; i++) {
      expect(a.chains.status[i]).toBe(ANCHOR_STATUS.unsnapped);
      expect(a.chains.height[i]).toBe(a.chains.median[i]);
    }
    expect(a.report.share.unlabelled).toBeCloseTo(1);
  });

  it("flags a suspect interval when two phases half an interval apart mix everywhere", () => {
    const half: HillSpec = { cx: 0, cy: 0, phase: 2.6, levels: [], top: 2.6 + 50 };
    const objs: Obj[] = [];
    for (let k = 0; k < 20; k++) {
      const h = 2.6 + 2.5 * k;
      objs.push({ sym: S.contour, coords: ring(0, 0, (half.top - h) / (SLOPE * G), 96) });
    }
    const g = graphOf(objs);
    const a = anchorLevels(g, coneDem([half]), LM);
    expect(a.report.interval.rAtHalfI).toBeGreaterThan(0.9);
    expect(a.report.intervalSuspect).toBe(true);
  });

  it("is deterministic", () => {
    const g = graphOf(hillObjects(hillA));
    expect(anchorLevels(g, coneDem([hillA]), LM)).toEqual(anchorLevels(g, coneDem([hillA]), LM));
  });
});
