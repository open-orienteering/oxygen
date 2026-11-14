/**
 * Heights inside the bands (docs/map-terrain.md §4.2–4.5): each region is
 * bounded below and above by its chains; a cell's height is interpolated
 * between them by geodesic distance inside the region.
 */

import { walkPolyline } from "../graph/flatten.js";
import { cellIndex } from "../graph/raster.js";
import { LABEL, type ContourGraph, type RegionRaster } from "../graph/types.js";
import type { TerrainSolution } from "../solve/types.js";

/** The solve's output that the surface reads (§3.7). */
export type FieldLevels = Pick<TerrainSolution, "regionLevel" | "regionWeak" | "side" | "flagged" | "conflict">;

export const SURFACE_RULES = {
  /** A top or pit rises (sinks) by half an interval over this ground distance from its contour, less in a smaller region. */
  domeGroundM: 20,
  /** Geodesic distance saturates here (half-cell units): unreachable. */
  far: 65535,
  /** A chain sample is good evidence for confidence when its conflict share is at most this. */
  maxConflict: 0.5,
} as const;

/** Growable list of cell indices. */
class CellList {
  a = new Int32Array(256);
  n = 0;
  push(v: number): void {
    if (this.n === this.a.length) {
      const b = new Int32Array(this.a.length * 2);
      b.set(this.a);
      this.a = b;
    }
    this.a[this.n++] = v;
  }
  done(): Int32Array {
    return this.a.slice(0, this.n);
  }
}

/** The first region cell beside (x, y) along (nx, ny), skipping `own`; −1 when a barrier or the outside comes first (§2.6's probe). */
function sideCell(r: RegionRaster, x: number, y: number, nx: number, ny: number, own: number): number {
  for (let k = 1; k <= 3; k += 0.5) {
    const c = cellIndex(r, x + nx * k * r.cellMm, y + ny * k * r.cellMm);
    if (c < 0) return -1;
    const v = r.labels[c];
    if (v === own) continue;
    return v > 0 ? c : -1;
  }
  return -1;
}

export interface BandSources {
  /** Cells where a region meets its lower bound (height = its floor). */
  low: Int32Array;
  /** Cells where a region meets its upper bound (height = its floor + 1). */
  up: Int32Array;
  /** Cells half an interval above the floor: form lines, and chains level on both sides. */
  form: Int32Array;
  /** Per region: LOW and UP seed samples, and those from a decided, unflagged, unleaky, unconflicted chain (§4.7). */
  boundSamples: Uint32Array;
  goodSamples: Uint32Array;
}

/** §4.2: seed cells per kind from the chains and form lines. */
export function bandSources(g: ContourGraph, lv: FieldLevels): BandSources {
  const r = g.raster, floor = lv.regionLevel;
  const low = new CellList(), up = new CellList(), form = new CellList();
  const boundSamples = new Uint32Array(r.regionCount + 1), goodSamples = new Uint32Array(r.regionCount + 1);
  g.chains.forEach((c, ci) => {
    const own = LABEL.chain0 - ci, leaky = g.leaky[ci] === 1;
    const good = lv.side[ci] !== 0 && !lv.flagged[ci] && !leaky && lv.conflict[ci] <= SURFACE_RULES.maxConflict;
    const seed = (cell: number, high: number) => {
      // high > 0: the cell is on the chain's high side, so the chain is its lower bound
      if (high === 0) {
        form.push(cell);
        return;
      }
      (high > 0 ? low : up).push(cell);
      const reg = r.labels[cell];
      boundSamples[reg]++;
      if (good) goodSamples[reg]++;
    };
    walkPolyline(c.pts, c.closed, r.cellMm, (x, y, tx, ty) => {
      const L = sideCell(r, x, y, -ty, tx, own), R = sideCell(r, x, y, ty, -tx, own);
      // > 0: left is the high side
      let d = L >= 0 && R >= 0 ? floor[r.labels[L]] - floor[r.labels[R]] : lv.side[ci];
      if (leaky) d = 0;
      if (L >= 0) seed(L, d);
      if (R >= 0) seed(R, -d);
    });
  });
  for (const c of g.formChains)
    walkPolyline(c.pts, c.closed, r.cellMm, (x, y) => {
      const cell = cellIndex(r, x, y);
      if (cell >= 0 && r.labels[cell] > 0) form.push(cell);
    });
  return { low: low.done(), up: up.done(), form: form.done(), boundSamples, goodSamples };
}

