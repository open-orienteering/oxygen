import { describe, expect, it } from "vitest";
import { sampleConfident, sampleHeight } from "../index.js";
import { gridField } from "./fixtures.js";

// z = 10·cx + 4·cy units on 0.2 mm cells from (1, 2); a unit is 5 / 64 m.
const plane = () => gridField(8, 6, (cx, cy) => 10 * cx + 4 * cy, { x0: 1, y0: 2 });
const UNIT = 5 / 64;
/** The plane's height in metres at paper (x, y). */
const planeAt = (x: number, y: number) => (10 * ((x - 1) / 0.2 - 0.5) + 4 * ((y - 2) / 0.2 - 0.5)) * UNIT;

describe("sampleHeight (map-terrain.md §5.3)", () => {
  it("is exact on a plane between cell centres", () => {
    const f = plane();
    for (const [x, y] of [
      [1.1, 2.1],
      [1.37, 2.55],
      [2.0, 2.9],
      [2.49, 3.09],
    ])
      expect(sampleHeight(f, { x, y })).toBeCloseTo(planeAt(x, y), 9);
  });

  it("hits the cell value at a cell centre and clamps beyond the outer centres", () => {
    const f = plane();
    expect(sampleHeight(f, { x: 1 + 0.2 * 3.5, y: 2 + 0.2 * 2.5 })).toBeCloseTo((30 + 8) * UNIT, 9);
    // left of the first centre: the edge column's value
    expect(sampleHeight(f, { x: 1.02, y: 2 + 0.2 * 1.5 })).toBeCloseTo(4 * UNIT, 9);
  });

  it("adds the header's offset", () => {
    const f = plane();
    f.header.zOffsetM = 100;
    expect(sampleHeight(f, { x: 1.1, y: 2.1 })).toBeCloseTo(100, 9);
  });

  it("is null outside the grid and in a no-data cell", () => {
    const f = gridField(4, 4, (cx, cy) => (cx === 1 && cy === 1 ? NaN : 8));
    expect(sampleHeight(f, { x: -0.01, y: 0.3 })).toBeNull();
    expect(sampleHeight(f, { x: 0.3, y: 0.8 })).toBeNull();
    expect(sampleHeight(f, { x: 0.3, y: 0.3 })).toBeNull();
  });

  it("renormalises over the valid neighbours at a no-data border", () => {
    // left half 8, right column no-data: a point between a data and a no-data centre reads the data side
    const f = gridField(3, 2, (cx) => (cx === 2 ? NaN : cx === 0 ? 8 : 16));
    expect(sampleHeight(f, { x: 0.35, y: 0.1 })).toBeCloseTo(16 * UNIT, 9);
    expect(sampleHeight(f, { x: 0.2, y: 0.1 })).toBeCloseTo(12 * UNIT, 9);
  });
});

describe("sampleConfident (map-terrain.md §5.3)", () => {
  it("reads the containing cell's bit, false outside", () => {
    const f = gridField(4, 1, () => 0);
    f.confident[0] = 0b0101;
    expect([0.1, 0.3, 0.5, 0.7].map((x) => sampleConfident(f, { x, y: 0.1 }))).toEqual([true, false, true, false]);
    expect(sampleConfident(f, { x: 0.9, y: 0.1 })).toBe(false);
  });
});
