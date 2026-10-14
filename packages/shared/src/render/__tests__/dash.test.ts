import { describe, expect, it } from "vitest";
import { gapsOf, layoutDashesOcad, layoutDashesOmap } from "../dash.js";
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

  it("splits each dash by the secondary gap, end dashes of a different length excepted", () => {
    const d = layoutDashesOcad(20000, { ...p505, secondaryGapUm: 200 });
    expect(d).toHaveLength(16);
    expect(d[1][0] - d[0][1]).toBeCloseTo(200);
    const e = layoutDashesOcad(20000, { ...p505, endDashUm: 1000, secondaryGapUm: 200 });
    expect(e).toHaveLength(1 + 7 * 2 + 1);
    expect(e[0]).toEqual([0, 1000]);
  });

  it("on a closed loop the two end dashes are halves that meet at the start point", () => {
    const d = layoutDashesOcad(10000, p505, { closedLoop: true });
    // E = 1000: n = round((10000 − 2000 + 2000) / 2500) = 4; dashes 1000 + 3×2000 + 1000 = 8000 = 10000 − 4×500.
    expect(d).toHaveLength(5);
    expect(d[0]).toEqual([0, 1000]);
    expect(d[4]).toEqual([9000, 10000]);
  });

  it("end gaps shorten the fitted range at both ends", () => {
    const d = layoutDashesOcad(21000, { ...p505, endGapUm: 500 });
    expect(d[0][0]).toBe(500);
    expect(d[d.length - 1][1]).toBe(20500);
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
    expect(d[0]).toEqual([9000, 10000]);
    expect(d[1]).toEqual([0, 1000]);
    expect(d[2]).toEqual([1500, 3500]);
  });
});
