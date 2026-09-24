/**
 * Unit tests for the automatic overprint-cut computation
 * (`overprint-cuts.ts`): circle slits and leg gaps over small rock
 * features and knolls, plus merging and the geometry decorator.
 */

import { describe, it, expect } from "vitest";
import type { SlimMapObject } from "../event-map-objects.js";
import {
  circleCuts,
  legGaps,
  decorateOverprintCuts,
  CIRCLE_RADIUS_MM,
} from "../overprint-cuts.js";

/** Build a SlimMapObject from paper-mm coordinates. */
function obj(
  sym: number,
  objType: 1 | 2 | 3,
  coordsMm: Array<[number, number]>,
): SlimMapObject {
  const coordinates = coordsMm.map(
    ([x, y]): [number, number] => [x * 100, y * 100],
  );
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of coordinates) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return { sym, objType, coordinates, bbox: [minX, minY, maxX, maxY] };
}

/** Does any gap contain the compass bearing `deg`? */
function gapAt(gaps: Array<{ start: number; end: number }>, deg: number): boolean {
  return gaps.some((g) =>
    g.start <= g.end
      ? deg >= g.start && deg <= g.end
      : deg >= g.start || deg <= g.end,
  );
}

describe("circleCuts", () => {
  it("slits the rim over a boulder sitting on it", () => {
    // Boulder 2.5 mm east of the centre = exactly on the rim.
    const boulder = obj(204000, 1, [[CIRCLE_RADIUS_MM, 0]]);
    const cuts = circleCuts([boulder], 0, 0);
    expect(cuts).toHaveLength(1);
    expect(gapAt(cuts, 90)).toBe(true);
    expect(gapAt(cuts, 270)).toBe(false);
    // Symmetric around east, and tight: just the symbol plus half the
    // overprint stroke, ~0.8 mm of rim. A wider cut fragments the circle
    // without revealing more map.
    const width = (cuts[0].end - cuts[0].start + 360) % 360;
    expect(width).toBeGreaterThan(10);
    expect(width).toBeLessThan(22);
    expect((width / 360) * 2 * Math.PI * CIRCLE_RADIUS_MM).toBeLessThan(1);
  });

  it("includes knolls but leaves the circle whole for a centred feature", () => {
    // Knoll on the north rim → slit at 0°.
    const knoll = obj(109000, 1, [[0, CIRCLE_RADIUS_MM]]);
    expect(gapAt(circleCuts([knoll], 0, 0), 0)).toBe(true);
    // A boulder at the centre is under the middle, not the rim: no slit.
    const centred = obj(204000, 1, [[0, 0]]);
    expect(circleCuts([centred], 0, 0)).toEqual([]);
  });

  it("ignores non-black features", () => {
    const waterhole = obj(303000, 1, [[CIRCLE_RADIUS_MM, 0]]); // blue
    const tree = obj(417000, 1, [[0, -CIRCLE_RADIUS_MM]]); // green
    expect(circleCuts([waterhole, tree], 0, 0)).toEqual([]);
  });

  it("does not slit long line objects", () => {
    const path = obj(505000, 2, [[1, -10], [1, 10]]);
    const cliff = obj(201000, 2, [[-10, 1], [10, 1]]);
    expect(circleCuts([path, cliff], 0, 0)).toEqual([]);
  });

  it("does not slit area objects", () => {
    const building = obj(521000, 3, [[-20, -20], [0, -20], [0, 20], [-20, 20]]);
    expect(circleCuts([building], 0, 0)).toEqual([]);
  });

  it("handles a slit wrapping north", () => {
    // Boulder just west of due north: slit spans across 0°.
    const boulder = obj(204000, 1, [[-0.1, CIRCLE_RADIUS_MM]]);
    const cuts = circleCuts([boulder], 0, 0);
    expect(cuts).toHaveLength(1);
    expect(gapAt(cuts, 359)).toBe(true);
    expect(gapAt(cuts, 5)).toBe(true);
  });
});

