import { describe, it, expect } from "vitest";
import {
  blockOrigin,
  blockRange,
  boundsOfPoints,
  clampDensity,
  expectedTileCount,
  latToTileY,
  parseViewBox,
  quadDensity,
  tileRangeForBounds,
  windowPixelSize,
  windowViewBox,
  withViewBox,
  type OcadRect,
} from "../map-window.js";

describe("blockOrigin", () => {
  // Blocks must be aligned to a global lattice so two requests for
  // neighbouring tiles land on the same window and render once.
  it("snaps a tile index down to its block origin", () => {
    expect(blockOrigin(0, 4)).toBe(0);
    expect(blockOrigin(3, 4)).toBe(0);
    expect(blockOrigin(4, 4)).toBe(4);
    expect(blockOrigin(9, 4)).toBe(8);
  });

  it("floors toward negative infinity so tiles left of origin still align", () => {
    expect(blockOrigin(-1, 4)).toBe(-4);
    expect(blockOrigin(-4, 4)).toBe(-4);
    expect(blockOrigin(-5, 4)).toBe(-8);
  });

  it("treats a block size of 1 as one tile per window", () => {
    expect(blockOrigin(7, 1)).toBe(7);
  });
});

describe("blockRange", () => {
  it("covers a tile span with aligned blocks", () => {
    expect(blockRange(2, 9, 4)).toEqual([0, 4, 8]);
  });

  it("returns a single block when the span fits inside one", () => {
    expect(blockRange(5, 7, 4)).toEqual([4]);
  });

  it("handles an exact block boundary without adding an empty block", () => {
    expect(blockRange(4, 7, 4)).toEqual([4]);
    expect(blockRange(4, 8, 4)).toEqual([4, 8]);
  });
});

describe("boundsOfPoints", () => {
  it("computes the axis-aligned bounds of a rotated quad", () => {
    // A quad rotated 45 degrees: its AABB is larger than the quad itself.
    const quad = [
      { x: 0, y: 10 },
      { x: 10, y: 0 },
      { x: 0, y: -10 },
      { x: -10, y: 0 },
    ];
    expect(boundsOfPoints(quad)).toEqual({
      minX: -10,
      minY: -10,
      maxX: 10,
      maxY: 10,
    });
  });

  it("expands by the requested margin", () => {
    const rect = boundsOfPoints([{ x: 0, y: 0 }, { x: 4, y: 6 }], 2);
    expect(rect).toEqual({ minX: -2, minY: -2, maxX: 6, maxY: 8 });
  });
});

describe("quadDensity", () => {
  // Density is pixels per OCAD unit: enough that the output pixels resolve
  // the quad's longest edge, which is what makes deep zoom sharp.
  it("derives density from the quad edge length and output size", () => {
    // An axis-aligned 1000-unit square rendered into 500x500 px.
    const quad = {
      nw: { x: 0, y: 1000 },
      ne: { x: 1000, y: 1000 },
      sw: { x: 0, y: 0 },
      se: { x: 1000, y: 0 },
    };
    expect(quadDensity(quad, 500, 500)).toBeCloseTo(0.5, 10);
  });

  it("accounts for rotation via edge length, not bounding box", () => {
    // The same 1000-unit square rotated 45 degrees. Its AABB is 1414 units
    // across, but the edges are still 1000, so the density must not drop.
    const h = 1000 / Math.SQRT2; // half-diagonal
    const quad = {
      nw: { x: -h, y: 0 },
      ne: { x: 0, y: h },
      sw: { x: 0, y: -h },
      se: { x: h, y: 0 },
    };
    expect(quadDensity(quad, 500, 500)).toBeCloseTo(0.5, 10);
  });

  it("takes the denser of the two directions so neither axis is soft", () => {
    // 1000 units wide but only 250 tall, into a square output.
    const quad = {
      nw: { x: 0, y: 250 },
      ne: { x: 1000, y: 250 },
      sw: { x: 0, y: 0 },
      se: { x: 1000, y: 0 },
    };
    // x needs 0.5 px/unit, y needs 2 px/unit -> 2 wins.
    expect(quadDensity(quad, 500, 500)).toBeCloseTo(2, 10);
  });

  // A tile whose corners all project to one point has nothing to render;
  // callers use the zero to bail instead of dividing by it.
  it("reports zero density for a degenerate quad", () => {
    const p = { x: 5, y: 5 };
    expect(quadDensity({ nw: p, ne: p, sw: p, se: p }, 256, 256)).toBe(0);
  });
});

describe("clampDensity", () => {
  const rect: OcadRect = { minX: 0, minY: 0, maxX: 1000, maxY: 1000 };

  it("leaves a density that fits the pixel budget untouched", () => {
    // 1000x1000 units at 1 px/unit = 1M pixels.
    expect(clampDensity(rect, 1, 4_000_000)).toBe(1);
  });

  it("scales density down to the budget", () => {
    // At 4 px/unit the window would be 16M pixels; budget 4M -> 2 px/unit.
    expect(clampDensity(rect, 4, 4_000_000)).toBeCloseTo(2, 10);
  });

  it("never returns zero or a negative density", () => {
    expect(clampDensity(rect, 4, 1)).toBeGreaterThan(0);
  });
});

describe("windowPixelSize", () => {
  it("rounds up so the window fully covers the rect", () => {
    const rect: OcadRect = { minX: 0, minY: 0, maxX: 100.2, maxY: 50.7 };
    expect(windowPixelSize(rect, 2)).toEqual({ width: 201, height: 102 });
  });

  it("never returns a zero dimension", () => {
    const rect: OcadRect = { minX: 0, minY: 0, maxX: 0, maxY: 0 };
    const size = windowPixelSize(rect, 1);
    expect(size.width).toBeGreaterThan(0);
    expect(size.height).toBeGreaterThan(0);
  });
});

