/**
 * Raster probes the solve needs beyond H1's incidence (docs/map-terrain.md
 * §3.3): which chain pairs run along a cliff, and which way a tagged cliff
 * between two regions points. The side probe repeats §2.6's.
 */

import { walkPolyline } from "../graph/flatten.js";
import { cellIndex } from "../graph/raster.js";
import { SegmentIndex } from "../graph/seg-index.js";
import { LABEL, type ContourGraph, type RegionRaster } from "../graph/types.js";

export const PROBE_RULES = {
  /** A pair is cliff-borne when at least this share of its samples lie within `cliffMm` of a cliff line. */
  cliffShare: 0.5,
  cliffMm: 0.5,
  /** A same-region side pair counts at this many samples and this share of the chain's (§2.6's pair rule). */
  leakSamples: 3,
  leakShare: 0.02,
} as const;

const PAIR_KEY = 4194304;

/** §2.6's side probe: the first region cell along the normal at 1 … 3 cells, skipping `own`. */
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

/** Per chain, per pair (in `graph.pairs` order): 1 when the pair runs along a cliff. */
export function cliffBornePairs(g: ContourGraph): Uint8Array[] {
  const r = g.raster;
  const out = g.pairs.map((ps) => new Uint8Array(ps.length));
  if (!g.inputs.cliffs.length) return out;
  const idx = new SegmentIndex(1);
  g.inputs.cliffs.forEach((c, i) => idx.addPolyline(c.pts, i));
  g.chains.forEach((c, ci) => {
    const ps = g.pairs[ci];
    if (!ps.length) return;
    const own = LABEL.chain0 - ci;
    const near = new Map<number, number>();
    walkPolyline(c.pts, c.closed, r.cellMm, (x, y, tx, ty) => {
      const L = sideCell(r, x, y, -ty, tx, own), R = sideCell(r, x, y, ty, -tx, own);
      if (L < 0 || R < 0) return;
      if (!idx.nearest(x, y, PROBE_RULES.cliffMm)) return;
      const k = r.labels[L] * PAIR_KEY + r.labels[R];
      near.set(k, (near.get(k) ?? 0) + 1);
    });
    ps.forEach((p, pi) => {
      if ((near.get(p.left * PAIR_KEY + p.right) ?? 0) >= PROBE_RULES.cliffShare * p.samples) out[ci][pi] = 1;
    });
  });
  return out;
}

export interface CliffLinkSides {
  /** Per `graph.cliffLinks` entry: samples seeing it. */
  samples: Uint32Array;
  /** Per entry: tagged samples saying the second region is above the first, minus those saying below. */
  secondAbove: Int32Array;
}

/** Samples and tag direction per cliff link (§3.5). */
export function cliffLinkSides(g: ContourGraph): CliffLinkSides {
  const r = g.raster;
  const n = g.cliffLinks.length;
  const at = new Map<number, number>();
  g.cliffLinks.forEach(([a, b], i) => at.set(a * PAIR_KEY + b, i));
  const samples = new Uint32Array(n), secondAbove = new Int32Array(n);
  for (const c of g.inputs.cliffs) {
    walkPolyline(c.pts, false, r.cellMm, (x, y, tx, ty) => {
      const L = sideCell(r, x, y, -ty, tx, LABEL.cliff), R = sideCell(r, x, y, ty, -tx, LABEL.cliff);
      if (L < 0 || R < 0) return;
      const l = r.labels[L], rr = r.labels[R];
      if (l === rr) return;
      const i = at.get(Math.min(l, rr) * PAIR_KEY + Math.max(l, rr));
      if (i === undefined) return;
      samples[i]++;
      if (!c.tagSide) return;
      // tags point downhill: the tag side is below
      const down = c.tagSide > 0 ? l : rr;
      secondAbove[i] += down === Math.min(l, rr) ? 1 : -1;
    });
  }
  return { samples, secondAbove };
}

/**
 * Regions that span two levels: a band that runs around a chain (§2.6's
 * same-region pairs) joins the bands on both of its sides. A region is
 * marked when one chain sees it on both sides at `max(3, 2 %)` of its
 * samples or more (the pair rule of §2.6), leaky chains and partial leaks
 * alike.
 */
export function leakyRegions(g: ContourGraph): Uint8Array {
  const r = g.raster;
  const out = new Uint8Array(r.regionCount + 1);
  g.chains.forEach((c, ci) => {
    const own = LABEL.chain0 - ci;
    const self = new Map<number, number>();
    let n = 0;
    walkPolyline(c.pts, c.closed, r.cellMm, (x, y, tx, ty) => {
      n++;
      const L = sideCell(r, x, y, -ty, tx, own), R = sideCell(r, x, y, ty, -tx, own);
      if (L < 0 || R < 0 || r.labels[L] !== r.labels[R]) return;
      self.set(r.labels[L], (self.get(r.labels[L]) ?? 0) + 1);
    });
    const min = Math.max(PROBE_RULES.leakSamples, PROBE_RULES.leakShare * n);
    for (const [lab, m] of self) if (m >= min) out[lab] = 1;
  });
  return out;
}