describe("legGaps", () => {
  const A: [number, number] = [0, 0];
  const B: [number, number] = [40, 0];

  it("gaps the leg around a boulder on the line", () => {
    const boulder = obj(204000, 1, [[20, 0.3]]);
    const gaps = legGaps(A, B, [boulder]);
    expect(gaps).toHaveLength(1);
    expect(gaps[0].from).toBeGreaterThan(0.4);
    expect(gaps[0].to).toBeLessThan(0.6);
    // 0.5 (the projection) sits inside the gap.
    expect(gaps[0].from).toBeLessThan(0.5);
    expect(gaps[0].to).toBeGreaterThan(0.5);
    // Tight: just wide enough to free the boulder, ~0.8 mm of a 40 mm leg.
    expect((gaps[0].to - gaps[0].from) * 40).toBeLessThan(1);
  });

  it("includes knolls in leg gaps", () => {
    const knoll = obj(109000, 1, [[20, 0]]);
    const gaps = legGaps(A, B, [knoll]);
    expect(gaps).toHaveLength(1);
    expect(gaps[0].from).toBeLessThan(0.5);
    expect(gaps[0].to).toBeGreaterThan(0.5);
  });

  it("does not gap long line objects", () => {
    const perpendicular = obj(505000, 2, [[10, -5], [10, 5]]);
    const oblique = obj(505000, 2, [[25, -1], [35, 1]]);
    expect(legGaps(A, B, [perpendicular, oblique])).toEqual([]);
  });

  it("does not gap area objects", () => {
    const building = obj(521000, 3, [[15, -3], [25, -3], [25, 3], [15, 3]]);
    const giantBoulder = obj(206000, 3, [[15, -3], [25, -3], [25, 3], [15, 3]]);
    expect(legGaps(A, B, [building, giantBoulder])).toEqual([]);
  });

  it("preserves the leg ends near the circles", () => {
    // Boulder right next to the start control: clipped to the end-keep
    // zone, and what remains is below the minimum gap length.
    const boulder = obj(204000, 1, [[1, 0]]);
    expect(legGaps(A, B, [boulder])).toEqual([]);
  });

  it("merges overlapping gaps and never erases most of the leg", () => {
    // 0.5 mm apart — closer than the two 0.8 mm gaps, so they fuse.
    const b1 = obj(204000, 1, [[19.75, 0]]);
    const b2 = obj(204000, 1, [[20.25, 0]]);
    expect(legGaps(A, B, [b1, b2])).toHaveLength(1);
    // Further apart they stay separate rather than erasing the stretch
    // between them.
    const far1 = obj(204000, 1, [[18, 0]]);
    const far2 = obj(204000, 1, [[22, 0]]);
    expect(legGaps(A, B, [far1, far2])).toHaveLength(2);

  });

  it("skips short legs entirely", () => {
    const boulder = obj(204000, 1, [[3, 0]]);
    expect(legGaps([0, 0], [6, 0], [boulder])).toEqual([]);
  });
});

describe("decorateOverprintCuts", () => {
  it("adds cuts to control circles and gaps to legs, leaving start/finish alone", () => {
    const boulderOnRim = obj(204000, 1, [[10 + CIRCLE_RADIUS_MM, 0]]);
    const knollOnLeg = obj(109000, 1, [[25, 0]]);
    const geometry = {
      features: [
        {
          geometry: { type: "Point", coordinates: [0, 0] },
          properties: { symbolType: "start", code: "S1" },
        },
        {
          geometry: { type: "Point", coordinates: [10, 0] },
          properties: { symbolType: "control", code: "31" },
        },
        {
          geometry: { type: "Point", coordinates: [40, 0] },
          properties: { symbolType: "control", code: "32" },
        },
        {
          geometry: { type: "LineString", coordinates: [[10, 0], [40, 0]] },
          properties: { symbolType: "leg", from: "31", to: "32" },
        },
      ],
    };
    decorateOverprintCuts(geometry, [boulderOnRim, knollOnLeg]);

    expect(geometry.features[0].properties).not.toHaveProperty("cuts");
    expect(geometry.features[1].properties?.cuts).toHaveLength(1);
    expect(geometry.features[2].properties).not.toHaveProperty("cuts");
    const gaps = geometry.features[3].properties?.gaps;
    expect(gaps).toHaveLength(1);
    expect(gaps[0].from).toBeLessThan(0.5);
    expect(gaps[0].to).toBeGreaterThan(0.5);
  });

  it("removes stale cuts when the feature no longer applies", () => {
    const geometry = {
      features: [
        {
          geometry: { type: "Point", coordinates: [10, 0] },
          properties: { symbolType: "control", code: "31", cuts: [{ start: 80, end: 100 }] },
        },
      ],
    };
    decorateOverprintCuts(geometry, []);
    expect(geometry.features[0].properties).not.toHaveProperty("cuts");
  });
});
