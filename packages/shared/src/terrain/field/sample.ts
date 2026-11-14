/**
 * Reading a height field at a paper point (docs/map-terrain.md §5.3).
 */

import { HEIGHT_NO_DATA, isConfident, type HeightField } from "./types.js";

export interface PaperPoint {
  /** Paper mm, x right, y up. */
  x: number;
  y: number;
}

/** The index of the cell containing p, or −1 outside the grid. */
export function fieldCell(f: HeightField, p: PaperPoint): number {
  const { cellMm, x0, y0, width, height } = f.header;
  const cx = Math.floor((p.x - x0) / cellMm), cy = Math.floor((p.y - y0) / cellMm);
  return cx >= 0 && cy >= 0 && cx < width && cy < height ? cy * width + cx : -1;
}

/**
 * Height in metres at p: bilinear over the four nearest cell centres,
 * clamped at the grid's outer centres; no-data neighbours are dropped and
 * the weights renormalised. Null outside the grid or in a no-data cell.
 */
export function sampleHeight(f: HeightField, p: PaperPoint): number | null {
  const cell = fieldCell(f, p);
  if (cell < 0 || f.z[cell] === HEIGHT_NO_DATA) return null;
  const { cellMm, x0, y0, width, height, zScaleM, zOffsetM } = f.header;
  const gx = Math.min(Math.max((p.x - x0) / cellMm - 0.5, 0), width - 1);
  const gy = Math.min(Math.max((p.y - y0) / cellMm - 0.5, 0), height - 1);
  const ix = Math.min(Math.floor(gx), width - 1), iy = Math.min(Math.floor(gy), height - 1);
  const fx = gx - ix, fy = gy - iy;
  const ix1 = Math.min(ix + 1, width - 1), iy1 = Math.min(iy + 1, height - 1);
  let s = 0, w = 0;
  const add = (cx: number, cy: number, wt: number) => {
    const v = f.z[cy * width + cx];
    if (wt > 0 && v !== HEIGHT_NO_DATA) {
      s += v * wt;
      w += wt;
    }
  };
  add(ix, iy, (1 - fx) * (1 - fy));
  add(ix1, iy, fx * (1 - fy));
  add(ix, iy1, (1 - fx) * fy);
  add(ix1, iy1, fx * fy);
  // the containing cell has data, so at least one corner with weight > 0 or the point sits on it
  const z = w > 0 ? s / w : f.z[cell];
  return z * zScaleM + zOffsetM;
}

/** The confidence bit of the cell containing p; false outside the grid. */
export function sampleConfident(f: HeightField, p: PaperPoint): boolean {
  const cell = fieldCell(f, p);
  return cell >= 0 && isConfident(f, cell);
}
