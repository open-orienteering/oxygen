/**
 * The compare view's diff (docs/map-symbols.md §8.7 "Compare — diff (row
 * I8b)"): which pixels of two frames differ, the overlay drawn from them,
 * and *next difference* — a whole-map scan in tiles, changed pixels binned
 * into cells, connected cells a region, and the camera a step fits.
 *
 * A pixel has changed when its largest RGB channel difference exceeds 16:
 * the tolerance of the colour-order harness and the golden tier
 * (docs/map-rendering.md §6.2, §6.5; `DEFAULT_TOLERANCE` in
 * `packages/api/src/render/colour-order-diff.ts`, which web cannot import).
 */

import type { Frame } from "../map-gl/readback";
import type { ViewRect } from "../map-gl/buckets";
import { fitMm, type PaperViewport } from "./map-viewport";

export const DIFF_TOLERANCE = 16;
/** Scan tiles, device px a side. */
export const SCAN_TILE_PX = 1024;
/** The scan's resolution, px per paper mm, lowered until the map takes at most `SCAN_MAX_TILES` tiles. */
export const SCAN_PX_PER_MM = 6;
export const SCAN_MAX_TILES = 64;
/** Changed pixels are binned into cells this size, paper mm. */
export const DIFF_CELL_MM = 5;
/** A step's zoom limit, CSS px per paper mm. */
export const STEP_MAX_PX_PER_MM = 16;

type Bounds = { minX: number; minY: number; maxX: number; maxY: number };

/** 1 per changed pixel, top row first; `null` when the frames differ in size (nothing to compare). */
export function changedMask(a: Frame, b: Frame, tolerance = DIFF_TOLERANCE): { mask: Uint8Array; changed: number } | null {
  if (a.width !== b.width || a.height !== b.height || a.data.length !== b.data.length) return null;
  const n = a.width * a.height;
  const mask = new Uint8Array(n);
  let changed = 0;
  const pa = a.data, pb = b.data;
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    const d = Math.max(Math.abs(pa[j]! - pb[j]!), Math.abs(pa[j + 1]! - pb[j + 1]!), Math.abs(pa[j + 2]! - pb[j + 2]!));
    if (d > tolerance) {
      mask[i] = 1;
      changed++;
    }
  }
  return { mask, changed };
}

/** The overlay's RGBA: unchanged pixels veiled white at 75 %, changed ones opaque red. */
export const VEIL: readonly [number, number, number, number] = [255, 255, 255, 191];
export const CHANGED: readonly [number, number, number, number] = [220, 38, 38, 255];

export function overlayPixels(mask: Uint8Array): Uint8ClampedArray<ArrayBuffer> {
  const out = new Uint8ClampedArray(mask.length * 4);
  for (let i = 0; i < mask.length; i++) out.set(mask[i] ? CHANGED : VEIL, i * 4);
  return out;
}

// ─── The scan ────────────────────────────────────────────────

/**
 * The scan's px per mm for a map `w × h` mm: 6, lowered until the tiles
 * (`SCAN_TILE_PX` a side) number at most `SCAN_MAX_TILES` — the best
 * resolution over every split into c columns and ⌊64 / c⌋ rows.
 */
export function scanPxPerMm(w: number, h: number): number {
  if (!(w > 0) || !(h > 0)) return SCAN_PX_PER_MM;
  let best = 0;
  for (let c = 1; c <= SCAN_MAX_TILES; c++) best = Math.max(best, Math.min((c * SCAN_TILE_PX) / w, (Math.floor(SCAN_MAX_TILES / c) * SCAN_TILE_PX) / h));
  return Math.min(SCAN_PX_PER_MM, best);
}

export interface ScanTile {
  col: number;
  row: number;
  /** Paper mm of the tile's top-left corner. */
  left: number;
  top: number;
  view: ViewRect;
}

/** The tiles over `bounds` (paper mm), from its top-left corner, reading order. */
export function scanGrid(bounds: Bounds): { pxPerMm: number; tileMm: number; cols: number; rows: number; tiles: ScanTile[] } {
  const w = bounds.maxX - bounds.minX, h = bounds.maxY - bounds.minY;
  const pxPerMm = scanPxPerMm(w, h);
  const tileMm = SCAN_TILE_PX / pxPerMm;
  // A hair under: an exact fit is not one tile more.
  const cols = Math.max(1, Math.ceil(w / tileMm - 1e-9)), rows = Math.max(1, Math.ceil(h / tileMm - 1e-9));
  const tiles: ScanTile[] = [];
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const left = bounds.minX + col * tileMm, top = bounds.maxY - row * tileMm;
      tiles.push({
        col,
        row,
        left,
        top,
        view: { centreX: (left + tileMm / 2) * 1000, centreY: (top - tileMm / 2) * 1000, pxPerUm: pxPerMm / 1000, widthPx: SCAN_TILE_PX, heightPx: SCAN_TILE_PX, rotationDeg: 0 },
      });
    }
  }
  return { pxPerMm, tileMm, cols, rows, tiles };
}

