/**
 * The mapped-area mask (docs/map-terrain.md §2.3): where the map says
 * something about the terrain, as a coarse closed raster.
 */

import type { AreaMask } from "./types.js";

/** Mask cell, mm. */
export const MASK_CELL_MM = 0.5;
/** Closing radius, mm. */
export const MASK_CLOSE_MM = 4;
/** Most cells a mask grid may have; a larger area gets coarser cells (docs/map-terrain.md §2.3). */
export const MASK_MAX_CELLS = 8_000_000;

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

/** Grid cell and size for `box`: 0.5 mm unless the padded area would exceed `MASK_MAX_CELLS`. */
function maskGrid(box: Box): { cellMm: number; rc: number; pad: number; W: number; H: number } {
  const w = box.maxX - box.minX, h = box.maxY - box.minY;
  // Area of the box padded as for a 0.5 mm cell; the cell that holds it in the budget.
  const padDefault = Math.ceil(MASK_CLOSE_MM / MASK_CELL_MM) + 3;
  const padMm = padDefault * MASK_CELL_MM;
  const area = (w + 2 * padMm) * (h + 2 * padMm);
  let cellMm = Math.max(MASK_CELL_MM, Math.sqrt(area / MASK_MAX_CELLS));
  for (;;) {
    const rc = MASK_CLOSE_MM / cellMm;
    const pad = Math.ceil(rc) + 3;
    const W = Math.ceil(w / cellMm) + 2 * pad + 1;
    const H = Math.ceil(h / cellMm) + 2 * pad + 1;
    if (W * H <= MASK_MAX_CELLS || !Number.isFinite(cellMm)) return { cellMm, rc, pad, W, H };
    cellMm *= 1.01;
  }
}

/**
 * Draws every part into a grid over `box` (cell 0.5 mm, coarser only when
 * the grid would exceed `MASK_MAX_CELLS`; padded by the closing radius and
 * three cells) and closes it with radius 4 mm: dilate, fill what the grid
 * border cannot reach, erode.
 */
export function mappedAreaMask(parts: readonly ArrayLike<number>[], box: Box): AreaMask {
  const { cellMm, rc, pad, W, H } = maskGrid(box);
  const x0 = box.minX - pad * cellMm, y0 = box.minY - pad * cellMm;
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
  // Each cell is marked on push, so it is pushed once and the stack never exceeds the grid.
  const stack = new Int32Array(W * H);
  let sp = 0;
  const push = (i: number) => {
    if (reach[i] || dilated[i]) return;
    reach[i] = 1;
    stack[sp++] = i;
  };
  for (let x = 0; x < W; x++) { push(x); push((H - 1) * W + x); }
  for (let y = 0; y < H; y++) { push(y * W); push(y * W + W - 1); }
  while (sp > 0) {
    const i = stack[--sp];
    const x = i % W, y = (i / W) | 0;
    if (x > 0) push(i - 1);
    if (x < W - 1) push(i + 1);
    if (y > 0) push(i - W);
    if (y < H - 1) push(i + W);
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