/**
 * §4.3: distance from the nearest seed, 8-connected inside the seed's
 * region, in half-cell units (orthogonal step 2, diagonal 3), saturating
 * at `SURFACE_RULES.far` (unreachable). Dial's buckets on typed arrays.
 */
export function geodesicDistance(r: RegionRaster, seeds: Int32Array): Uint16Array {
  const W = r.width, N = W * r.height, labels = r.labels, FAR = SURFACE_RULES.far;
  const dist = new Uint16Array(N).fill(FAR);
  const buckets = [new CellList(), new CellList(), new CellList(), new CellList()];
  let pending = 0;
  for (const s of seeds)
    if (dist[s] !== 0) {
      dist[s] = 0;
      buckets[0].push(s);
      pending++;
    }
  for (let d = 0; pending > 0 && d < FAR; d++) {
    const b = buckets[d & 3];
    const items = b.a, n = b.n;
    pending -= n;
    // steps are 2 and 3, so nothing is pushed onto bucket d & 3 while it is drained
    for (let k = 0; k < n; k++) {
      const i = items[k];
      if (dist[i] !== d) continue;
      const reg = labels[i], x = i % W;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nx = x + dx;
          if (nx < 0 || nx >= W) continue;
          const j = i + dy * W + dx;
          if (j < 0 || j >= N || labels[j] !== reg) continue;
          const nd = d + (dx !== 0 && dy !== 0 ? 3 : 2);
          if (nd < dist[j] && nd < FAR) {
            dist[j] = nd;
            buckets[nd & 3].push(j);
            pending++;
          }
        }
    }
    b.n = 0;
  }
  return dist;
}

/**
 * §4.4–4.5: calls `visit(cell, heightInIntervals, region)` for every region
 * cell in cell order.
 */
export function bandHeights(g: ContourGraph, lv: FieldLevels, src: BandSources, visit: (cell: number, h: number, region: number) => void): void {
  const r = g.raster, labels = r.labels, FAR = SURFACE_RULES.far, NR = r.regionCount + 1;
  const dLow = geodesicDistance(r, src.low), dUp = geodesicDistance(r, src.up), dForm = geodesicDistance(r, src.form);
  const maxLow = new Uint16Array(NR), maxUp = new Uint16Array(NR);
  for (let i = 0; i < labels.length; i++) {
    const reg = labels[i];
    if (reg <= 0) continue;
    if (dLow[i] !== FAR && dLow[i] > maxLow[reg]) maxLow[reg] = dLow[i];
    if (dUp[i] !== FAR && dUp[i] > maxUp[reg]) maxUp[reg] = dUp[i];
  }
  // half-cell units → ground metres
  const halfCellM = 0.5 * r.cellMm * g.inputs.groundMPerMm, dome = SURFACE_RULES.domeGroundM;
  for (let i = 0; i < labels.length; i++) {
    const reg = labels[i];
    if (reg <= 0) continue;
    const a = dLow[i], b = dUp[i], f = dForm[i];
    const wa = a === FAR ? 0 : 1 / (a + 1), wb = b === FAR ? 0 : 1 / (b + 1), wf = f === FAR ? 0 : 1 / (f + 1);
    let frac: number;
    const kinds = (wa > 0 ? 1 : 0) + (wb > 0 ? 1 : 0) + (wf > 0 ? 1 : 0);
    if (kinds >= 2 && wa + wb > 0) frac = (wb + 0.5 * wf) / (wa + wb + wf);
    else if (wa > 0) frac = 0.5 * Math.min(1, (maxLow[reg] * halfCellM) / dome) * (a / (maxLow[reg] || 1)); // a top
    else if (wb > 0) frac = 1 - 0.5 * Math.min(1, (maxUp[reg] * halfCellM) / dome) * (b / (maxUp[reg] || 1)); // a pit
    else frac = 0.5;
    visit(i, lv.regionLevel[reg] + frac, reg);
  }
}
