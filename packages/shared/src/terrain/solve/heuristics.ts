/**
 * Flagged heuristics (docs/map-terrain.md §3.4): closure, the band rules
 * and the closed-hill default. Every decision here is flagged and is its
 * own root.
 */

import type { ContourGraph } from "../graph/types.js";
import { chainArea } from "./evidence.js";
import type { Forest } from "./levels.js";
import { relation, setRelation, type SignState } from "./sign.js";
import { CLASS } from "./types.js";

/** Cycle closure: both sides of an undecided chain already levelled in one component; it takes the sign of the difference. */
export function closureRule(g: ContourGraph, s: SignState, f: Forest): number {
  let n = 0;
  g.pairs.forEach((ps, c) => {
    if (s.side[c] || !ps.length) return;
    const p = ps.reduce((a, b) => (b.samples > a.samples ? b : a));
    if (f.regionComponent[p.left] !== f.regionComponent[p.right]) return;
    const d = f.regionLevel[p.left] - f.regionLevel[p.right];
    if (d === 0) return;
    s.side[c] = d > 0 ? 1 : -1;
    s.cls[c] = CLASS.closure;
    s.root[c] = c;
    s.flagged[c] = 1;
    n++;
  });
  return n;
}

/**
 * Band rules on regions bordered by three chains or more. Drain: the one
 * unknown chain of a closed region whose known chains are all upper
 * boundaries is its lower boundary (the band drains through it). Upper: in
 * a region with a known lower boundary, the unknown chains are upper
 * boundaries.
 */
export function bandRule(g: ContourGraph, s: SignState, kind: "bandDrain" | "bandUpper"): number {
  let n = 0;
  for (let r = 1; r <= g.raster.regionCount; r++) {
    const inc = g.regionChains[r];
    if (inc.size < 3) continue;
    let lows = 0, known = 0;
    const unknown: [number, number][] = [];
    for (const [c, bits] of inc) {
      const q = relation(s, c, bits);
      if (q) {
        known++;
        if (q < 0) lows++;
      } else if (bits !== 3) unknown.push([c, bits]);
    }
    if (!unknown.length) continue;
    if (kind === "bandDrain" && unknown.length === 1 && known >= 2 && lows === 0 && !g.raster.regionTouchesOutside[r]) {
      const [c, bits] = unknown[0];
      if (setRelation(s, c, bits, -1, CLASS.bandDrain, c, 1)) n++;
    }
    if (kind === "bandUpper" && lows > 0) for (const [c, bits] of unknown) if (setRelation(s, c, bits, 1, CLASS.bandUpper, c, 1)) n++;
  }
  return n;
}

/** The last default: an undecided closed, non-leaky chain is a hill. */
export function closedHillRule(g: ContourGraph, s: SignState): number {
  let n = 0;
  g.chains.forEach((c, ci) => {
    if (s.side[ci] || !c.closed || g.leaky[ci]) return;
    s.side[ci] = chainArea(c.pts) > 0 ? 1 : -1;
    s.cls[ci] = CLASS.closedHill;
    s.root[ci] = ci;
    s.flagged[ci] = 1;
    n++;
  });
  return n;
}
