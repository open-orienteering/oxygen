/**
 * Area pattern grids (03 §6.9 item 4): instance positions for a pattern
 * symbol over an area, and the inclusion decision per clip mode.
 *
 * The grid is anchored at the paper origin (OCAD convention) rotated by
 * the pattern angle, so adjacent areas with the same symbol and angle
 * share one grid and hatch/dot continuously. Shifted rows move every odd
 * row by half a cell.
 */

import type { RenderPath } from "./pass-stream.js";
import { flattenRings } from "./geometry.js";
import type { PatternSpec } from "./symbol.js";

export interface PatternInstance {
  x: number;
  y: number;
  angleDeg: number;
}

export interface PatternGridOptions {
  /** Object rotation (OCAD `ang`), degrees; applied when `rotate` allows. */
  objectAngleDeg?: number;
  /** Glyph extent in glyph-local µm (ink included) for the inclusion tests. */
  extent: { minX: number; minY: number; maxX: number; maxY: number };
  /** Flattening tolerance for the inclusion polygon, µm. */
  toleranceUm?: number;
}

export function patternAngle(spec: PatternSpec, objectAngleDeg = 0): number {
  switch (spec.rotate) {
    case "never":
      return spec.angleDeg;
    case "always":
    case "manual":
      return spec.angleDeg + objectAngleDeg;
  }
}

/**
 * Returns the instances to draw for one area and whether the pass needs a
 * clip path (`clip` mode).
 *
 * Inclusion is decided by a scanline over the grid rows rather than a
 * point-in-polygon test per cell: the rings are rotated into grid space
 * once, each row intersects the edges to get its inside spans, and the
 * edges crossing a row's glyph band are projected onto the cells they
 * touch. The three predicates every mode is built from — centre inside,
 * glyph-box corner inside, edge crossing the glyph box — come out exactly
 * as before, in O(rows × edges + boundary cells) instead of
 * O(cells × edges). (S1 step 4: 213 on the Sprint map went from 82 ms to
 * a few ms.)
 */
export function patternInstances(
  area: RenderPath,
  spec: PatternSpec,
  opts: PatternGridOptions,
): { instances: PatternInstance[]; clip: boolean } {
  const angle = patternAngle(spec, opts.objectAngleDeg);
  const rad = (angle * Math.PI) / 180;
  const c = Math.cos(rad), s = Math.sin(rad);
  const ex = opts.extent;

  // Rings in grid space (rotate by −angle); grid rows are horizontal there.
  const rings = flattenRings(area, opts.toleranceUm ?? 5).map((r) => {
    const g = new Array<number>(r.length);
    for (let i = 0; i < r.length; i += 2) {
      const x = r[i], y = r[i + 1];
      g[i] = x * c + y * s;
      g[i + 1] = -x * s + y * c;
    }
    return g;
  });
  let gMinX = Infinity, gMaxX = -Infinity, gMinY = Infinity, gMaxY = -Infinity;
  for (const r of rings) {
    for (let i = 0; i < r.length; i += 2) {
      if (r[i] < gMinX) gMinX = r[i];
      if (r[i] > gMaxX) gMaxX = r[i];
      if (r[i + 1] < gMinY) gMinY = r[i + 1];
      if (r[i + 1] > gMaxY) gMaxY = r[i + 1];
    }
  }
  if (!(gMinX <= gMaxX)) return { instances: [], clip: spec.clip === "clip" };
  const pad = Math.max(Math.abs(ex.minX), Math.abs(ex.maxX), Math.abs(ex.minY), Math.abs(ex.maxY));
  gMinX -= pad; gMaxX += pad; gMinY -= pad; gMaxY += pad;

  const W = spec.cellWidthUm, H = spec.cellHeightUm;
  const j0 = Math.floor((gMinY - spec.offsetYUm) / H), j1 = Math.ceil((gMaxY - spec.offsetYUm) / H);
  const instances: PatternInstance[] = [];
  const mode = spec.clip;
  const needCorners = mode !== "centreInside";

  for (let j = j0; j <= j1; j++) {
    const gy = spec.offsetYUm + j * H;
    const shift = spec.shiftedRows && ((j % 2) + 2) % 2 === 1 ? W / 2 : 0;
    const ox = spec.offsetXUm + shift;
    const i0 = Math.floor((gMinX - ox) / W), i1 = Math.ceil((gMaxX - ox) / W);
    const mid = spansAt(rings, gy);
    if (!needCorners) {
      for (let i = i0; i <= i1; i++) if (inSpans(mid, ox + i * W)) instances.push(place(ox + i * W, gy));
      continue;
    }
    const lo = spansAt(rings, gy + ex.minY);
    const hi = spansAt(rings, gy + ex.maxY);
    // Cells whose glyph box is crossed by an edge inside this row's band.
    const crossed = new Uint8Array(i1 - i0 + 1);
    markCrossed(rings, gy + ex.minY, gy + ex.maxY, ex.minX, ex.maxX, ox, W, i0, i1, crossed);
    for (let i = i0; i <= i1; i++) {
      const gx = ox + i * W;
      const centre = inSpans(mid, gx);
      const corners =
        (inSpans(lo, gx + ex.minX) ? 1 : 0) + (inSpans(lo, gx + ex.maxX) ? 1 : 0) +
        (inSpans(hi, gx + ex.minX) ? 1 : 0) + (inSpans(hi, gx + ex.maxX) ? 1 : 0);
      const cross = crossed[i - i0] === 1;
      let ok: boolean;
      switch (mode) {
        case "completelyInside":
          ok = centre && corners === 4 && !cross;
          break;
        case "partiallyInside":
        case "clip":
          ok = centre || corners > 0 || cross;
          break;
        default:
          ok = centre;
      }
      if (ok) instances.push(place(gx, gy));
    }
  }
  return { instances, clip: mode === "clip" };

  function place(gx: number, gy: number): PatternInstance {
    return { x: gx * c - gy * s, y: gx * s + gy * c, angleDeg: angle };
  }
}

