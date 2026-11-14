import { describe, expect, it } from "vitest";
import { CLASS, solveTerrain } from "../../solve/index.js";
import { build, ring, S, tick, type Obj } from "../../solve/__tests__/fixtures.js";
import { anchorLevels } from "../anchor.js";
import { anchoredHeights } from "../resolve.js";
import { ANCHOR_STATUS, HEIGHT_SOURCE, type AnchorOptions, type DemSampler } from "../types.js";

const G = 15;
const I = 5;
const SLOPE = 0.1;
const PHASE = 2.6;
const TOP = PHASE + 50;
const LM: AnchorOptions = { intervalM: I, source: "lantmateriet-1m", grade: "anchor", demCellM: 1 };
const dem: DemSampler = (x, y) => TOP - SLOPE * G * Math.hypot(x, y);
const radius = (k: number) => (TOP - (PHASE + I * k)) / (SLOPE * G);

/** Ten nested rings at the cone's iso-lines PHASE + I·k (objects 0…9), and a tick on ring 5 pointing uphill (object 10): wrong. */
function hillWithWrongTick() {
  const objs: Obj[] = [];
  for (let k = 0; k < 10; k++) objs.push({ sym: k % 5 === 0 ? S.index : S.contour, coords: ring(0, 0, radius(k), 96) });
  objs.push(tick(radius(5), 0, -1, 0));
  return build(objs);
}

describe("the DEM anchor with §3's solve (§3.0 answer 1, §6.3, §6.8)", () => {
  it("the DEM side decides over a disagreeing tick, and the disagreement is counted", () => {
    const { g, chain } = hillWithWrongTick();
    const a = anchorLevels(g, dem, LM);
    const ring5 = chain(5);
    expect(a.chains.side[ring5]).toBe(1);
    const alone = solveTerrain(g);
    expect(alone.side[ring5]).toBe(-1);
    const sol = solveTerrain(g, { external: a.external });
    expect(sol.side[ring5]).toBe(1);
    expect(sol.signClass[ring5]).toBe(CLASS.dem);
    expect(sol.report.external?.source).toBe("lantmateriet-1m");
    expect(sol.report.external?.disagreements).toEqual({ tick: 1, cliff: 0, lake: 0 });
  });

  it("anchors heights on the solution: the DEM where accepted, §3's step for a spread-failed chain", () => {
    const { g, chain } = hillWithWrongTick();
    const a = anchorLevels(g, dem, LM);
    const sol = solveTerrain(g, { external: a.external });
    const ring5 = chain(5);
    a.chains.status[ring5] = ANCHOR_STATUS.spreadFailed;
    a.chains.height[ring5] = NaN;
    const h = anchoredHeights(g, a, sol);
    for (let k = 0; k < 10; k++) {
      const i = chain(k);
      expect(h.height[i]).toBeCloseTo(PHASE + I * k, 0);
      expect(h.source[i]).toBe(k === 5 ? HEIGHT_SOURCE.neighbours : HEIGHT_SOURCE.dem);
    }
    expect(h.report.drift).toEqual({ "0": 1 });
  });
});
