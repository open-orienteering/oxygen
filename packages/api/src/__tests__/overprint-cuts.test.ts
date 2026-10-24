/**
 * Unit tests for the legacy cut-feature source (`overprint-cuts.ts`):
 * which parsed OCAD objects become cut features, their symbol radii, and
 * the course layer's rule over them (circle slits and leg gaps; the rule's
 * own cases are in `packages/shared/src/course/__tests__/cuts.test.ts`).
 */

import { describe, it, expect } from "vitest";
import { course } from "@oxygen/shared";
import type { SlimMapObject } from "../event-map-objects.js";
import { cutFeaturesOfSlimObjects } from "../overprint-cuts.js";

const R = 2.5;

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

const features = (objects: SlimMapObject[], scale: number | null = 15000, fileRadii = new Map<number, number>()) =>
  cutFeaturesOfSlimObjects(objects, fileRadii, scale);

describe("cutFeaturesOfSlimObjects", () => {
  it("keeps knoll and rock point objects, in mm, with their symbol radius", () => {
    const out = features([
      obj(204000, 1, [[12.5, -3]]), // boulder
      obj(109000, 1, [[1, 2]]), // knoll
      obj(207000, 1, [[0, 0]]), // boulder cluster
    ]);
    expect(out.map((f) => [f.x, f.y])).toEqual([[12.5, -3], [1, 2], [0, 0]]);
    expect(out[0].r).toBeCloseTo(0.2, 9);
    expect(out[1].r).toBeCloseTo(0.25, 9);
    expect(out[2].r).toBeCloseTo(0.8 / Math.sqrt(3), 2);
  });

  it("drops non-cut symbols, line and area objects, and 206", () => {
    expect(features([
      obj(303000, 1, [[R, 0]]), // waterhole (blue)
      obj(417000, 1, [[0, -R]]), // distinct tree (green)
      obj(505000, 2, [[1, -10], [1, 10]]), // path
      obj(201000, 2, [[-10, 1], [10, 1]]), // cliff
      obj(521000, 3, [[-20, -20], [0, -20], [0, 20], [-20, 20]]), // building
      obj(206000, 3, [[15, -3], [25, -3], [25, 3], [15, 3]]), // gigantic boulder
      obj(204000, 2, [[0, 0], [1, 1]]), // a boulder code drawn as a line
    ])).toEqual([]);
  });

  it("measures by the file's own symbol first", () => {
    const radii = new Map([[204000, 0.33]]);
    expect(features([obj(204000, 1, [[0, 0]]), obj(205000, 1, [[1, 1]])], 10000, radii).map((f) => f.r)).toEqual([0.33, 0.3 * 1.5]);
  });

  it("without the file's sizes: sub-codes by their own entry, scaled by the map", () => {
    expect(features([obj(203001, 1, [[0, 0]])])[0].r).toBe(course.cutSymbolRadiusMm("ISOM2017-2", "203.1"));
    expect(features([obj(204000, 1, [[0, 0]])], 10000)[0].r).toBeCloseTo(0.3, 9);
    expect(features([obj(204000, 1, [[0, 0]])], 4000)[0].r).toBeCloseTo(0.3, 9); // ISSprOM boulder 0.6 mm
    expect(features([obj(204000, 1, [[0, 0]])], null)[0].r).toBeCloseTo(0.2, 9);
  });
});

describe("course layer rule over OCAD features", () => {
  it("slits the rim over a boulder on it, clearing the symbol with air", () => {
    const cuts = course.circleCuts(features([obj(204000, 1, [[R, 0]])]), 0, 0);
    expect(cuts).toHaveLength(1);
    expect(gapAt(cuts, 90)).toBe(true);
    expect(gapAt(cuts, 270)).toBe(false);
    // 0.2 symbol + 0.175 half line + 0.25 air = 0.625 mm each side.
    const width = (cuts[0].end - cuts[0].start + 360) % 360;
    expect(width).toBeCloseTo((4 * Math.asin(0.625 / (2 * R)) * 180) / Math.PI, 9);
  });

  it("wraps a slit across north and leaves a centred feature alone", () => {
    const north = course.circleCuts(features([obj(204000, 1, [[-0.1, R]])]), 0, 0);
    expect(gapAt(north, 359)).toBe(true);
    expect(gapAt(north, 5)).toBe(true);
    expect(course.circleCuts(features([obj(204000, 1, [[0, 0]])]), 0, 0)).toEqual([]);
  });

  it("gaps a leg around a knoll and keeps the leg ends", () => {
    const A = { x: 0, y: 0 }, B = { x: 40, y: 0 };
    const gaps = course.legGaps(A, B, features([obj(109000, 1, [[20, 0]])]));
    expect(gaps).toHaveLength(1);
    expect((gaps[0].to - gaps[0].from) * 40).toBeCloseTo(2 * (0.25 + 0.175 + 0.25), 9);
    expect(course.legGaps(A, B, features([obj(204000, 1, [[1, 0]])]))).toEqual([]);
  });
});
