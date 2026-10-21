import { describe, expect, it } from "vitest";
import { dashGrid, gapsOf, gridCentre, gridGaps, layoutDashesOcad, layoutDashesOmap } from "../dash.js";
import type { DashPattern } from "../symbol.js";

const near = (xs: number[][], tol = 1e-6) => xs.map(([a, b]) => [Math.round(a / tol) * tol, Math.round(b / tol) * tol]);

describe("layoutDashesOcad — gaps fixed, dashes stretched", () => {
  const p505: DashPattern = { layout: "ocad", dashUm: 2000, gapUm: 500 };

  it("picks the gap count nearest the nominal total and stretches dashes to fit", () => {
    // L = 20000: n = round((20000 − 4000 + 2000) / 2500) = 7 gaps, 8 dashes.
    const d = layoutDashesOcad(20000, p505);
    expect(d).toHaveLength(8);
    const r = (20000 - 7 * 500) / (8 * 2000); // 1.03125
    expect(near(d)).toEqual(
      near(Array.from({ length: 8 }, (_, i) => [i * (2000 * r + 500), i * (2000 * r + 500) + 2000 * r])),
    );
    expect(d[7][1]).toBe(20000);
    // Every gap is exactly nominal.
    for (const [a, b] of gapsOf(d)) expect(b - a).toBeCloseTo(500, 6);
  });

  it("fits exactly when the nominal pattern matches the length", () => {
    const d = layoutDashesOcad(20000, { ...p505, endDashUm: 1000 });
    // n = round((20000 − 2000 + 2000) / 2500) = 8; dashes 1000 + 7×2000 + 1000 = 16000 = 20000 − 8×500.
    expect(d).toHaveLength(9);
    expect(d[0]).toEqual([0, 1000]);
    expect(d[1]).toEqual([1500, 3500]);
    expect(d[8]).toEqual([19000, 20000]);
  });

  it("draws a short section as one solid dash, unless minGaps forces gaps", () => {
    expect(layoutDashesOcad(1500, p505)).toEqual([[0, 1500]]);
    const forced = layoutDashesOcad(3000, { ...p505, minGaps: 1 });
    expect(forced).toHaveLength(2);
    expect(forced[0][1] - forced[0][0]).toBeCloseTo(1250);
    expect(forced[1][0] - forced[0][1]).toBeCloseTo(500);
  });

  it("drops forced gaps one at a time until the dashes have positive length", () => {
    // minGaps 3 on 900 µm: 3 and 2 gaps leave nothing for dashes; 1 gap leaves 400 → two 200 µm dashes.
    expect(layoutDashesOcad(900, { ...p505, minGaps: 3 })).toEqual([[0, 200], [700, 900]]);
  });

  it("splits each interior dash by the secondary gap; end dashes only by the end gap", () => {
    // 8 dashes: the 6 interior ones are cut in two, the end dashes stay whole (no end gap).
    const d = layoutDashesOcad(20000, { ...p505, secondaryGapUm: 200 });
    expect(d).toHaveLength(1 + 6 * 2 + 1);
    expect(d[0][1] - d[0][0]).toBeCloseTo(2000 * ((20000 - 7 * 500) / 16000));
    expect(d[2][0] - d[1][1]).toBeCloseTo(200);
    const e = layoutDashesOcad(20000, { ...p505, endDashUm: 1000, secondaryGapUm: 200 });
    expect(e).toHaveLength(1 + 7 * 2 + 1);
    expect(e[0]).toEqual([0, 1000]);
    // ISOM 507: endGap = secGap cuts the end dashes too.
    const f = layoutDashesOcad(20000, { ...p505, secondaryGapUm: 200, endGapUm: 200 });
    expect(f).toHaveLength(16);
    expect(f[1][0] - f[0][1]).toBeCloseTo(200);
  });

  it("on a closed loop the two end dashes are halves that meet at the start point", () => {
    const d = layoutDashesOcad(10000, p505, { closedLoop: true });
    // E = 1000: n = round((10000 − 2000 + 2000) / 2500) = 4; dashes 1000 + 3×2000 + 1000 = 8000 = 10000 − 4×500.
    expect(d).toHaveLength(5);
    expect(d[0]).toEqual([0, 1000]);
    expect(d[4]).toEqual([9000, 10000]);
  });

  it("a secondary gap without a main gap lays out touching dashes and cuts them (517 ruined fence)", () => {
    const d = layoutDashesOcad(8000, { layout: "ocad", dashUm: 2000, gapUm: 0, endDashUm: 1000, secondaryGapUm: 350 });
    // 1000 + 3×2000 + 1000 = 8000 exactly: end dashes whole, three interior dashes cut at their centres.
    expect(d).toHaveLength(1 + 3 * 2 + 1);
    expect(d[0]).toEqual([0, 1000]);
    expect(d[1]).toEqual([1000, 1825]);
    expect(d[2]).toEqual([2175, 3000]);
    expect(d[7]).toEqual([7000, 8000]);
  });

  it("a zero gap is a solid line", () => {
    expect(layoutDashesOcad(5000, { layout: "ocad", dashUm: 2000, gapUm: 0 })).toEqual([[0, 5000]]);
  });
});

