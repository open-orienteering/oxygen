/**
 * Chain ↔ region incidence, leaky chains, cliff links (docs/map-terrain.md §2.6).
 */

import { walkPolyline } from "./flatten.js";
import { cellIndex } from "./raster.js";
import { LABEL, type Chain, type CliffLine, type RegionRaster, type SidePair } from "./types.js";

/** A pair counts when it holds at least this many samples, and at least `PAIR_MIN_SHARE` of them. */
const PAIR_MIN_SAMPLES = 3;
const PAIR_MIN_SHARE = 0.02;
/** A chain is leaky when same-region pairs make up this share of the counted samples or more. */
const LEAKY_SHARE = 0.5;
/** (left, right) packed as left · 2²² + right: exact while regions stay below 2²² (the corpus peaks near 10⁴; the 60 M cell budget keeps it far off). */
const PAIR_KEY = 4194304;

/** The first region cell beside (x, y) along (nx, ny), skipping `own`; −1 when a barrier or the outside comes first. */
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

export interface Incidence {
  pairs: SidePair[][];
  leaky: Uint8Array;
  regionChains: Map<number, number>[];
}

/** Per chain its (left, right) region pairs and the leaky flag; per region its chains and sides. */
export function chainIncidence(chains: readonly Chain[], r: RegionRaster): Incidence {
  if (r.regionCount >= PAIR_KEY) throw new RangeError(`chainIncidence: ${r.regionCount} regions exceed the pair key`);
  const pairs: SidePair[][] = [];
  const leaky = new Uint8Array(chains.length);
  chains.forEach((c, ci) => {
    const own = LABEL.chain0 - ci;
    const seen = new Map<number, number>();
    let samples = 0;
    walkPolyline(c.pts, c.closed, r.cellMm, (x, y, tx, ty) => {
      samples++;
      const L = sideCell(r, x, y, -ty, tx, own), R = sideCell(r, x, y, ty, -tx, own);
      if (L < 0 || R < 0) return;
      const k = r.labels[L] * PAIR_KEY + r.labels[R];
      seen.set(k, (seen.get(k) ?? 0) + 1);
    });
    const min = Math.max(PAIR_MIN_SAMPLES, PAIR_MIN_SHARE * samples);
    let list: SidePair[] = [];
    for (const [k, n] of seen) if (n >= min) list.push({ left: Math.floor(k / PAIR_KEY), right: k % PAIR_KEY, samples: n });
    const self = list.filter((p) => p.left === p.right).reduce((a, p) => a + p.samples, 0);
    const all = list.reduce((a, p) => a + p.samples, 0);
    if (all === 0 || self >= LEAKY_SHARE * all) {
      leaky[ci] = 1;
      list = [];
    } else list = list.filter((p) => p.left !== p.right);
    pairs.push(list);
  });
  const regionChains: Map<number, number>[] = Array.from({ length: r.regionCount + 1 }, () => new Map());
  pairs.forEach((list, ci) => {
    for (const p of list) {
      regionChains[p.left].set(ci, (regionChains[p.left].get(ci) ?? 0) | 1);
      regionChains[p.right].set(ci, (regionChains[p.right].get(ci) ?? 0) | 2);
    }
  });
  return { pairs, leaky, regionChains };
}

/** Pairs of different regions facing each other across a cliff, lower id first, in order of first sighting. */
export function cliffLinks(cliffs: readonly CliffLine[], r: RegionRaster): [number, number][] {
  const out = new Map<number, [number, number]>();
  for (const c of cliffs) {
    walkPolyline(c.pts, false, r.cellMm, (x, y, tx, ty) => {
      const L = sideCell(r, x, y, -ty, tx, LABEL.cliff), R = sideCell(r, x, y, ty, -tx, LABEL.cliff);
      if (L < 0 || R < 0) return;
      const a = Math.min(r.labels[L], r.labels[R]), b = Math.max(r.labels[L], r.labels[R]);
      if (a !== b && !out.has(a * PAIR_KEY + b)) out.set(a * PAIR_KEY + b, [a, b]);
    });
  }
  return [...out.values()];
}

/** Connected components of the region graph over chain incidence (regions with no chain are not counted). */
export function regionComponents(pairs: readonly SidePair[][], regionChains: readonly Map<number, number>[]): number {
  const chainRegions = pairs.map((list) => [...new Set(list.flatMap((p) => [p.left, p.right]))]);
  const seen = new Uint8Array(regionChains.length);
  let n = 0;
  for (let r = 1; r < regionChains.length; r++) {
    if (seen[r] || !regionChains[r].size) continue;
    n++;
    const q = [r];
    seen[r] = 1;
    while (q.length) {
      const a = q.pop()!;
      for (const [c] of regionChains[a]) {
        for (const b of chainRegions[c]) {
          if (!seen[b]) {
            seen[b] = 1;
            q.push(b);
          }
        }
      }
    }
  }
  return n;
}
