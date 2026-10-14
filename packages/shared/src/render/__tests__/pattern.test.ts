import { describe, expect, it } from "vitest";
import { COORD_FLAG, makePath } from "../pass-stream.js";
import { flattenRings, offsetPolyline, pointInRings, ringArea } from "../geometry.js";
import { patternInstances } from "../pattern.js";
import { patternSpecSchema } from "../symbol.js";

const square = (x0: number, y0: number, s: number) => makePath([x0, y0, x0 + s, y0, x0 + s, y0 + s, x0, y0 + s], undefined, true);
const dot = { parts: [{ kind: "disc" as const, colour: 2, diameterUm: 400 }], rotatable: false };
const extent = { minX: -200, minY: -200, maxX: 200, maxY: 200 };
const spec = (over: Partial<ReturnType<typeof patternSpecSchema.parse>> = {}) =>
  patternSpecSchema.parse({ glyph: dot, cellWidthUm: 1000, cellHeightUm: 1000, offsetXUm: 500, offsetYUm: 500, ...over });
const key = (p: { x: number; y: number }) => `${Math.round(p.x)},${Math.round(p.y)}`;

describe("geometry", () => {
  it("flattens rings and tests points even-odd across holes", () => {
    const withHole = makePath([0, 0, 10000, 0, 10000, 10000, 0, 10000, 4000, 4000, 6000, 4000, 6000, 6000, 4000, 6000], [0, 0, 0, 0, COORD_FLAG.hole, 0, 0, 0], true);
    const rings = flattenRings(withHole);
    expect(rings).toHaveLength(2);
    expect(pointInRings(rings, 1000, 1000)).toBe(true);
    expect(pointInRings(rings, 5000, 5000)).toBe(false);
    expect(pointInRings(rings, 11000, 5000)).toBe(false);
    expect(ringArea(rings[0])).toBe(1e8);
  });
  it("flattens a Bézier circle to a polygon of the right area", () => {
    const circle = makePath(
      [1000, 0, 1000, 552, 552, 1000, 0, 1000, -552, 1000, -1000, 552, -1000, 0, -1000, -552, -552, -1000, 0, -1000, 552, -1000, 1000, -552, 1000, 0],
      [0, 1, 2, 0, 1, 2, 0, 1, 2, 0, 1, 2, 0],
      true,
    );
    const [ring] = flattenRings(circle, 1);
    expect(Math.abs(ringArea(ring) - Math.PI * 1e6) / (Math.PI * 1e6)).toBeLessThan(0.002);
  });
  it("offsets polylines to the left with mitred corners", () => {
    expect(offsetPolyline([0, 0, 1000, 0], 100)).toEqual([0, 100, 1000, 100]);
    expect(offsetPolyline([0, 0, 1000, 0], -100)).toEqual([0, -100, 1000, -100]);
    const bent = offsetPolyline([0, 0, 1000, 0, 1000, 1000], 100);
    expect(bent.map(Math.round)).toEqual([0, 100, 900, 100, 900, 1000]);
    const sq = offsetPolyline([0, 0, 1000, 0, 1000, 1000, 0, 1000], -100, true);
    expect(sq.map(Math.round)).toEqual([-100, -100, 1100, -100, 1100, 1100, -100, 1100]);
  });
});

describe("patternInstances", () => {
  it("fills a square with a grid anchored at the paper origin", () => {
    const { instances, clip } = patternInstances(square(0, 0, 10000), spec(), { extent });
    expect(clip).toBe(false);
    expect(instances).toHaveLength(100);
    const keys = new Set(instances.map(key));
    expect(keys.has("500,500")).toBe(true);
    expect(keys.has("9500,9500")).toBe(true);
    expect(instances.every((i) => i.angleDeg === 0)).toBe(true);
  });

  it("adjacent areas share the grid (continuity across the boundary)", () => {
    const a = patternInstances(square(0, 0, 10000), spec(), { extent }).instances;
    const b = patternInstances(square(10000, 0, 10000), spec(), { extent }).instances;
    const offsetA = new Set(a.map((i) => key({ x: i.x + 10000, y: i.y })));
    expect(b.every((i) => offsetA.has(key(i)))).toBe(true);
    // A square not aligned to the cell still gets the same grid lines.
    const c = patternInstances(square(250, 250, 10000), spec(), { extent }).instances;
    expect(c.every((i) => (i.x - 500) % 1000 === 0 && (i.y - 500) % 1000 === 0)).toBe(true);
  });

  it("shifts odd rows by half a cell", () => {
    const { instances } = patternInstances(square(0, 0, 10000), spec({ shiftedRows: true }), { extent });
    const row0 = instances.filter((i) => Math.round(i.y) === 500).map((i) => Math.round(i.x)).sort((a, b) => a - b);
    const row1 = instances.filter((i) => Math.round(i.y) === 1500).map((i) => Math.round(i.x)).sort((a, b) => a - b);
    expect(row0).toContain(500);
    expect(row0).not.toContain(1000);
    expect(row1).toContain(1000);
    expect(row1).not.toContain(500);
  });

  it("rotates the grid by the pattern angle plus the object angle unless rotate is never", () => {
    const r = patternInstances(square(0, 0, 10000), spec({ angleDeg: 90 }), { extent }).instances;
    expect(r).toHaveLength(100);
    expect(r.every((i) => i.angleDeg === 90)).toBe(true);
    const o = patternInstances(square(0, 0, 10000), spec({ rotate: "manual" }), { extent, objectAngleDeg: 30 }).instances;
    expect(o[0].angleDeg).toBe(30);
    const n = patternInstances(square(0, 0, 10000), spec({ rotate: "never" }), { extent, objectAngleDeg: 30 }).instances;
    expect(n[0].angleDeg).toBe(0);
  });

  it("applies the four clip modes on a triangle", () => {
    const tri = makePath([0, 0, 10000, 0, 0, 10000], undefined, true);
    const count = (clip: "clip" | "completelyInside" | "centreInside" | "partiallyInside", ex = extent) =>
      patternInstances(tri, spec({ clip }), { extent: ex }).instances.length;
    // Centres at (500 + i·1000, 500 + j·1000) inside x + y < 10000: 45 cells with i + j ≤ 8.
    expect(count("centreInside")).toBe(45);
    // A ±200 glyph box still fits in every one of those cells (far corner at x + y + 400 ≤ 9400).
    expect(count("completelyInside")).toBe(45);
    // A ±600 box must clear the legs (i, j ≥ 1) and the hypotenuse (i + j ≤ 7): 21 cells.
    const big = { minX: -600, minY: -600, maxX: 600, maxY: 600 };
    expect(count("completelyInside", big)).toBe(21);
    // Partially inside adds the 10 cells on the hypotenuse (i + j = 9) whose box reaches in.
    expect(count("partiallyInside")).toBe(55);
    expect(count("clip")).toBe(55);
    expect(patternInstances(tri, spec({ clip: "clip" }), { extent }).clip).toBe(true);
  });
});