describe("layoutDashesOmap — whole pattern scaled", () => {
  const p: DashPattern = { layout: "omap", dashUm: 2000, gapUm: 500 };

  it("scales dashes and breaks by one factor", () => {
    // n = round(20500 / 2500) = 8 groups; nominal 8×2000 + 7×500 = 19500; f = 20000/19500.
    const d = layoutDashesOmap(20000, p);
    expect(d).toHaveLength(8);
    const f = 20000 / 19500;
    expect(d[0][1]).toBeCloseTo(2000 * f, 6);
    expect(d[1][0] - d[0][1]).toBeCloseTo(500 * f, 6);
    expect(d[7][1]).toBe(20000);
  });

  it("half outer dashes begin and end the line with half a dash", () => {
    // n = round((20000 − 2000 − 500) / 2500) = 7; nominal 2000 + 7×2000 + 8×500 = 20000 → f = 1.
    const d = layoutDashesOmap(20000, { ...p, halfOuterDashes: true });
    expect(d).toHaveLength(9);
    expect(d[0]).toEqual([0, 1000]);
    expect(d[1]).toEqual([1500, 3500]);
    expect(d[8]).toEqual([19000, 20000]);
  });

  it("groups dashes with the in-group break", () => {
    const d = layoutDashesOmap(20000, { ...p, dashesInGroup: 2, secondaryGapUm: 250 });
    // group = 4250; n = round(20500 / 4750) = 4; nominal 4×4250 + 3×500 = 18500.
    expect(d).toHaveLength(8);
    const f = 20000 / 18500;
    expect(d[1][0] - d[0][1]).toBeCloseTo(250 * f, 6);
    expect(d[2][0] - d[1][1]).toBeCloseTo(500 * f, 6);
  });

  it("very short lines: one dash by default, solid when showAtLeastOne is false", () => {
    expect(layoutDashesOmap(800, p)).toEqual([[0, 800]]);
    expect(layoutDashesOmap(800, { ...p, showAtLeastOne: false })).toEqual([[0, 800]]);
    // Half outer dashes with no full group: half, break, half — scaled by 1500 / 2500.
    expect(layoutDashesOmap(1500, { ...p, halfOuterDashes: true })).toEqual([[0, 600], [900, 1500]]);
  });

  it("closed loops wrap the first group around the start point", () => {
    const d = layoutDashesOmap(10000, p, { closedLoop: true });
    // n = round(10000 / 2500) = 4; f = 1; first group centred on 0 → [9000, 10000] + [0, 1000].
    expect(d).toHaveLength(5);
    expect(d[0]).toEqual([0, 1000]);
    expect(d[1]).toEqual([1500, 3500]);
    expect(d[4]).toEqual([9000, 10000]);
  });

  it("a dash point centres a single dash: half of it on each side", () => {
    // halfStart: hs = 1; n = round((10000 − 1000) / 2500) = 4; nominal 1000 + 4×2000 + 4×500 = 11000.
    const f = 10000 / 11000;
    const g = dashGrid(10000, p, { halfStart: true });
    expect(g.dashes[0].a).toBeCloseTo(-1000 * f, 6);
    expect(g.dashes[0].b).toBeCloseTo(1000 * f, 6);
    expect(g.dashes).toHaveLength(5);
    const d = layoutDashesOmap(10000, p, { halfStart: true });
    expect(d[0][0]).toBe(0);
    expect(d[0][1]).toBeCloseTo(1000 * f, 6);
    expect(d[1][0]).toBeCloseTo(1500 * f, 6);
    expect(d[4][1]).toBe(10000);
    // Groups are not halved at dash points (Mapper halves single dashes only).
    const grouped = dashGrid(10000, { ...p, dashesInGroup: 2, secondaryGapUm: 250 }, { halfStart: true });
    expect(grouped.dashes[0].a).toBe(0);
  });
});

