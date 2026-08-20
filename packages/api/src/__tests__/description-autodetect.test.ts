import { describe, it, expect } from "vitest";
import {
  compassBearing,
  sideOfCode,
  suggestDescriptions,
} from "../description-autodetect.js";
import type { SlimMapObject } from "../event-map-objects.js";

/** Build a slim object from mm coordinates (the module works in 1/100 mm). */
function obj(
  sym: number,
  objType: 1 | 2 | 3,
  pointsMm: Array<[number, number]>,
): SlimMapObject {
  const coordinates = pointsMm.map(
    ([x, y]) => [x * 100, y * 100] as [number, number],
  );
  const xs = coordinates.map((c) => c[0]);
  const ys = coordinates.map((c) => c[1]);
  return {
    sym,
    objType,
    coordinates,
    bbox: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)],
  };
}

const BOULDER = 204000;   // point   → 2.004, side-of allowed
const PATH = 505000;      // line    → 5.002, no side-of
const MARSH = 308000;     // area    → 3.007
const BUILDING = 521000;  // area    → 5.011, side-of allowed

describe("suggestDescriptions", () => {
  it("returns nothing when there is nothing nearby", () => {
    const objects = [obj(BOULDER, 1, [[100, 100]])];
    expect(suggestDescriptions(objects, 0, 0)).toEqual([]);
  });

  it("finds a point feature and reports the distance in mm", () => {
    const objects = [obj(BOULDER, 1, [[10, 10]])];
    const [c] = suggestDescriptions(objects, 11, 10);
    expect(c.d).toBe("2.004");
    expect(c.isom).toBe(204);
    expect(c.distanceMm).toBeCloseTo(1, 5);
  });

  it("orders candidates nearest first and caps the list", () => {
    const objects = [
      obj(MARSH, 3, [[20, 20], [30, 20], [30, 30], [20, 30]]),
      obj(PATH, 2, [[0, 2], [40, 2]]),
      obj(BOULDER, 1, [[0, 0.5]]),
    ];
    const out = suggestDescriptions(objects, 0, 0, { radiusMm: 5 });
    expect(out.map((c) => c.isom)).toEqual([204, 505]);
    const capped = suggestDescriptions(objects, 0, 0, { radiusMm: 40, limit: 2 });
    expect(capped).toHaveLength(2);
  });

  it("respects the search radius", () => {
    const objects = [obj(BOULDER, 1, [[0, 4]])];
    expect(suggestDescriptions(objects, 0, 0, { radiusMm: 3 })).toEqual([]);
    expect(suggestDescriptions(objects, 0, 0, { radiusMm: 5 })).toHaveLength(1);
  });

  it("measures a line by its nearest segment", () => {
    const objects = [obj(PATH, 2, [[0, 0], [10, 0], [10, 10]])];
    const [c] = suggestDescriptions(objects, 12, 5);
    expect(c.d).toBe("5.002");
    expect(c.distanceMm).toBeCloseTo(2, 5);
    // No side-of for a path: "N side of the path" says nothing.
    expect(c.g).toBeUndefined();
  });

  it("treats a point inside an area as on the feature", () => {
    const objects = [obj(MARSH, 3, [[0, 0], [10, 0], [10, 10], [0, 10]])];
    const [inside] = suggestDescriptions(objects, 5, 5);
    expect(inside.d).toBe("3.007");
    expect(inside.distanceMm).toBe(0);
    // Just outside the western edge: distance to the boundary.
    const [outside] = suggestDescriptions(objects, -1.5, 5);
    expect(outside.distanceMm).toBeCloseTo(1.5, 5);
  });

  it("keeps only the nearest object per column-D code", () => {
    const objects = [
      obj(BOULDER, 1, [[0, 2]]),
      obj(BOULDER, 1, [[0, 0.6]]),
      // Large boulder (205) maps to the SAME code 2.004 — one "boulder"
      // suggestion is enough even when several map symbols produce it.
      obj(205000, 1, [[0, 1]]),
      // Rocky pit (203) → 2.003, a different code → its own candidate.
      obj(203000, 1, [[0, 1.4]]),
    ];
    const out = suggestDescriptions(objects, 0, 0);
    expect(out.map((c) => c.d)).toEqual(["2.004", "2.003"]);
    const boulder = out.find((c) => c.d === "2.004")!;
    expect(boulder.distanceMm).toBeCloseTo(0.6, 5);
    expect(boulder.isom).toBe(204);
  });

  it("suggests a side-of direction for point features", () => {
    // Control 1 mm north of the boulder → "N side of".
    const north = suggestDescriptions([obj(BOULDER, 1, [[0, 0]])], 0, 1);
    expect(north[0].g).toBe("11.101");
    // 1 mm east → "E side of" (third direction, N NE E).
    const east = suggestDescriptions([obj(BOULDER, 1, [[0, 0]])], 1, 0);
    expect(east[0].g).toBe("11.103");
    // Sitting on the feature: no direction.
    const on = suggestDescriptions([obj(BOULDER, 1, [[0, 0]])], 0.1, 0);
    expect(on[0].g).toBeUndefined();
  });

  it("suggests a side-of direction from an area centroid", () => {
    const building = obj(BUILDING, 3, [[0, 0], [10, 0], [10, 10], [0, 10]]);
    // South of the building's centroid (5,5) but outside the ring.
    const [c] = suggestDescriptions([building], 5, -2, { radiusMm: 5 });
    expect(c.d).toBe("5.011");
    expect(c.g).toBe("11.105"); // S
  });

  it("ignores symbols with no description mapping", () => {
    const contour = obj(101000, 2, [[0, 0], [10, 0]]);
    const overprint = obj(703000, 1, [[0, 0]]);
    expect(suggestDescriptions([contour, overprint], 0, 0)).toEqual([]);
  });
});

describe("compassBearing / sideOfCode", () => {
  it("measures clockwise from north with paper Y pointing north", () => {
    expect(compassBearing([0, 0], [0, 10])).toBeCloseTo(0, 5);
    expect(compassBearing([0, 0], [10, 10])).toBeCloseTo(45, 5);
    expect(compassBearing([0, 0], [10, 0])).toBeCloseTo(90, 5);
    expect(compassBearing([0, 0], [0, -10])).toBeCloseTo(180, 5);
    expect(compassBearing([0, 0], [-10, 0])).toBeCloseTo(270, 5);
  });

  it("snaps all eight directions to the OCAD side-of codes", () => {
    const expected = [
      "11.101", "11.102", "11.103", "11.104",
      "11.105", "11.106", "11.107", "11.108",
    ];
    for (let i = 0; i < 8; i++) {
      expect(sideOfCode(i * 45)).toBe(expected[i]);
      // Halfway between directions still lands on a neighbour, and 360
      // wraps back to north.
      expect(expected).toContain(sideOfCode(i * 45 + 20));
    }
    expect(sideOfCode(360)).toBe("11.101");
    expect(sideOfCode(-45)).toBe("11.108");
  });
});
