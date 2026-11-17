/**
 * Surface normals of a height field (docs/map-terrain.md §5.4), computed
 * on demand: they follow from the heights and would add 150 % to the
 * artifact.
 */

import { HEIGHT_NO_DATA, type HeightField } from "./types.js";

/**
 * Three snorm8 per cell (x right, y up, z up): central differences in
 * ground metres, one-sided beside no-data and at the edge, a zero slope on
 * an axis with no data neighbour; (0, 0, 127) in no-data cells.
 */
export function heightNormals(f: HeightField, exaggeration = 1): Int8Array {
  const { width: W, height: H, cellMm, groundMPerMm, zScaleM } = f.header;
  const z = f.z;
  const out = new Int8Array(W * H * 3);
  const k = (zScaleM * exaggeration) / (cellMm * groundMPerMm);
  const has = (i: number) => z[i] !== HEIGHT_NO_DATA;
  for (let cy = 0; cy < H; cy++)
    for (let cx = 0; cx < W; cx++) {
      const i = cy * W + cx;
      if (!has(i)) {
        out[i * 3 + 2] = 127;
        continue;
      }
      const l = cx > 0 && has(i - 1), r = cx < W - 1 && has(i + 1);
      const d = cy > 0 && has(i - W), u = cy < H - 1 && has(i + W);
      const sx = l && r ? (z[i + 1] - z[i - 1]) / 2 : r ? z[i + 1] - z[i] : l ? z[i] - z[i - 1] : 0;
      const sy = d && u ? (z[i + W] - z[i - W]) / 2 : u ? z[i + W] - z[i] : d ? z[i] - z[i - W] : 0;
      const a = sx * k, b = sy * k, len = Math.hypot(a, b, 1);
      out[i * 3] = Math.round((-a / len) * 127);
      out[i * 3 + 1] = Math.round((-b / len) * 127);
      out[i * 3 + 2] = Math.round((1 / len) * 127);
    }
  return out;
}
