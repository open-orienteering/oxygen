/**
 * From band heights to the stored field (docs/map-terrain.md §4.6–4.8):
 * the field grid, resampling, smoothing, confidence, quantisation.
 */

import type { ContourGraph, RegionRaster } from "../graph/types.js";
import { LABEL } from "../graph/types.js";
import { bandHeights, bandSources, type FieldLevels } from "./interpolate.js";
import { HEIGHT_NO_DATA, TERRAIN_VERSION, Z_PER_INTERVAL, confidenceBytes, type HeightField } from "./types.js";

export const FIELD_RULES = {
  /** Target field cell, paper mm (§4.0 answer 3). */
  cellMm: 0.2,
  /** Cell budget and side limit (§4.0 answer 3). */
  maxCells: 4_000_000,
  maxSide: 4096,
  /** Box blur radius on the ground, and passes (T1). */
  smoothGroundM: 4,
  smoothPasses: 2,
  /** Default contour interval, metres (answer 8; 2.5 for ISSprOM, set by the caller). */
  intervalM: 5,
} as const;

export interface HeightFieldOptions {
  intervalM?: number;
  cellMm?: number;
  maxCells?: number;
  maxSide?: number;
}

export interface FieldGrid {
  /** Graph cells per field cell along each axis. */
  k: number;
  cellMm: number;
  width: number;
  height: number;
}

/** §4.6: the smallest whole multiple of the graph cell at or above the target that keeps within the budget. */
export function fieldGrid(r: Pick<RegionRaster, "cellMm" | "width" | "height">, opts: HeightFieldOptions = {}): FieldGrid {
  const target = opts.cellMm ?? FIELD_RULES.cellMm, maxCells = opts.maxCells ?? FIELD_RULES.maxCells, maxSide = opts.maxSide ?? FIELD_RULES.maxSide;
  let k = Math.max(1, Math.ceil(target / r.cellMm - 1e-9));
  const size = (k: number) => [Math.ceil(r.width / k), Math.ceil(r.height / k)];
  for (;;) {
    const [w, h] = size(k);
    if (w * h <= maxCells && w <= maxSide && h <= maxSide) return { k, cellMm: k * r.cellMm, width: w, height: h };
    k++;
  }
}

/** Normalised box blur over data cells (NaN is a hole); no-data cells stay NaN and give nothing. */
export function boxBlur(src: Float32Array, noData: Uint8Array, W: number, H: number, rad: number): Float32Array {
  const tmp = new Float32Array(src.length), cnt = new Float32Array(src.length), out = new Float32Array(src.length);
  for (let y = 0; y < H; y++) {
    let s = 0, n = 0;
    const row = y * W;
    for (let x = -rad; x < W; x++) {
      const xi = x + rad, xo = x - rad - 1;
      if (xi < W) {
        const v = src[row + xi];
        if (!Number.isNaN(v)) {
          s += v;
          n++;
        }
      }
      if (xo >= 0) {
        const v = src[row + xo];
        if (!Number.isNaN(v)) {
          s -= v;
          n--;
        }
      }
      if (x >= 0) {
        tmp[row + x] = s;
        cnt[row + x] = n;
      }
    }
  }
  const colS = new Float64Array(W), colN = new Float64Array(W);
  for (let y = -rad; y < H; y++) {
    const yi = y + rad, yo = y - rad - 1;
    if (yi < H) for (let x = 0; x < W; x++) {
      colS[x] += tmp[yi * W + x];
      colN[x] += cnt[yi * W + x];
    }
    if (yo >= 0) for (let x = 0; x < W; x++) {
      colS[x] -= tmp[yo * W + x];
      colN[x] -= cnt[yo * W + x];
    }
    if (y >= 0) for (let x = 0; x < W; x++) out[y * W + x] = noData[y * W + x] || colN[x] < 0.5 ? NaN : colS[x] / colN[x];
  }
  return out;
}