describe("windowViewBox", () => {
  // ocad2geojson emits a root viewBox spanning the OCAD bounds with the y
  // axis flipped (it negates y and translates by minY+maxY). A window is a
  // sub-rectangle of that same user space.
  const root = { minX: -33146, minY: -18242, width: 42544, height: 38937 };
  const bounds = [-33146, -18242, 9398, 20695];

  it("maps the full bounds back onto the root viewBox", () => {
    const rect: OcadRect = { minX: -33146, minY: -18242, maxX: 9398, maxY: 20695 };
    expect(windowViewBox(root, bounds, rect)).toBe("-33146 -18242 42544 38937");
  });

  it("flips y: the rect's top edge becomes the viewBox's minY", () => {
    // A rect at the very top of the map starts at the root viewBox minY.
    const rect: OcadRect = { minX: -33146, minY: 20595, maxX: -33046, maxY: 20695 };
    expect(windowViewBox(root, bounds, rect)).toBe("-33146 -18242 100 100");
  });

  it("offsets x and y proportionally for an interior window", () => {
    const rect: OcadRect = { minX: -33046, minY: 20495, maxX: -32946, maxY: 20595 };
    // x: 100 units right of minX; y: 100 units below maxY.
    expect(windowViewBox(root, bounds, rect)).toBe("-33046 -18142 100 100");
  });

  it("returns null when the root viewBox does not span the OCAD bounds", () => {
    // Guards against an ocad2geojson change silently shifting every window.
    const odd = { minX: 0, minY: 0, width: 100, height: 100 };
    const rect: OcadRect = { minX: 0, minY: 0, maxX: 10, maxY: 10 };
    expect(windowViewBox(odd, bounds, rect)).toBeNull();
  });
});

describe("tileRangeForBounds / expectedTileCount", () => {
  // A small Stockholm-area map, roughly the size of a sprint map.
  const bounds = { north: 59.28, south: 59.26, east: 18.13, west: 18.09 };

  it("covers the box with an inclusive tile range", () => {
    const r = tileRangeForBounds(bounds, 14);
    expect(r.x1).toBeGreaterThanOrEqual(r.x0);
    expect(r.y1).toBeGreaterThanOrEqual(r.y0);
    // North is a smaller tile y than south in slippy coordinates.
    expect(latToTileY(bounds.north, 14)).toBeLessThanOrEqual(
      latToTileY(bounds.south, 14),
    );
  });

  it("grows monotonically with zoom, at most ~4x plus boundary tiles", () => {
    const atZ = (z: number) => expectedTileCount(bounds, z, z);
    // A sprint-sized map sits inside a single tile for the first few levels.
    expect(atZ(10)).toBe(1);
    for (let z = 11; z <= 17; z++) {
      const ratio = atZ(z) / atZ(z - 1);
      expect(ratio).toBeGreaterThanOrEqual(1);
      // Halving the tile size at most doubles each axis, +1 per axis for a
      // range that straddles a new boundary: (2n+1)^2/n^2 <= 9.
      expect(ratio).toBeLessThanOrEqual(9);
    }
    expect(atZ(17)).toBeGreaterThan(atZ(10));
  });

  it("sums the pre-cache zoom span", () => {
    let sum = 0;
    for (let z = 10; z <= 17; z++) sum += expectedTileCount(bounds, z, z);
    expect(expectedTileCount(bounds)).toBe(sum);
  });

  it("is deterministic, so any instance computes the same denominator", () => {
    expect(expectedTileCount(bounds)).toBe(expectedTileCount({ ...bounds }));
  });
});

describe("parseViewBox", () => {
  // ocad2geojson emits commas; hand-written SVG usually uses spaces.
  it("parses a comma-separated viewBox", () => {
    expect(parseViewBox('<svg viewBox="-33146,-18242,42544,38937"><g/></svg>')).toEqual({
      minX: -33146,
      minY: -18242,
      width: 42544,
      height: 38937,
    });
  });

  it("parses a space-separated viewBox", () => {
    expect(parseViewBox('<svg viewBox="0 0 10 20"></svg>')).toEqual({
      minX: 0,
      minY: 0,
      width: 10,
      height: 20,
    });
  });

  it("returns null when absent or malformed", () => {
    expect(parseViewBox("<svg></svg>")).toBeNull();
    expect(parseViewBox('<svg viewBox="0 0 10"></svg>')).toBeNull();
    expect(parseViewBox('<svg viewBox="0 0 10 wide"></svg>')).toBeNull();
  });
});

describe("withViewBox", () => {
  it("replaces the root viewBox and leaves the body untouched", () => {
    const svg = '<svg xmlns="x" viewBox="0 0 10 10"><path d="M0 0"/></svg>';
    expect(withViewBox(svg, "1 2 3 4")).toBe(
      '<svg xmlns="x" viewBox="1 2 3 4"><path d="M0 0"/></svg>',
    );
  });

  // Child elements carry their own viewBox attributes (symbol elements do);
  // only the root may be rewritten or the map content would be rescaled.
  it("does not touch a viewBox inside the document body", () => {
    const svg = '<svg viewBox="0 0 10 10"><symbol viewBox="0 0 5 5"/></svg>';
    expect(withViewBox(svg, "9 9 9 9")).toBe(
      '<svg viewBox="9 9 9 9"><symbol viewBox="0 0 5 5"/></svg>',
    );
  });
});
