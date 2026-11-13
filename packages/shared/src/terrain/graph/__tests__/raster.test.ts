import { describe, expect, it } from "vitest";
import { LABEL, buildContourGraph, cellIndex, mappedAreaMask, maskAt, type ContourGraph, type ContourGraphOptions } from "../index.js";
import { S, line, mapped, rect, ring, syntheticDoc, type Obj } from "./synthetic.js";

function build(objects: Obj[], area?: [number, number, number, number], opts: ContourGraphOptions = {}): ContourGraph {
  const g = buildContourGraph(syntheticDoc(mapped(objects, area)), opts);
  if (!g) throw new Error("no graph");
  return g;
}

const labelAt = (g: ContourGraph, x: number, y: number) => {
  const i = cellIndex(g.raster, x, y);
  if (i < 0) throw new Error(`(${x}, ${y}) is off the raster`);
  return g.raster.labels[i];
};

describe("mapped-area mask (map-terrain.md §2.3)", () => {
  it("closes the drawn extent: inside the outline is mapped, beyond it is not", () => {
    const m = mappedAreaMask([Float64Array.from(rect(0, 0, 60, 40))], { minX: 0, minY: 0, maxX: 60, maxY: 40 });
    expect(m.cellMm).toBe(0.5);
    expect(maskAt(m, 30, 20)).toBe(true);
    expect(maskAt(m, 0.25, 0.25)).toBe(true);
    expect(maskAt(m, 30, -1.5)).toBe(false);
    expect(maskAt(m, 62, 20)).toBe(false);
    expect(maskAt(m, 500, 500)).toBe(false);
  });

  it("bridges a gap narrower than twice the closing radius", () => {
    const m = mappedAreaMask([Float64Array.from(rect(0, 0, 20, 20)), Float64Array.from(rect(26, 0, 46, 20))], { minX: 0, minY: 0, maxX: 46, maxY: 20 });
    expect(maskAt(m, 23, 10)).toBe(true);
  });
});

describe("barrier raster and regions (§2.4–2.5)", () => {
  it("cuts nested rings into one region per band", () => {
    const g = build([
      { sym: S.contour, coords: ring(30, 20, 5) },
      { sym: S.contour, coords: ring(30, 20, 10) },
      { sym: S.index, coords: ring(30, 20, 15) },
    ]);
    expect(g.raster.regionCount).toBe(4);
    const centre = labelAt(g, 30, 20), b1 = labelAt(g, 37.5, 20), b2 = labelAt(g, 42.5, 20), outer = labelAt(g, 46, 20);
    expect(new Set([centre, b1, b2, outer]).size).toBe(4);
    for (const r of [centre, b1, b2, outer]) expect(r).toBeGreaterThan(0);
    expect(g.raster.regionTouchesOutside[centre]).toBe(0);
    expect(g.raster.regionTouchesOutside[outer]).toBe(1);
    expect(g.raster.regionCells[centre]).toBeGreaterThan(Math.PI * 4.8 * 4.8 * 100);
    expect(labelAt(g, 35, 20)).toBeLessThanOrEqual(LABEL.chain0);
  });

  it("closes bands at the frame: two contours across the map give three regions", () => {
    const g = build(
      [
        { sym: S.contour, coords: line(0, 15, 60, 15) },
        { sym: S.contour, coords: line(0, 25, 60, 25) },
      ],
      [0, 10, 60, 30],
    );
    expect(g.stats.openEnds.frame).toBe(4);
    expect(g.raster.regionCount).toBe(3);
    expect(labelAt(g, -1, 20)).toBe(LABEL.outside);
  });

  it("draws a dangling end onto a contour within 1.5 mm straight ahead (extended)", () => {
    const g = build([
      { sym: S.contour, coords: ring(30, 20, 8) },
      { sym: S.contour, coords: line(10, 20, 21, 20) },
    ]);
    const open = g.chains.find((c) => !c.closed)!;
    expect(open.ends).toEqual(["dangling", "extended"]);
    expect(g.stats.contours.extendedEnds).toBe(1);
    expect(labelAt(g, 21.5, 20)).toBeLessThanOrEqual(LABEL.chain0);
  });

  it("draws cliffs as barriers", () => {
    const g = build(
      [
        { sym: S.contour, coords: line(0, 20, 60, 20) },
        { sym: S.cliff, coords: line(30, 10, 30, 30) },
      ],
      [0, 15, 60, 25],
    );
    expect(labelAt(g, 30, 19)).toBe(LABEL.cliff);
    expect(g.raster.regionCount).toBe(4);
  });

  it("uses 0.1 mm cells unless the cell budget forces larger ones", () => {
    const fine = build([{ sym: S.contour, coords: ring(30, 20, 5) }]);
    expect(fine.raster.cellMm).toBe(0.1);
    // Box 10 + 4 mm square = 196 mm²; a budget of 4 900 cells gives 0.2 mm.
    const coarse = build([{ sym: S.contour, coords: ring(30, 20, 5) }], undefined, { maxCells: 4900 });
    expect(coarse.raster.cellMm).toBeCloseTo(0.2, 9);
    expect(coarse.stats.raster.cells).toBe(coarse.raster.width * coarse.raster.height);
  });
});
