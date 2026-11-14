/**
 * `anchoredHeights`: after §3's solve, a height for every chain with a
 * level — the DEM's where it anchored the chain, else its anchored
 * neighbours' with §3's step (docs/map-terrain.md §6.8).
 */

import type { ContourGraph } from "../graph/types.js";
import { weightedQuantile } from "./anchor.js";
import { ANCHOR_RULES, ANCHOR_STATUS, HEIGHT_SOURCE, NO_LEVEL, type AnchoredHeights, type DemAnchor, type SolvedLevels } from "./types.js";

/** The chains sharing a region with chain `i` (its band neighbours), ascending. */
function bandNeighbours(g: ContourGraph, i: number): number[] {
  const out = new Set<number>();
  for (const p of g.pairs[i]) {
    for (const r of [p.left, p.right]) {
      const m = g.regionChains[r];
      if (!m) continue;
      for (const j of m.keys()) if (j !== i) out.add(j);
    }
  }
  return [...out].sort((a, b) => a - b);
}

export function anchoredHeights(graph: ContourGraph, anchor: DemAnchor, solved: SolvedLevels): AnchoredHeights {
  const I = anchor.intervalM;
  const n = graph.chains.length;
  const c = anchor.chains;
  const len = graph.chains.map((ch) => ch.lengthMm);
  const coarse = !anchor.levelsAllowed;

  const comp = new Int32Array(n).fill(-1);
  for (let i = 0; i < n; i++) {
    const p = graph.pairs[i];
    // §3 left the chain undecided (no side, step 0) or gave it no level: no component (§6.8).
    if (!p.length || solved.chainLevel[i] === NO_LEVEL || solved.side[i] === 0 || solved.chainStep[i] === 0) continue;
    const r = solved.regionComponent[p[0].left];
    if (r > 0) comp[i] = r;
  }
  const L = solved.chainLevel;
  const coarseTight = (i: number) => c.status[i] !== ANCHOR_STATUS.uncovered && c.halfIqr[i] <= ANCHOR_RULES.contributorHalfIqr.coarse * I;
  const accepted = (i: number) => (c.status[i] === ANCHOR_STATUS.unsnapped || c.status[i] === ANCHOR_STATUS.snapped) && Number.isFinite(c.height[i]);

  // Component offsets: the length-weighted median of h − I·L.
  const byComp = new Map<number, { v: number[]; w: number[] }>();
  for (let i = 0; i < n; i++) {
    if (comp[i] < 0) continue;
    let h: number;
    if (coarse) {
      if (!coarseTight(i)) continue;
      h = c.median[i];
    } else {
      if (!accepted(i)) continue;
      h = c.height[i];
    }
    let e = byComp.get(comp[i]);
    if (!e) byComp.set(comp[i], (e = { v: [], w: [] }));
    e.v.push(h - I * L[i]);
    e.w.push(len[i]);
  }
  const componentOffset = new Map<number, number>();
  for (const [k, e] of [...byComp].sort((a, b) => a[0] - b[0])) componentOffset.set(k, weightedQuantile(e.v, e.w, 0.5));

  const height = new Float64Array(n).fill(NaN);
  const source = new Uint8Array(n);
  const bounded = new Uint8Array(n);
  let driftShifted = 0;

  for (let i = 0; i < n; i++) {
    if (!coarse && accepted(i)) {
      height[i] = c.height[i];
      source[i] = HEIGHT_SOURCE.dem;
      continue;
    }
    if (comp[i] < 0) continue;
    const off = componentOffset.get(comp[i]);
    if (coarse) {
      if (off === undefined) continue;
      let h = off + I * L[i];
      const r = c.median[i] - h;
      if (c.status[i] !== ANCHOR_STATUS.uncovered && Math.abs(r) > ANCHOR_RULES.driftBound * I) {
        h += I * Math.round(r / I);
        driftShifted += len[i];
      }
      height[i] = h;
      source[i] = HEIGHT_SOURCE.component;
      continue;
    }
    // Breadth-first over bands to the first depth holding accepted chains of the same component.
    const seen = new Set<number>([i]);
    let frontier = [i];
    let found: number[] = [];
    for (let depth = 1; depth <= ANCHOR_RULES.neighbourDepth && !found.length && frontier.length; depth++) {
      const next: number[] = [];
      for (const f of frontier) {
        for (const j of bandNeighbours(graph, f)) {
          if (seen.has(j)) continue;
          seen.add(j);
          next.push(j);
        }
      }
      next.sort((a, b) => a - b);
      found = next.filter((j) => accepted(j) && comp[j] === comp[i]);
      frontier = next;
    }
    if (found.length) {
      const cand = found.map((j) => c.height[j] + I * (L[i] - L[j]));
      let h = weightedQuantile(cand, found.map((j) => len[j]), 0.5);
      let lo = -Infinity, hi = Infinity;
      for (const j of found) {
        if (L[j] < L[i]) lo = Math.max(lo, c.height[j]);
        if (L[j] > L[i]) hi = Math.min(hi, c.height[j]);
      }
      let b = Math.max(...cand) - Math.min(...cand) > ANCHOR_RULES.boundedSpread * I;
      if (lo > hi) b = true;
      else if (h < lo || h > hi) {
        h = Math.min(hi, Math.max(lo, h));
        b = true;
      }
      height[i] = h;
      source[i] = HEIGHT_SOURCE.neighbours;
      bounded[i] = b ? 1 : 0;
    } else if (off !== undefined) {
      height[i] = off + I * L[i];
      source[i] = HEIGHT_SOURCE.component;
    }
  }

  // Report: shares by source, bounded, drift of §3's levels against the DEM.
  let total = 0;
  const share = { dem: 0, neighbours: 0, component: 0, none: 0 };
  let boundedLen = 0;
  const driftLen = new Map<number, number>();
  let driftTotal = 0;
  for (let i = 0; i < n; i++) {
    total += len[i];
    const s = source[i];
    if (s === HEIGHT_SOURCE.dem) share.dem += len[i];
    else if (s === HEIGHT_SOURCE.neighbours) share.neighbours += len[i];
    else if (s === HEIGHT_SOURCE.component) share.component += len[i];
    else share.none += len[i];
    if (bounded[i]) boundedLen += len[i];
    const off = comp[i] >= 0 ? componentOffset.get(comp[i]) : undefined;
    if (off === undefined) continue;
    const h = coarse ? (coarseTight(i) ? c.median[i] : NaN) : accepted(i) ? c.height[i] : NaN;
    if (!Number.isFinite(h)) continue;
    const k = Math.round((h - off - I * L[i]) / I) + 0;
    driftLen.set(k, (driftLen.get(k) ?? 0) + len[i]);
    driftTotal += len[i];
  }
  const frac = (v: number) => (total > 0 ? v / total : 0);
  const drift: Record<string, number> = {};
  for (const [k, v] of [...driftLen].sort((a, b) => a[0] - b[0])) drift[String(k)] = v / driftTotal;
  return {
    height,
    source,
    bounded,
    componentOffset,
    coarse,
    report: {
      share: { dem: frac(share.dem), neighbours: frac(share.neighbours), component: frac(share.component), none: frac(share.none) },
      bounded: frac(boundedLen),
      driftShifted: frac(driftShifted),
      drift,
    },
  };
}
