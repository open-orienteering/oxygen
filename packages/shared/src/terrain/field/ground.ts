/**
 * The ground field (docs/map-terrain.md §7.4): a DEM resampled onto a
 * height field's grid, so the renderer sees one shape for both sources
 * (10 §3). Not masked to the mapped area: no-data only where the DEM has
 * none.
 */

import { HEIGHT_NO_DATA, Z_PER_INTERVAL, confidenceBytes, type HeightField, type HeightFieldHeader, type HeightFieldProvider } from "./types.js";

/** DEM height in metres at a paper position (mm, y up); NaN = no data. */
export type GroundSampler = (xMm: number, yMm: number) => number;

export interface GroundFieldOptions {
  /** The grid: the contours field's (§4.6), so both sources line up cell for cell. */
  grid: Pick<HeightFieldHeader, "version" | "cellMm" | "x0" | "y0" | "width" | "height" | "groundMPerMm" | "intervalM">;
  /** `ground.<provider>` (§7.0 answer 3). */
  source: HeightFieldHeader["source"];
  provider: HeightFieldProvider;
}

export const GROUND_RULES = {
  /** A field cell up to this many DEM cells takes a point sample at its centre; a larger one the mean of a sub-sampled box. */
  pointSampleCells: 1.5,
  /** At most this many sub-samples per axis in a box. */
  maxSubsamples: 8,
} as const;

/**
 * §7.4: one value per field cell — the sampler at the centre, or, where a
 * field cell spans more than 1.5 DEM cells, the mean of n × n samples
 * (n = ⌈cell / DEM cell⌉, at most 8) so a coarse grid does not alias a
 * fine model. A cell is no-data when more than half its samples are.
 * `zOffsetM` is the whole interval at or below the lowest value; the
 * confidence plane is all set for an anchor-grade model and all clear for
 * a coarse one (answer 13: a 30 m surface model).
 */
export function buildGroundField(sample: GroundSampler, opts: GroundFieldOptions): HeightField {
  const { grid, provider } = opts;
  const W = grid.width, H = grid.height, N = W * H, I = grid.intervalM;
  const cellGroundM = grid.cellMm * grid.groundMPerMm;
  const n = cellGroundM <= GROUND_RULES.pointSampleCells * provider.resolutionM ? 1 : Math.min(GROUND_RULES.maxSubsamples, Math.ceil(cellGroundM / provider.resolutionM));
  const metres = new Float64Array(N).fill(NaN);
  let min = Infinity;
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      let s = 0, c = 0;
      for (let sy = 0; sy < n; sy++)
        for (let sx = 0; sx < n; sx++) {
          const v = sample(grid.x0 + (x + (sx + 0.5) / n) * grid.cellMm, grid.y0 + (y + (sy + 0.5) / n) * grid.cellMm);
          if (Number.isFinite(v)) {
            s += v;
            c++;
          }
        }
      if (c === 0 || 2 * c < n * n) continue;
      const m = s / c;
      metres[y * W + x] = m;
      if (m < min) min = m;
    }
  const zOffsetM = Number.isFinite(min) ? I * Math.floor(min / I) : 0;
  const zScaleM = I / Z_PER_INTERVAL;
  const z = new Int16Array(N), confident = new Uint8Array(confidenceBytes(N));
  let zMin = 32767, zMax = -32767;
  for (let i = 0; i < N; i++) {
    const m = metres[i];
    if (Number.isNaN(m)) {
      z[i] = HEIGHT_NO_DATA;
      continue;
    }
    const q = Math.max(-32767, Math.min(32767, Math.round((m - zOffsetM) / zScaleM)));
    z[i] = q;
    if (q < zMin) zMin = q;
    if (q > zMax) zMax = q;
    if (provider.grade === "anchor") confident[i >> 3] |= 1 << (i & 7);
  }
  if (zMin > zMax) zMin = zMax = 0;
  return {
    header: {
      version: grid.version, source: opts.source,
      cellMm: grid.cellMm, x0: grid.x0, y0: grid.y0, width: W, height: H,
      groundMPerMm: grid.groundMPerMm, intervalM: I, zScaleM, zOffsetM, datum: "absolute", zMin, zMax, provider,
    },
    z,
    confident,
  };
}