/** Fills the holes a blur left (no data within its radius) from their 8 neighbours, outwards; 0 where nothing reaches. */
function fillHoles(h: Float32Array, noData: Uint8Array, W: number, H: number): void {
  let holes: number[] = [];
  for (let i = 0; i < h.length; i++) if (!noData[i] && Number.isNaN(h[i])) holes.push(i);
  while (holes.length > 0) {
    const next: number[] = [], fill: [number, number][] = [];
    for (const i of holes) {
      const x = i % W, y = (i - x) / W;
      let s = 0, n = 0;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
          const v = h[ny * W + nx];
          if (!Number.isNaN(v)) {
            s += v;
            n++;
          }
        }
      if (n > 0) fill.push([i, s / n]);
      else next.push(i);
    }
    if (fill.length === 0) {
      for (const i of next) h[i] = 0;
      return;
    }
    for (const [i, v] of fill) h[i] = v;
    holes = next;
  }
}

/** §4: the height field of a band graph and its levels. */
export function buildHeightField(g: ContourGraph, lv: FieldLevels, opts: HeightFieldOptions = {}): HeightField {
  const r = g.raster, labels = r.labels, W = r.width;
  const grid = fieldGrid(r, opts);
  const { k, width: FW, height: FH } = grid, FN = FW * FH;
  const src = bandSources(g, lv);

  // §4.7 confidence per region
  const NR = r.regionCount + 1;
  const regionConfident = new Uint8Array(NR);
  for (let reg = 1; reg < NR; reg++) {
    const n = src.boundSamples[reg];
    regionConfident[reg] = !lv.regionWeak[reg] && n > 0 && 2 * src.goodSamples[reg] >= n ? 1 : 0;
  }

  // §4.6 resample: the mean of a field cell's region cells; barriers are holes
  const sum = new Float64Array(FN), cnt = new Uint32Array(FN), confYes = new Uint32Array(FN), confNo = new Uint32Array(FN);
  const fieldOf = (i: number) => {
    const cx = i % W, cy = (i - cx) / W;
    return Math.floor(cy / k) * FW + Math.floor(cx / k);
  };
  bandHeights(g, lv, src, (i, h, reg) => {
    const fc = fieldOf(i);
    sum[fc] += h;
    cnt[fc]++;
    if (regionConfident[reg]) confYes[fc]++;
    else confNo[fc]++;
  });
  const outside = new Uint32Array(FN), total = new Uint32Array(FN);
  for (let i = 0; i < labels.length; i++) {
    const fc = fieldOf(i);
    total[fc]++;
    if (labels[i] === LABEL.outside) outside[fc]++;
  }
  const noData = new Uint8Array(FN);
  let h: Float32Array = new Float32Array(FN);
  for (let fc = 0; fc < FN; fc++) {
    noData[fc] = 2 * outside[fc] > total[fc] ? 1 : 0;
    h[fc] = noData[fc] || cnt[fc] === 0 ? NaN : sum[fc] / cnt[fc];
  }

  // §4.6 smooth on the field grid
  const rad = Math.max(1, Math.round(FIELD_RULES.smoothGroundM / (grid.cellMm * g.inputs.groundMPerMm)));
  for (let p = 0; p < FIELD_RULES.smoothPasses; p++) h = boxBlur(h, noData, FW, FH, rad);
  fillHoles(h, noData, FW, FH);

  // §4.8 quantise
  const z = new Int16Array(FN), confident = new Uint8Array(confidenceBytes(FN));
  let zMin = 32767, zMax = -32767;
  for (let fc = 0; fc < FN; fc++) {
    if (noData[fc]) {
      z[fc] = HEIGHT_NO_DATA;
      continue;
    }
    const q = Math.max(-32767, Math.min(32767, Math.round(h[fc] * Z_PER_INTERVAL)));
    z[fc] = q;
    if (q < zMin) zMin = q;
    if (q > zMax) zMax = q;
    if (confYes[fc] > confNo[fc]) confident[fc >> 3] |= 1 << (fc & 7);
  }
  if (zMin > zMax) zMin = zMax = 0;
  const intervalM = opts.intervalM ?? FIELD_RULES.intervalM;
  return {
    header: {
      version: TERRAIN_VERSION,
      source: "contours",
      cellMm: grid.cellMm,
      x0: r.x0,
      y0: r.y0,
      width: FW,
      height: FH,
      groundMPerMm: g.inputs.groundMPerMm,
      intervalM,
      zScaleM: intervalM / Z_PER_INTERVAL,
      zOffsetM: 0,
      datum: "relative",
      zMin,
      zMax,
    },
    z,
    confident,
  };
}
