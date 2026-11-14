/**
 * Staged sign decisions and slope propagation (docs/map-terrain.md §3.2).
 */

import type { ContourGraph } from "../graph/types.js";
import { CLASS, type EvidenceClass, type SideEvidence } from "./types.js";

export interface SignState {
  side: Int8Array;
  cls: Uint8Array;
  flagged: Uint8Array;
  root: Int32Array;
  corrected: Uint8Array;
  /** Chains with direct evidence both ways (counted once per stage). */
  evidenceConflicts: number;
}

export function signState(n: number): SignState {
  return { side: new Int8Array(n), cls: new Uint8Array(n), flagged: new Uint8Array(n), root: new Int32Array(n).fill(-1), corrected: new Uint8Array(n), evidenceConflicts: 0 };
}

/**
 * One stage: the signed weights of `lists` are summed per still-undecided
 * chain; the sign of the sum decides, the class is the strongest
 * contributor on the winning side.
 */
export function applyEvidence(s: SignState, lists: [EvidenceClass, readonly SideEvidence[]][]): number {
  const n = s.side.length;
  const sum = new Float64Array(n);
  const by: (Map<number, number> | undefined)[] = [];
  for (const [k, list] of lists) {
    const ci = CLASS[k];
    for (const e of list) {
      if (s.side[e.chain]) continue;
      sum[e.chain] += e.side * e.weight;
      const m = (by[e.chain] ??= new Map());
      m.set(ci * e.side, (m.get(ci * e.side) ?? 0) + e.weight);
    }
  }
  let decided = 0;
  for (let c = 0; c < n; c++) {
    const m = by[c];
    if (!m || Math.abs(sum[c]) < 1e-9) continue;
    const sg = sum[c] > 0 ? 1 : -1;
    let best = 0, bw = 0, against = 0;
    for (const [k, w] of m) {
      if (Math.sign(k) === sg) {
        if (w > bw || (w === bw && Math.abs(k) < best)) {
          bw = w;
          best = Math.abs(k);
        }
      } else against += w;
    }
    s.side[c] = sg;
    s.cls[c] = best;
    s.root[c] = c;
    s.flagged[c] = 0;
    if (against > 0) s.evidenceConflicts++;
    decided++;
  }
  return decided;
}

/** −1: chain c is a lower boundary of the region on side `bits` (the region is uphill of it); +1 an upper; 0 unknown. */
export const relation = (s: SignState, c: number, bits: number): number => (s.side[c] === 0 || bits === 3 ? 0 : (bits === 1) === s.side[c] > 0 ? -1 : 1);

/** Decides chain c so that it is a lower (−1) or upper (+1) boundary of the region on side `bits`. */
export function setRelation(s: SignState, c: number, bits: number, want: number, cls: number, root: number, flagged: number): boolean {
  if (s.side[c] !== 0 || bits === 3) return false;
  s.side[c] = (bits === 1) === (want === -1) ? 1 : -1;
  s.cls[c] = cls;
  s.root[c] = root;
  s.flagged[c] = flagged;
  return true;
}

export function chainRegions(g: ContourGraph): number[][] {
  return g.pairs.map((ps) => [...new Set(ps.flatMap((p) => [p.left, p.right]))]);
}

/**
 * Two-contour slope propagation: in a region bordered by exactly two
 * chains, one is its lower and the other its upper boundary. The new
 * decision inherits the root and the flag of the chain it came from.
 */
export function slopeFix(g: ContourGraph, s: SignState, regionsOf: number[][]): number {
  const queue: number[] = [];
  for (let r = g.raster.regionCount; r >= 1; r--) if (g.regionChains[r].size === 2) queue.push(r);
  let n = 0;
  while (queue.length) {
    const r = queue.pop()!;
    const inc = g.regionChains[r];
    if (inc.size !== 2) continue;
    const [[a, ab], [b, bb]] = [...inc];
    const ra = relation(s, a, ab), rb = relation(s, b, bb);
    let changed = -1;
    if (ra && !rb && setRelation(s, b, bb, -ra, CLASS.slope, s.root[a], s.flagged[a])) changed = b;
    else if (rb && !ra && setRelation(s, a, ab, -rb, CLASS.slope, s.root[b], s.flagged[b])) changed = a;
    if (changed >= 0) {
      n++;
      for (const rr of regionsOf[changed]) if (rr !== r) queue.push(rr);
    }
  }
  return n;
}