/** Changed pixels per cell, keyed `col,row` (cells of `DIFF_CELL_MM` from the bounds' top-left corner). */
export type CellCounts = Map<string, number>;

/** Adds a tile's changed pixels to `cells`. */
export function binCells(cells: CellCounts, mask: Uint8Array, width: number, tile: { left: number; top: number }, pxPerMm: number, bounds: Bounds, cellMm = DIFF_CELL_MM): void {
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue;
    const x = tile.left + ((i % width) + 0.5) / pxPerMm, y = tile.top - (Math.floor(i / width) + 0.5) / pxPerMm;
    const k = `${Math.floor((x - bounds.minX) / cellMm)},${Math.floor((bounds.maxY - y) / cellMm)}`;
    cells.set(k, (cells.get(k) ?? 0) + 1);
  }
}

export interface DiffRegion {
  /** Changed pixels in its cells. */
  changed: number;
  cells: number;
  /** Cell bounds, columns and rows from the top-left. */
  minCol: number;
  minRow: number;
  maxCol: number;
  maxRow: number;
  /** The leftmost cell of its top row (reading order). */
  firstCol: number;
}

/** 8-connected cells as regions, most changed pixels first, ties in reading order (topmost, then leftmost). */
export function regionsOf(cells: CellCounts): DiffRegion[] {
  const seen = new Set<string>();
  const regions: DiffRegion[] = [];
  for (const start of cells.keys()) {
    if (seen.has(start)) continue;
    seen.add(start);
    const stack = [start];
    let changed = 0, count = 0, minCol = Infinity, minRow = Infinity, maxCol = -Infinity, maxRow = -Infinity, firstCol = Infinity;
    while (stack.length) {
      const k = stack.pop()!;
      const [c, r] = k.split(",").map(Number) as [number, number];
      changed += cells.get(k)!;
      count++;
      if (r < minRow) { minRow = r; firstCol = c; } else if (r === minRow && c < firstCol) firstCol = c;
      minCol = Math.min(minCol, c); maxCol = Math.max(maxCol, c); maxRow = Math.max(maxRow, r);
      for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
        const n = `${c + dc},${r + dr}`;
        if (cells.has(n) && !seen.has(n)) { seen.add(n); stack.push(n); }
      }
    }
    regions.push({ changed, cells: count, minCol, minRow, maxCol, maxRow, firstCol });
  }
  return regions.sort((a, b) => b.changed - a.changed || a.minRow - b.minRow || a.firstCol - b.firstCol);
}

// ─── Stepping ────────────────────────────────────────────────

/** A region's paper bounds, mm, with one cell of margin on each side. */
export function regionBoundsMm(r: DiffRegion, bounds: Bounds, cellMm = DIFF_CELL_MM): Bounds {
  return {
    minX: bounds.minX + (r.minCol - 1) * cellMm,
    maxX: bounds.minX + (r.maxCol + 2) * cellMm,
    maxY: bounds.maxY - (r.minRow - 1) * cellMm,
    minY: bounds.maxY - (r.maxRow + 2) * cellMm,
  };
}

/** The camera a step to `r` sets: the region with its margin fitted into the pane, at most 16 CSS px/mm. */
export function stepViewport(r: DiffRegion, bounds: Bounds, paneW: number, paneH: number): PaperViewport {
  const vp = fitMm(regionBoundsMm(r, bounds), paneW, paneH, 0);
  return { ...vp, pxPerUm: Math.min(vp.pxPerUm, STEP_MAX_PX_PER_MM / 1000) };
}

/** The region a step goes to, wrapping: the first *next* goes to the first, the first *previous* to the last. */
export function stepIndex(current: number | null, count: number, dir: 1 | -1): number | null {
  if (count <= 0) return null;
  if (current === null) return dir === 1 ? 0 : count - 1;
  return (((current + dir) % count) + count) % count;
}
