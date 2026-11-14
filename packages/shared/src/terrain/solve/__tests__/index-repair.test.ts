import { describe, expect, it } from "vitest";
import { CLASS, CLIFF_STEP_SOURCE, solveTerrain } from "../index.js";
import { S, arc, build, line, regionAt, tick, type Obj } from "./fixtures.js";

const mod5 = (v: number) => ((v % 5) + 5) % 5;

/**
 * A slope rising north. Contours at y = 5 (index), 8, 11; a tagged cliff
 * across the map at y = 14 stands for the two contours that would follow;
 * above it the index contour at y = 17 (five levels above the first) and
 * one more at y = 20. The cliff splits the band: below and above it are
 * joined only by the cliff link.
 */
const CLIFF_HIDES_TWO: Obj[] = [
  { sym: S.index, coords: line(0, 5, 60, 5) },
  { sym: S.contour, coords: line(0, 8, 60, 8) },
  { sym: S.contour, coords: line(0, 11, 60, 11) },
  { sym: S.cliffTagged, coords: line(-5, 14, 65, 14) },
  { sym: S.index, coords: line(0, 17, 60, 17) },
  { sym: S.contour, coords: line(0, 20, 60, 20) },
  tick(20, 8, 0, -1),
];
const AREA: [number, number, number, number] = [0, 0, 60, 24];

describe("index contours set the step across a cliff (map-terrain.md §3.5)", () => {
  it("recovers a cliff hiding two contours from the index contours", () => {
    const { g, chain } = build(CLIFF_HIDES_TWO, AREA);
    const below = regionAt(g, 30, 12.5), above = regionAt(g, 30, 15.5);
    expect(below).not.toBe(above);
    const link = g.cliffLinks.findIndex(([a, b]) => (a === below && b === above) || (a === above && b === below));
    expect(link).toBeGreaterThanOrEqual(0);

    const sol = solveTerrain(g);
    const lo = chain(0), hi = chain(4);
    expect(sol.side[lo]).toBe(1);
    expect(sol.side[hi]).toBe(1);
    expect(sol.chainLevel[hi] - sol.chainLevel[lo]).toBe(5);
    expect(sol.regionLevel[above] - sol.regionLevel[below]).toBe(2);
    expect(sol.cliffStepSource[link]).toBe(CLIFF_STEP_SOURCE.index);
    expect(sol.report.index.stepsSet).toBe(1);
    expect(sol.report.index.consistency).toBe(1);
  });

  it("leaves the cliff at the assumed zero step without index repair", () => {
    const { g, chain } = build(CLIFF_HIDES_TWO, AREA);
    const sol = solveTerrain(g, { indexRepair: false });
    expect(sol.chainLevel[chain(4)] - sol.chainLevel[chain(0)]).toBe(3);
    expect([...sol.cliffStepSource]).toContain(CLIFF_STEP_SOURCE.assumed);
    expect(sol.report.index.consistency).toBe(0);
  });

  it("leaves the step alone when no index contour lies above the cliff", () => {
    const objects = CLIFF_HIDES_TWO.map((o, k) => (k === 4 ? { ...o, sym: S.contour } : o));
    const { g } = build(objects, AREA);
    const sol = solveTerrain(g);
    expect(sol.report.index.stepsSet).toBe(0);
    expect([...sol.cliffStepSource]).not.toContain(CLIFF_STEP_SOURCE.index);
  });
});

/**
 * A band between an index contour at y = 20 (level L) and a contour at
 * y = 80, both ticked uphill to the north. In the band a depression cut by
 * the west frame: six arcs around (0, 50), the outermost and the innermost
 * index contours. The band rule takes the outermost arc for an upper
 * boundary (wrong: it is a depression), slope propagation carries that into
 * the nest; the index contours inside then sit off the band's residue.
 */
function depressionNest(withTickInside: boolean): Obj[] {
  const radii = [24, 20, 16, 12, 8, 4];
  const objs: Obj[] = [
    { sym: S.index, coords: line(0, 20, 60, 20) },
    { sym: S.contour, coords: line(0, 80, 60, 80) },
    tick(40, 20, 0, -1),
    tick(40, 80, 0, -1),
    ...radii.map((r, k): Obj => ({ sym: k === 0 || k === 5 ? S.index : S.contour, coords: arc(0, 50, r, -100, 100) })),
  ];
  // inside the nest the ground falls towards the centre: a tick on the third arc points inwards (west)
  if (withTickInside) objs.push(tick(16, 50, -1, 0));
  return objs;
}

describe("index contours correct a flipped subtree (§3.5)", () => {
  it("flips a flagged group whose index contours sit off the residue", () => {
    const { g, chain } = build(depressionNest(false), [0, 0, 60, 100]);
    const nest = [4, 5, 6, 7, 8, 9].map(chain);
    const before = solveTerrain(g, { indexRepair: false });
    expect(before.signClass[nest[0]]).toBe(CLASS.bandUpper);
    expect(before.flagged[nest[0]]).toBe(1);
    expect(mod5(before.chainLevel[nest[0]] - before.chainLevel[chain(0)])).not.toBe(0);

    const sol = solveTerrain(g);
    for (const c of nest) {
      expect(sol.side[c]).toBe(-before.side[c]);
      expect(sol.corrected[c]).toBe(1);
      expect(sol.flagged[c]).toBe(0);
    }
    expect(sol.signClass[nest[0]]).toBe(CLASS.index);
    expect(sol.chainLevel[nest[0]]).toBe(sol.chainLevel[chain(0)]);
    expect(sol.chainLevel[nest[0]] - sol.chainLevel[nest[5]]).toBe(5);
    expect(sol.report.index.flippedGroups).toBe(1);
    expect(sol.report.index.consistency).toBe(1);
  });

  it("does not touch a nest decided by strict evidence", () => {
    const { g, chain } = build(depressionNest(true), [0, 0, 60, 100]);
    const sol = solveTerrain(g);
    const nest = [4, 5, 6, 7, 8, 9].map(chain);
    for (const c of nest) {
      expect(sol.flagged[c]).toBe(0);
      expect(sol.corrected[c]).toBe(0);
    }
    expect(sol.report.index.flippedGroups).toBe(0);
    expect(sol.chainLevel[nest[0]]).toBe(sol.chainLevel[chain(0)]);
  });
});
