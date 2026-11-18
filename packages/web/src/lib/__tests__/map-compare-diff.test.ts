import { describe, expect, it } from "vitest";
import {
  binCells,
  CHANGED,
  changedMask,
  overlayPixels,
  regionBoundsMm,
  regionsOf,
  scanGrid,
  scanPxPerMm,
  SCAN_MAX_TILES,
  stepIndex,
  stepViewport,
  VEIL,
  type CellCounts,
} from "../map-compare-diff";

const frame = (width: number, height: number, rgb: (i: number) => [number, number, number]) => {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) data.set([...rgb(i), 255], i * 4);
  return { width, height, data };
};

describe("the changed mask (docs/map-symbols.md §8.7 \"Compare — diff\")", () => {
  it("counts a pixel changed only above the tolerance of 16, on its largest channel", () => {
    const a = frame(4, 1, () => [100, 100, 100]);
    const b = frame(4, 1, (i) => [[100, 100, 100], [116, 100, 100], [100, 117, 100], [90, 100, 80]][i] as [number, number, number]);
    const m = changedMask(a, b)!;
    expect([...m.mask]).toEqual([0, 0, 1, 1]);
    expect(m.changed).toBe(2);
  });

  it("ignores alpha, and compares nothing when the sizes differ", () => {
    const a = frame(1, 1, () => [0, 0, 0]);
    const b = frame(1, 1, () => [0, 0, 0]);
    b.data[3] = 0;
    expect(changedMask(a, b)!.changed).toBe(0);
    expect(changedMask(frame(2, 1, () => [0, 0, 0]), frame(1, 2, () => [0, 0, 0]))).toBeNull();
  });

  it("veils unchanged pixels white at 75 % and draws changed ones red", () => {
    const px = overlayPixels(Uint8Array.from([0, 1]));
    expect([...px.slice(0, 4)]).toEqual([...VEIL]);
    expect([...px.slice(4, 8)]).toEqual([...CHANGED]);
    expect(VEIL[3]).toBe(Math.floor(0.75 * 255));
  });
});

describe("the scan's tiles", () => {
  it("is 6 px/mm on a small map, lowered so a large one takes at most 64 tiles", () => {
    expect(scanPxPerMm(300, 200)).toBe(6);
    const big = scanGrid({ minX: 0, minY: 0, maxX: 2000, maxY: 1500 });
    expect(big.pxPerMm).toBeLessThan(6);
    expect(big.tiles.length).toBeLessThanOrEqual(SCAN_MAX_TILES);
    // A hair more resolution would need more tiles.
    const k = 1.001;
    expect(Math.ceil((2000 * big.pxPerMm * k) / 1024) * Math.ceil((1500 * big.pxPerMm * k) / 1024)).toBeGreaterThan(SCAN_MAX_TILES);
    for (const [w, h] of [[10000, 100], [100, 10000], [1, 1]]) expect(scanGrid({ minX: 0, minY: 0, maxX: w!, maxY: h! }).tiles.length).toBeLessThanOrEqual(SCAN_MAX_TILES);
  });

  it("lays tiles from the top-left corner in reading order, each a 1024 px view", () => {
    const g = scanGrid({ minX: 10, minY: -100, maxX: 300, maxY: 100 });
    expect(g.pxPerMm).toBe(6);
    expect(g.tileMm).toBeCloseTo(1024 / 6, 9);
    expect([g.cols, g.rows]).toEqual([2, 2]);
    expect(g.tiles.map((t) => [t.col, t.row])).toEqual([[0, 0], [1, 0], [0, 1], [1, 1]]);
    const t = g.tiles[1]!;
    expect(t.left).toBeCloseTo(10 + 1024 / 6, 9);
    expect(t.top).toBe(100);
    expect(t.view).toMatchObject({ widthPx: 1024, heightPx: 1024, rotationDeg: 0, pxPerUm: 0.006 });
    expect(t.view.centreX).toBeCloseTo((10 + 1.5 * (1024 / 6)) * 1000, 6);
    expect(t.view.centreY).toBeCloseTo((100 - 512 / 6) * 1000, 6);
  });
});

describe("cells, regions and their order", () => {
  const bounds = { minX: 0, minY: -100, maxX: 100, maxY: 0 };

  it("bins a tile's changed pixels into 5 mm cells from the bounds' top-left", () => {
    const cells: CellCounts = new Map();
    // A 4 × 2 tile at 1 px/mm whose top-left is (4, -4): pixels at x 4.5…7.5 mm, y -4.5 and -5.5 mm.
    binCells(cells, Uint8Array.from([1, 1, 0, 0, 0, 0, 0, 1]), 4, { left: 4, top: -4 }, 1, bounds);
    expect(Object.fromEntries(cells)).toEqual({ "0,0": 1, "1,0": 0 + 1, "1,1": 1 });
  });

  it("joins 8-connected cells; most changed first, ties topmost then leftmost", () => {
    const cells: CellCounts = new Map([
      ["0,0", 5], ["1,1", 5], // one region by the diagonal: 10
      ["5,5", 3], ["6,5", 7], // 10, a tie: lower, so after
      ["9,0", 2], // 2
      ["3,9", 20], // most
    ]);
    const r = regionsOf(cells);
    expect(r.map((x) => [x.changed, x.minCol, x.minRow])).toEqual([[20, 3, 9], [10, 0, 0], [10, 5, 5], [2, 9, 0]]);
    expect(r[1]).toMatchObject({ cells: 2, maxCol: 1, maxRow: 1, firstCol: 0 });
    expect(regionsOf(new Map())).toEqual([]);
  });

  it("orders a tie within one row by its leftmost top cell", () => {
    const r = regionsOf(new Map([["8,2", 4], ["2,2", 4]]));
    expect(r.map((x) => x.firstCol)).toEqual([2, 8]);
  });
});

describe("stepping", () => {
  const bounds = { minX: 0, minY: -100, maxX: 100, maxY: 0 };
  const region = { changed: 1, cells: 1, minCol: 2, minRow: 3, maxCol: 2, maxRow: 3, firstCol: 2 };

  it("fits the region with a cell of margin, at most 16 px/mm", () => {
    expect(regionBoundsMm(region, bounds)).toEqual({ minX: 5, maxX: 20, maxY: -10, minY: -25 });
    const vp = stepViewport(region, bounds, 800, 600);
    expect(vp.centreX).toBe(12_500);
    expect(vp.centreY).toBe(-17_500);
    // 15 mm into 600 px would be 40 px/mm: capped.
    expect(vp.pxPerUm).toBeCloseTo(0.016, 12);
    const wide = { ...region, maxCol: 40 };
    expect(stepViewport(wide, bounds, 800, 600).pxPerUm).toBeCloseTo(800 / 205_000, 12);
  });

  it("wraps, starting from either end", () => {
    expect(stepIndex(null, 3, 1)).toBe(0);
    expect(stepIndex(null, 3, -1)).toBe(2);
    expect(stepIndex(2, 3, 1)).toBe(0);
    expect(stepIndex(0, 3, -1)).toBe(2);
    expect(stepIndex(1, 3, 1)).toBe(2);
    expect(stepIndex(null, 0, 1)).toBeNull();
  });
});
