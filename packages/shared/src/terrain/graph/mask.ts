/**
 * The mapped-area mask (docs/map-terrain.md §2.3): where the map says
 * something about the terrain, as a coarse closed raster.
 */

import type { AreaMask } from "./types.js";

/** Mask cell, mm. */
export const MASK_CELL_MM = 0.5;
/** Closing radius, mm. */
export const MASK_CLOSE_MM = 4;

export interface Box {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** Bounding box of flat polylines; null when there are no points. */
export function polylinesBox(parts: Iterable<ArrayLike<number>>): Box | null {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of parts) {
    for (let i = 0; i < p.length; i += 2) {
      if (p[i] < minX) minX = p[i];
      if (p[i] > maxX) maxX = p[i];
      if (p[i + 1] < minY) minY = p[i + 1];
      if (p[i + 1] > maxY) maxY = p[i + 1];
    }
  }
  return Number.isFinite(minX) ? { minX, minY, maxX, maxY } : null;
}

/** Two-pass 3-4 chamfer distance, in cells, to the cells where `src` is 1. */
export function chamferDistance(src: Uint8Array, w: number, h: number): Float32Array {
  const d = new Float32Array(w * h).fill(1e9);
  for (let i = 0; i < d.length; i++) if (src[i]) d[i] = 0;
  const A = 1, B = 4 / 3;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      let v = d[i];
      if (x > 0) v = Math.min(v, d[i - 1] + A);
      if (y > 0) {
        v = Math.min(v, d[i - w] + A);
        if (x > 0) v = Math.min(v, d[i - w - 1] + B);
        if (x < w - 1) v = Math.min(v, d[i - w + 1] + B);
      }
      d[i] = v;
    }
  }
  for (let y = h - 1; y >= 0; y--) {
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x;
      let v = d[i];
      if (x < w - 1) v = Math.min(v, d[i + 1] + A);
      if (y < h - 1) {
        v = Math.min(v, d[i + w] + A);
        if (x < w - 1) v = Math.min(v, d[i + w + 1] + B);
        if (x > 0) v = Math.min(v, d[i + w - 1] + B);
      }
      d[i] = v;
    }
  }
  return d;
}

/**
 * Draws every part into a 0.5 mm grid over `box` (padded by the closing
 * radius and three cells) and closes it with radius 4 mm: dilate, fill
 * what the grid border cannot reach, erode.
 */
export function mappedAreaMask(parts: readonly ArrayLike<number>[], box: Box): AreaMask {
  const cellMm = MASK_CELL_MM;
  const rc = MASK_CLOSE_MM / cellMm;
  const pad = rc + 3;
  const x0 = box.minX - pad * cellMm, y0 = box.minY - pad * cellMm;
  const W = Math.ceil((box.maxX - box.minX) / cellMm) + 2 * pad + 1;
  const H = Math.ceil((box.maxY - box.minY) / cellMm) + 2 * pad + 1;
  const drawn = new Uint8Array(W * H);
  for (const p of parts) {
    const n = p.length / 2;
    for (let i = 0; i < n; i++) {
      const x1 = p[i * 2], y1 = p[i * 2 + 1];
      const x2 = i + 1 < n ? p[i * 2 + 2] : x1, y2 = i + 1 < n ? p[i * 2 + 3] : y1;
      const steps = Math.max(1, Math.ceil(Math.hypot(x2 - x1, y2 - y1) / (cellMm * 0.5)));
      for (let s = 0; s <= steps; s++) {
        const cx = Math.floor((x1 + ((x2 - x1) * s) / steps - x0) / cellMm);
        const cy = Math.floor((y1 + ((y2 - y1) * s) / steps - y0) / cellMm);
        if (cx >= 0 && cy >= 0 && cx < W && cy < H) drawn[cy * W + cx] = 1;
      }
    }
  }
  const d1 = chamferDistance(drawn, W, H);
  const dilated = new Uint8Array(W * H);
  for (let i = 0; i < dilated.length; i++) dilated[i] = d1[i] <= rc ? 1 : 0;
  // Everything the grid border reaches through undilated cells is outside.
  const reach = new Uint8Array(W * H);
  const stack: number[] = [];
  for (let x = 0; x < W; x++) stack.push(x, (H - 1) * W + x);
  for (let y = 0; y < H; y++) stack.push(y * W, y * W + W - 1);
  while (stack.length) {
    const i = stack.pop()!;
    if (reach[i] || dilated[i]) continue;
    reach[i] = 1;
    const x = i % W, y = (i / W) | 0;
    if (x > 0) stack.push(i - 1);
    if (x < W - 1) stack.push(i + 1);
    if (y > 0) stack.push(i - W);
    if (y < H - 1) stack.push(i + W);
  }
  const d2 = chamferDistance(reach, W, H);
  const cells = new Uint8Array(W * H);
  for (let i = 0; i < cells.length; i++) cells[i] = d2[i] > rc ? 1 : 0;
  return { cellMm, x0, y0, width: W, height: H, cells };
}

/** True when (x, y) lies inside the mapped area. */
export function maskAt(mask: AreaMask, x: number, y: number): boolean {
  const cx = Math.floor((x - mask.x0) / mask.cellMm), cy = Math.floor((y - mask.y0) / mask.cellMm);
  return cx >= 0 && cy >= 0 && cx < mask.width && cy < mask.height && mask.cells[cy * mask.width + cx] === 1;
}
