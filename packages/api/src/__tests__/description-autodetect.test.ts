import { describe, it, expect } from "vitest";
import {
  compassBearing,
  polygonCentroid,
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

  it("detects a path crossing and sets F=crossing", () => {
    const pathA = obj(PATH, 2, [[-5, 0], [5, 0]]);
    const pathB = obj(PATH, 2, [[0, -5], [0, 5]]);
    const [c] = suggestDescriptions([pathA, pathB], 0, 0);
    expect(c.d).toBe("5.002");
    expect(c.f).toBe("10.001");
    // IOF layout: the second feature is listed in E even when it is the
    // same kind — "path · path · crossing".
    expect(c.e).toBe("5.002");
    expect(c.distanceMm).toBeCloseTo(0, 5);
  });

  it("detects a path/stream junction with two features", () => {
    const path = obj(PATH, 2, [[-5, 0], [5, 0]]);
    const stream = obj(304000, 2, [[0, 0], [0, 5]]); // ends on the path
    const [c] = suggestDescriptions([path, stream], 0, 0);
    expect(c.f).toBe("10.002");
    expect([c.d, c.e].sort()).toEqual(["3.004", "5.002"]);
  });

  it("detects a bend on a polyline", () => {
    // Right-angle corner at (0,0).
    const wall = obj(513000, 2, [[-5, 0], [0, 0], [0, 5]]);
    const [c] = suggestDescriptions([wall], 0, 0);
    expect(c.d).toBe("5.008");
    expect(c.f).toBe("11.001");
  });

  it("detects the free end of a line feature", () => {
    const path = obj(PATH, 2, [[0, 0], [10, 0]]);
    const [c] = suggestDescriptions([path], 0, 0, { radiusMm: 1 });
    expect(c.d).toBe("5.002");
    expect(c.g).toBe("11.707"); // west end (line runs east from the tip)
    // Slightly beside the tip (nearer the line than the endpoint) still
    // reads as the end.
    const [beside] = suggestDescriptions([path], 0.2, 0.3, { radiusMm: 1 });
    expect(beside.g).toBe("11.707");
  });

  it("sets column C when two similar point features are nearby", () => {
    // Two boulders; control on the northern one.
    const south = obj(BOULDER, 1, [[0, 0]]);
    const north = obj(BOULDER, 1, [[0, 2]]);
    const [c] = suggestDescriptions([south, north], 0, 2);
    expect(c.d).toBe("2.004");
    expect(c.c).toBe("0.201"); // Northern
  });

  it("detects a T-junction when the ending path stops just short of the other", () => {
    // Real maps are rarely snapped: 0.25 mm gap between the end and the line.
    const through = obj(PATH, 2, [[-5, 0], [5, 0]]);
    const ending = obj(PATH, 2, [[0, 0.25], [0, 5]]);
    const [c] = suggestDescriptions([through, ending], 0.2, 0.3);
    expect(c.d).toBe("5.002");
    expect(c.e).toBe("5.002");
    expect(c.f).toBe("10.002");
    // One candidate for the pair — the second path is not listed again.
    expect(suggestDescriptions([through, ending], 0.2, 0.3)).toHaveLength(1);
  });

  it("still reports the junction when the control is a millimetre off it", () => {
    const through = obj(PATH, 2, [[-5, 0], [5, 0]]);
    const ending = obj(PATH, 2, [[0, 0], [0, 5]]);
    const [c] = suggestDescriptions([through, ending], 1.2, 0.3);
    expect(c.f).toBe("10.002");
  });

  it("puts the nearer line in column D at a mixed-feature crossing", () => {
    const path = obj(PATH, 2, [[-5, 0], [5, 0]]);
    const stream = obj(304000, 2, [[0, -5], [0, 5]]);
    // Control sits right on the stream, a little away from the path.
    const [c] = suggestDescriptions([path, stream], 0, 0.6);
    expect(c.f).toBe("10.001");
    expect(c.d).toBe("3.004");
    expect(c.e).toBe("5.002");
  });

  it("prefers a boulder beside the control over the open land it stands in", () => {
    // Large rough-open area covering everything; boulder 0.8 mm away.
    const open = obj(403000, 3, [[-20, -20], [20, -20], [20, 20], [-20, 20]]);
    const boulder = obj(BOULDER, 1, [[0.8, 0]]);
    const out = suggestDescriptions([open, boulder], 0, 0);
    expect(out.map((c) => c.d)).toEqual(["2.004", "4.001"]);
    expect(out[0].g).toBe("11.107"); // control is W of the boulder
    // The area still reports distance 0 (inside) — ranking is what changed.
    expect(out[1].distanceMm).toBe(0);
  });

  it("describes where in an extended area the control is", () => {
    const marsh = obj(MARSH, 3, [[0, 0], [10, 0], [10, 10], [0, 10]]);
    // Just inside the eastern boundary → "E edge".
    expect(suggestDescriptions([marsh], 9.5, 5)[0].g).toBe("11.203");
    // Just outside the northern boundary → "N edge" as well.
    expect(suggestDescriptions([marsh], 5, 10.8)[0].g).toBe("11.201");
    // Well inside, off-centre to the south-west → "SW part".
    expect(suggestDescriptions([marsh], 2.5, 2.5)[0].g).toBe("11.306");
    // In the middle: nothing to say.
    expect(suggestDescriptions([marsh], 5, 5)[0].g).toBeUndefined();
  });

  it("stays quiet about position in a small area", () => {
    // 1.4 mm marsh: every point is within the edge band, but the control
    // is not meaningfully off-centre.
    const small = obj(MARSH, 3, [[0, 0], [1.4, 0], [1.4, 1.4], [0, 1.4]]);
    expect(suggestDescriptions([small], 0.7, 0.9)[0].g).toBeUndefined();
  });

  it("detects inside and outside corners of area features", () => {
    const marsh = obj(MARSH, 3, [[0, 0], [10, 0], [10, 10], [0, 10]]);
    // Inside the NE corner.
    expect(suggestDescriptions([marsh], 9.6, 9.6)[0].g).toBe("11.402");
    // Outside the SW corner.
    expect(suggestDescriptions([marsh], -0.4, -0.4)[0].g).toBe("11.506");

    // Buildings (compact, side-of allowed) get outside corners too …
    const building = obj(BUILDING, 3, [[0, 0], [10, 0], [10, 10], [0, 10]]);
    expect(suggestDescriptions([building], 10.4, -0.4)[0].g).toBe("11.504"); // SE
    // … and plain side-of away from the corners.
    expect(suggestDescriptions([building], 5, -1.5)[0].g).toBe("11.105"); // S
  });

  it("does not treat a flattened curve as a chain of corners", () => {
    // A quarter-circle-ish boundary with 10° turns per vertex.
    const pts: Array<[number, number]> = [];
    for (let a = 0; a <= 90; a += 10) {
      const r = (a * Math.PI) / 180;
      pts.push([10 * Math.cos(r), 10 * Math.sin(r)]);
    }
    pts.push([0, 0]);
    const blob = obj(MARSH, 3, pts);
    const [c] = suggestDescriptions([blob], 7.0, 7.0);
    expect(c.g).not.toMatch(/^11\.[45]/);
  });
});

describe("polygonCentroid", () => {
  it("is area-weighted, so a densely sampled edge does not drag it", () => {
    // Square 0..10 with the eastern edge sampled at 50 extra vertices.
    const ring: Array<[number, number]> = [[0, 0], [1000, 0]];
    for (let i = 1; i < 50; i++) ring.push([1000, i * 20]);
    ring.push([1000, 1000], [0, 1000]);
    const [cx, cy] = polygonCentroid(ring);
    expect(cx).toBeCloseTo(500, 3);
    expect(cy).toBeCloseTo(500, 3);
  });

  it("falls back to the vertex mean for degenerate rings", () => {
    expect(polygonCentroid([[0, 0], [10, 0]])).toEqual([5, 0]);
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
