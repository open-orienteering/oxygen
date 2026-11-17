/**
 * Barrier raster and regions (docs/map-terrain.md §2.4–2.5).
 */

import { polylineEnd } from "./flatten.js";
import { maskAt, type Box } from "./mask.js";
import { LABEL, type AreaMask, type Chain, type CliffLine, type RegionRaster } from "./types.js";

export const RASTER_RULES = {
  cellMm: 0.1,
  maxCells: 60e6,
  padMm: 2,
  frameExtensionMm: 4,
  nearMissMm: 1.5,
} as const;

export interface RasterOptions {
  cellMm?: number;
  maxCells?: number;
}

/** Index of the cell holding (x, y), or −1 outside the raster. */
export function cellIndex(r: Pick<RegionRaster, "cellMm" | "x0" | "y0" | "width" | "height">, x: number, y: number): number {
  const cx = Math.floor((x - r.x0) / r.cellMm), cy = Math.floor((y - r.y0) / r.cellMm);
  return cx >= 0 && cy >= 0 && cx < r.width && cy < r.height ? cy * r.width + cx : -1;
}

/**
 * The barrier raster over `box` (the contour chains' bounding box): the
 * outside from the mask, cliffs, then chains; frame ends extended 4 mm;
 * dangling ends drawn onto a cliff or chain within 1.5 mm straight ahead
 * (their class becomes `extended`, in place). Regions are not labelled yet.
 */
export function rasteriseBarriers(chains: Chain[], cliffs: readonly CliffLine[], mask: AreaMask, box: Box, opts: RasterOptions = {}): RegionRaster {
  const pad = RASTER_RULES.padMm;
  const areaMm2 = (box.maxX - box.minX + 2 * pad) * (box.maxY - box.minY + 2 * pad);
  const cellMm = Math.max(opts.cellMm ?? RASTER_RULES.cellMm, Math.sqrt(areaMm2 / (opts.maxCells ?? RASTER_RULES.maxCells)));
  const x0 = box.minX - pad, y0 = box.minY - pad;
  const width = Math.ceil((box.maxX - box.minX + 2 * pad) / cellMm);
  const height = Math.ceil((box.maxY - box.minY + 2 * pad) / cellMm);
  const labels = new Int32Array(width * height);
  const r: RegionRaster = { cellMm, x0, y0, width, height, labels, regionCount: 0, regionCells: new Uint32Array(1), regionTouchesOutside: new Uint8Array(1) };
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) if (!maskAt(mask, x0 + (x + 0.5) * cellMm, y0 + (y + 0.5) * cellMm)) labels[y * width + x] = LABEL.outside;
  }
  const drawSeg = (xa: number, ya: number, xb: number, yb: number, v: number, keep = false): void => {
    const steps = Math.max(1, Math.ceil(Math.hypot(xb - xa, yb - ya) / (cellMm * 0.5)));
    for (let s = 0; s <= steps; s++) {
      const c = cellIndex(r, xa + ((xb - xa) * s) / steps, ya + ((yb - ya) * s) / steps);
      if (c >= 0 && !(keep && (labels[c] <= LABEL.chain0 || labels[c] === LABEL.outside))) labels[c] = v;
    }
  };
  for (const c of cliffs) for (let i = 2; i < c.pts.length; i += 2) drawSeg(c.pts[i - 2], c.pts[i - 1], c.pts[i], c.pts[i + 1], LABEL.cliff);
  chains.forEach((c, ci) => {
    const p = c.pts, n = p.length / 2, v = LABEL.chain0 - ci;
    for (let i = 1; i < n; i++) drawSeg(p[i * 2 - 2], p[i * 2 - 1], p[i * 2], p[i * 2 + 1], v);
    if (c.closed) drawSeg(p[n * 2 - 2], p[n * 2 - 1], p[0], p[1], v);
    else if (c.ends) {
      for (const w of [0, 1] as const) {
        if (c.ends[w] !== "frame") continue;
        const e = polylineEnd(p, w);
        const L = RASTER_RULES.frameExtensionMm;
        drawSeg(e.x, e.y, e.x + e.tx * L, e.y + e.ty * L, v, true);
      }
    }
  });
  chains.forEach((c, ci) => {
    if (!c.ends) return;
    const v = LABEL.chain0 - ci;
    for (const w of [0, 1] as const) {
      if (c.ends[w] !== "dangling") continue;
      const e = polylineEnd(c.pts, w);
      for (let d = 2 * cellMm; d <= RASTER_RULES.nearMissMm; d += cellMm * 0.5) {
        const i = cellIndex(r, e.x + e.tx * d, e.y + e.ty * d);
        if (i < 0 || labels[i] === LABEL.outside) break;
        if (labels[i] === LABEL.cliff || (labels[i] <= LABEL.chain0 && labels[i] !== v)) {
          drawSeg(e.x, e.y, e.x + e.tx * d, e.y + e.ty * d, v, true);
          c.ends[w] = "extended";
          break;
        }
      }
    }
  });
  return r;
}

/** Flood-fills the free cells 4-connected, in cell order, into regions 1 … n (§2.5). */
export function labelRegions(r: RegionRaster): void {
  const { labels, width: W } = r;
  const N = labels.length;
  let stack = new Int32Array(1024);
  const cells: number[] = [0];
  const touches: number[] = [0];
  let n = 0;
  for (let start = 0; start < N; start++) {
    if (labels[start] !== LABEL.free) continue;
    const id = ++n;
    let sp = 0, count = 0, touch = 0;
    stack[sp++] = start;
    labels[start] = id;
    while (sp) {
      const i = stack[--sp];
      count++;
      const x = i % W;
      for (let k = 0; k < 4; k++) {
        const j = k === 0 ? (x > 0 ? i - 1 : -1) : k === 1 ? (x < W - 1 ? i + 1 : -1) : k === 2 ? (i >= W ? i - W : -1) : i < N - W ? i + W : -1;
        if (j < 0) {
          touch = 1;
          continue;
        }
        const v = labels[j];
        if (v === LABEL.free) {
          labels[j] = id;
          if (sp >= stack.length) {
            const grown = new Int32Array(stack.length * 2);
            grown.set(stack);
            stack = grown;
          }
          stack[sp++] = j;
        } else if (v === LABEL.outside) touch = 1;
      }
    }
    cells.push(count);
    touches.push(touch);
  }
  r.regionCount = n;
  r.regionCells = Uint32Array.from(cells);
  r.regionTouchesOutside = Uint8Array.from(touches);
}
