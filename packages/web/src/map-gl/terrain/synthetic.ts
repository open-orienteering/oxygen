/**
 * Synthetic height fields for the terrain dev page and tests
 * (docs/map-rendering.md §5.6 "Dev page"): a cone, a slope and a seeded
 * noise surface, built straight from a header and planes.
 */

import { HEIGHT_NO_DATA, TERRAIN_VERSION, Z_PER_INTERVAL, confidenceBytes, type HeightField } from "@oxygen/shared/src/terrain/field/read.js";

export interface SyntheticOptions {
  cellMm?: number;
  x0?: number;
  y0?: number;
  groundMPerMm?: number;
  intervalM?: number;
  zOffsetM?: number;
}

/** A field from `metres(cx, cy)` at each cell; NaN is no-data. */
export function fieldFromGrid(width: number, height: number, metres: (cx: number, cy: number) => number, opts: SyntheticOptions = {}): HeightField {
  const intervalM = opts.intervalM ?? 5, zScaleM = intervalM / Z_PER_INTERVAL, zOffsetM = opts.zOffsetM ?? 0;
  const z = new Int16Array(width * height);
  let zMin = 32767, zMax = -32767;
  for (let cy = 0; cy < height; cy++)
    for (let cx = 0; cx < width; cx++) {
      const m = metres(cx, cy);
      const q = Number.isNaN(m) ? HEIGHT_NO_DATA : Math.max(-32767, Math.min(32767, Math.round((m - zOffsetM) / zScaleM)));
      z[cy * width + cx] = q;
      if (q !== HEIGHT_NO_DATA) {
        zMin = Math.min(zMin, q);
        zMax = Math.max(zMax, q);
      }
    }
  if (zMin > zMax) zMin = zMax = 0;
  return {
    header: {
      version: TERRAIN_VERSION,
      source: "contours",
      cellMm: opts.cellMm ?? 0.2,
      x0: opts.x0 ?? 0,
      y0: opts.y0 ?? 0,
      width,
      height,
      groundMPerMm: opts.groundMPerMm ?? 15,
      intervalM,
      zScaleM,
      zOffsetM,
      datum: "relative",
      zMin,
      zMax,
    },
    z,
    confident: new Uint8Array(confidenceBytes(width * height)).fill(0xff),
  };
}

/**
 * The dev page's cone: 161 × 161 cells of 0.2 mm at 1:15 000 (3 m) from
 * paper (10, 20) mm, apex at the centre cell, radius 60 cells (180 m),
 * 45 m high — a ground slope of 1 : 4 — on flat ground, with a 4-cell
 * no-data margin.
 */
export const CONE = { width: 161, height: 161, cellMm: 0.2, x0: 10, y0: 20, groundMPerMm: 15, radiusCells: 60, heightM: 45, margin: 4 } as const;

export function coneField(): HeightField {
  const c = CONE, mid = (c.width - 1) / 2;
  return fieldFromGrid(
    c.width,
    c.height,
    (cx, cy) => {
      if (cx < c.margin || cy < c.margin || cx >= c.width - c.margin || cy >= c.height - c.margin) return NaN;
      const r = Math.hypot(cx - mid, cy - mid);
      return Math.max(0, c.heightM * (1 - r / c.radiusCells));
    },
    c,
  );
}

/** The cone's centre in paper mm. */
export const coneCentreMm = (): { x: number; y: number } => ({ x: CONE.x0 + ((CONE.width - 1) / 2 + 0.5) * CONE.cellMm, y: CONE.y0 + ((CONE.height - 1) / 2 + 0.5) * CONE.cellMm });

/** The dev page's checker drape: two colours, square edge on paper; `a` where ⌊x / 2⌋ + ⌊y / 2⌋ is even. */
export const CHECKER = { a: [0xe8, 0xd8, 0xa0], b: [0x3a, 0x6e, 0xa5], squareMm: 2 } as const;

/** A plane rising 1 : 4 eastwards, 128 × 96 cells. */
export function slopeField(): HeightField {
  return fieldFromGrid(128, 96, (cx) => cx * 3 * 0.25, { cellMm: 0.2, groundMPerMm: 15 });
}

/** A small deterministic generator (mulberry32). */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Seeded value noise in three octaves, up to `amplitudeM` high, tapered
 * to 0 over the outer eighth so the field's border lies on z = 0 (the
 * dev page's crack check counts background inside the border's outline).
 */
export function noiseField(width = 300, height = 200, seed = 7, amplitudeM = 40): HeightField {
  const rand = seededRandom(seed);
  const octaves = [24, 9, 4].map((cells) => {
    const gw = Math.ceil(width / cells) + 2, gh = Math.ceil(height / cells) + 2;
    const g = new Float64Array(gw * gh).map(() => rand());
    return { cells, gw, g };
  });
  const smooth = (t: number) => t * t * (3 - 2 * t);
  const value = (o: (typeof octaves)[number], x: number, y: number) => {
    const fx = x / o.cells, fy = y / o.cells, ix = Math.floor(fx), iy = Math.floor(fy);
    const tx = smooth(fx - ix), ty = smooth(fy - iy), at = (a: number, b: number) => o.g[b * o.gw + a];
    return (at(ix, iy) * (1 - tx) + at(ix + 1, iy) * tx) * (1 - ty) + (at(ix, iy + 1) * (1 - tx) + at(ix + 1, iy + 1) * tx) * ty;
  };
  const taper = (i: number, n: number) => smooth(Math.min(1, Math.min(i, n - 1 - i) / (n / 8)));
  return fieldFromGrid(
    width,
    height,
    (cx, cy) => amplitudeM * (0.6 * value(octaves[0], cx, cy) + 0.3 * value(octaves[1], cx, cy) + 0.1 * value(octaves[2], cx, cy)) * taper(cx, width) * taper(cy, height),
    { cellMm: 0.2, groundMPerMm: 15 },
  );
}