/** Sorted x of the ring edges crossing the horizontal line at `y` (half-open rule, as `pointInRings`). */
function spansAt(rings: number[][], y: number): number[] {
  const xs: number[] = [];
  for (const r of rings) {
    const n = r.length / 2;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const xi = r[2 * i], yi = r[2 * i + 1], xj = r[2 * j], yj = r[2 * j + 1];
      if (yi > y !== yj > y) xs.push(((xj - xi) * (y - yi)) / (yj - yi) + xi);
    }
  }
  return xs.sort((a, b) => a - b);
}

/** Even-odd membership of `x` in sorted crossings (`x` strictly left of an odd number of crossings). */
function inSpans(xs: number[], x: number): boolean {
  let n = 0;
  for (let k = xs.length - 1; k >= 0 && x < xs[k]; k--) n++;
  return (n & 1) === 1;
}

/**
 * Marks cells whose axis-aligned glyph box `[gx+bx0, gx+bx1] × [y0, y1]`
 * is crossed by a ring edge: the edge is clipped to the band and its
 * x-range projected onto the cells it can touch, then each candidate
 * cell is checked with an exact segment–box test.
 */
function markCrossed(
  rings: number[][], y0: number, y1: number, bx0: number, bx1: number,
  ox: number, W: number, i0: number, i1: number, out: Uint8Array,
): void {
  for (const r of rings) {
    const n = r.length / 2;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const ax = r[2 * j], ay = r[2 * j + 1], bx = r[2 * i], by = r[2 * i + 1];
      if (Math.max(ay, by) < y0 || Math.min(ay, by) > y1) continue;
      const lo = Math.min(ax, bx), hi = Math.max(ax, bx);
      const kLo = Math.max(i0, Math.ceil((lo - bx1 - ox) / W));
      const kHi = Math.min(i1, Math.floor((hi - bx0 - ox) / W));
      for (let k = kLo; k <= kHi; k++) {
        if (out[k - i0]) continue;
        const gx = ox + k * W;
        if (segmentCrossesBox(ax, ay, bx, by, gx + bx0, y0, gx + bx1, y1)) out[k - i0] = 1;
      }
    }
  }
}

/** Segment–box intersection (Liang–Barsky), open box: touching the border counts as crossing only when the segment enters. */
function segmentCrossesBox(ax: number, ay: number, bx: number, by: number, x0: number, y0: number, x1: number, y1: number): boolean {
  const dx = bx - ax, dy = by - ay;
  let t0 = 0, t1 = 1;
  const clip = (p: number, q: number): boolean => {
    if (p === 0) return q > 0;
    const t = q / p;
    if (p < 0) { if (t > t1) return false; if (t > t0) t0 = t; }
    else { if (t < t0) return false; if (t < t1) t1 = t; }
    return true;
  };
  if (!clip(-dx, ax - x0) || !clip(dx, x1 - ax) || !clip(-dy, ay - y0) || !clip(dy, y1 - ay)) return false;
  return t1 > t0;
}