describe("dash points (flag 8) — a dash is centred on the point", () => {
  const p505: DashPattern = { layout: "ocad", dashUm: 2000, gapUm: 500 };

  it("OCAD: the section ends with half a dash at a dash point and a full end dash elsewhere", () => {
    // Es = 2000 (line start), Ee = 1000 (dash point): n = round((10000 − 3000 + 2000) / 2500) = 4,
    // r = (10000 − 4×500) / (2000 + 1000 + 3×2000) = 8/9.
    const r = 8 / 9;
    const g = dashGrid(10000, p505, { halfEnd: true });
    expect(g.dashes).toHaveLength(5);
    const last = g.dashes[4];
    expect((last.a + last.b) / 2).toBeCloseTo(10000, 6);
    expect(last.b - last.a).toBeCloseTo(2000 * r, 6);
    expect(near(layoutDashesOcad(10000, p505, { halfEnd: true }), 1e-3)).toEqual(
      near([[0, 2000 * r], [2000 * r + 500, 4000 * r + 500], [4000 * r + 1000, 6000 * r + 1000], [6000 * r + 1500, 8000 * r + 1500], [10000 - 1000 * r, 10000]], 1e-3),
    );
    // The next section starts with the other half: Es = 1000, Ee = 2000, n = 2, r = 1.
    expect(layoutDashesOcad(6000, p505, { halfStart: true })).toEqual([[0, 1000], [1500, 3500], [4000, 6000]]);
  });

  it("OCAD: a section shorter than one dash next to a dash point is one interior (uncut) dash", () => {
    const g = dashGrid(1500, { ...p505, secondaryGapUm: 200, endGapUm: 200 }, { halfStart: true });
    expect(g.dashes).toEqual([{ a: 0, b: 1500, end: false }]);
    // Without a dash point the same section is an end dash, cut by the end gap.
    expect(dashGrid(1500, { ...p505, secondaryGapUm: 200, endGapUm: 200 }).dashes.every((d) => d.end)).toBe(true);
  });

  it("OCAD: the secondary gap of a dash on a dash point lies symmetrically about the point", () => {
    const d = layoutDashesOcad(6000, { ...p505, secondaryGapUm: 200 }, { halfStart: true });
    // Whole dash [−1000, 1000] cut in two 900 µm parts → this side keeps [100, 1000]; end dash stays whole.
    expect(d).toEqual([[100, 1000], [1500, 2400], [2600, 3500], [4000, 6000]]);
  });

  it("grid centres: a dash on a dash point is owned by the section that starts there", () => {
    const end = dashGrid(10000, p505, { halfEnd: true });
    expect(gridCentre(end, (end.dashes[4].a + end.dashes[4].b) / 2)).toBeUndefined();
    const start = dashGrid(6000, p505, { halfStart: true });
    expect(gridCentre(start, (start.dashes[0].a + start.dashes[0].b) / 2)).toBe(0);
    // A closed loop folds its seam dash onto the start point.
    const loop = dashGrid(10000, p505, { closedLoop: true });
    expect(gridCentre(loop, (loop.dashes[0].a + loop.dashes[0].b) / 2)).toBe(0);
    expect(gridGaps(loop)).toHaveLength(4);
  });
});
