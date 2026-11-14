/**
 * Index contours set steps and correct signs (docs/map-terrain.md §3.5).
 *
 * Every index contour is compared with its nearest index-contour
 * neighbours in the band graph: their levels should differ by a multiple
 * of five. A pair whose tree path crosses a suspect edge (a flagged group,
 * a weak pair, a cliff link, an undecided chain) votes for the
 * shift of the far side that would put the two on one residue. An edge
 * whose votes agree (≥ 80 %) takes the step they ask for; a flagged group
 * whose votes ask for a shift is flipped on trial and kept when the index
 * consistency rises without new conflicts.
 */

import type { ContourGraph } from "../graph/types.js";
import { buildForest, keyChain, keyLink, SUSPECT_TIER, TIER, type Forest, type ForestInput } from "./levels.js";
import type { SignState } from "./sign.js";
import { CLASS, NO_LEVEL } from "./types.js";

export const INDEX_RULES = {
  /** Neighbours per index chain, nearest first by bands crossed. */
  neighbours: 4,
  /** Breadth-first rings searched beyond the chain's own regions (ring 0). */
  maxBands: 12,
  /** Share of the vote weight the modal shift needs. */
  mode: 0.8,
} as const;

const mod5 = (v: number) => ((v % 5) + 5) % 5;

export interface IndexPair {
  i: number;
  j: number;
  /** min(length i, length j), mm. */
  w: number;
}

/** The index-chain neighbour pairs (§3.5): up to K nearest per index chain within D bands, ties by chain. */
export function indexNeighbours(g: ContourGraph, regionsOf: number[][], k: number = INDEX_RULES.neighbours): IndexPair[] {
  const NR = g.raster.regionCount + 1;
  const linkAdj: number[][] = Array.from({ length: NR }, () => []);
  for (const [a, b] of g.cliffLinks) {
    linkAdj[a].push(b);
    linkAdj[b].push(a);
  }
  const isIndex = g.chains.map((c, i) => c.index && g.pairs[i].length > 0);
  const seen = new Int32Array(NR).fill(-1);
  const pairs = new Map<number, IndexPair>();
  const NC = g.chains.length;
  g.chains.forEach((_, i) => {
    if (!isIndex[i]) return;
    const found = new Map<number, number>();
    let frontier = regionsOf[i].slice();
    for (const r of frontier) seen[r] = i;
    for (let d = 0; d <= INDEX_RULES.maxBands && frontier.length; d++) {
      const next: number[] = [];
      for (const r of frontier) {
        for (const [c] of g.regionChains[r]) {
          if (c !== i && isIndex[c] && !found.has(c)) found.set(c, d);
          for (const q of regionsOf[c]) if (seen[q] !== i) { seen[q] = i; next.push(q); }
        }
        for (const q of linkAdj[r]) if (seen[q] !== i) { seen[q] = i; next.push(q); }
      }
      if (found.size >= k) break;
      frontier = next;
    }
    const near = [...found.entries()].sort((a, b) => a[1] - b[1] || a[0] - b[0]).slice(0, k);
    for (const [j] of near) {
      const a = Math.min(i, j), b = Math.max(i, j), k = a * NC + b;
      if (!pairs.has(k)) pairs.set(k, { i: a, j: b, w: Math.min(g.chains[a].lengthMm, g.chains[b].lengthMm) });
    }
  });
  return [...pairs.values()].sort((x, y) => x.i - y.i || x.j - y.j);
}

/** Weight share of neighbour pairs (both levelled, one connected set) on one residue; null without pairs. */
export function indexConsistency(g: ContourGraph, f: Forest, pairs: readonly IndexPair[], filter?: (c: number) => boolean): { on: number; total: number; value: number | null } {
  let on = 0, total = 0;
  for (const p of pairs) {
    if (filter && !filter(p.i)) continue;
    const li = f.chainLevel[p.i], lj = f.chainLevel[p.j];
    if (li === NO_LEVEL || lj === NO_LEVEL) continue;
    if (f.regionSet[mainRegion(g, f, p.i)] !== f.regionSet[mainRegion(g, f, p.j)]) continue;
    total += p.w;
    if (mod5(li - lj) === 0) on += p.w;
  }
  return { on, total, value: total ? on / total : null };
}

/** The region whose floor is the chain's level (its strongest pair's higher side). */
function mainRegion(g: ContourGraph, f: Forest, c: number): number {
  const p = g.pairs[c].reduce((a, b) => (b.samples > a.samples ? b : a));
  return f.regionLevel[p.left] >= f.regionLevel[p.right] ? p.left : p.right;
}

export interface RepairCounts {
  stepsSet: number;
  flippedGroups: number;
  flippedLengthMm: number;
  confirmedGroups: number;
  decidedChains: number;
  unresolved: number;
}

export const repairCounts = (): RepairCounts => ({ stepsSet: 0, flippedGroups: 0, flippedLengthMm: 0, confirmedGroups: 0, decidedChains: 0, unresolved: 0 });

interface Vote {
  bins: Float64Array;
  pairs: number[];
}

/** Votes per suspect tree edge: the shift of the edge's child side (mod 5) that would put each straddling pair on one residue. */
function collectVotes(g: ContourGraph, f: Forest, pairs: readonly IndexPair[]): Map<number, Vote> {
  const votes = new Map<number, Vote>();
  const vote = (edge: number, delta: number, w: number, pi: number) => {
    if (f.tree[edge].tier < SUSPECT_TIER) return;
    let v = votes.get(edge);
    if (!v) votes.set(edge, (v = { bins: new Float64Array(5), pairs: [] }));
    v.bins[mod5(delta)] += w;
    v.pairs.push(pi);
  };
  pairs.forEach((p, pi) => {
    const li = f.chainLevel[p.i], lj = f.chainLevel[p.j];
    if (li === NO_LEVEL || lj === NO_LEVEL) return;
    let x = mainRegion(g, f, p.i), y = mainRegion(g, f, p.j);
    if (f.regionSet[x] !== f.regionSet[y]) return;
    while (x !== y) {
      if (f.depth[x] >= f.depth[y]) {
        vote(f.parentEdge[x], lj - li, p.w, pi);
        x = f.parentRegion[x];
      } else {
        vote(f.parentEdge[y], li - lj, p.w, pi);
        y = f.parentRegion[y];
      }
    }
  });
  return votes;
}

/** Steps a cliff link may take: towards the untagged side when tagged, else −2 … 2 (level(second) − level(first)). */
function linkSteps(secondAbove: number): number[] {
  if (secondAbove > 0) return [0, 1, 2, 3, 4];
  if (secondAbove < 0) return [0, -1, -2, -3, -4];
  return [0, 1, -1, 2, -2];
}

export interface RepairContext {
  g: ContourGraph;
  s: SignState;
  input: ForestInput;
  pairs: IndexPair[];
  linkSecondAbove: Int32Array;
  groups: () => Map<number, number[]>;
  counts: RepairCounts;
}

interface Score {
  on: number;
  conflict: number;
}

const score = (ctx: RepairContext): Score => {
  const f = buildForest(ctx.g, ctx.input);
  return { on: indexConsistency(ctx.g, f, ctx.pairs).on, conflict: f.conflictLengthMm };
};

/** A change is kept when the index consistency rises (or, for a confirmation, holds) and no conflict length is added. */
const better = (a: Score, b: Score, strict: boolean) => (strict ? a.on > b.on + 1e-9 : a.on >= b.on - 1e-9) && a.conflict <= b.conflict + 1e-9;

/**
 * One repair pass (§3.5). Votes are collected on the forest as it stands;
 * every suspect tree edge whose votes agree (≥ 80 %) proposes one change —
 * a step on a cliff-borne pair or a cliff link, a sign for an undecided
 * chain, a flip or a confirmation of a flagged group — and each proposal is
 * tried on its own: kept when it raises the index consistency without
 * adding conflict length, else undone. Returns the number of kept changes.
 */
export function repairPass(ctx: RepairContext, allowFlips: boolean): number {
  const { g, s, input, pairs, counts } = ctx;
  const f = buildForest(g, input);
  const votes = collectVotes(g, f, pairs);
  const proposals: { tier: number; key: number; want: number; confirm: boolean; chain: number; root: number }[] = [];
  const seenRoot = new Set<number>();
  for (const q of f.order) {
    const ei = f.parentEdge[q];
    if (ei < 0) continue;
    const v = votes.get(ei);
    if (!v) continue;
    const e = f.tree[ei];
    let total = 0, best = 0;
    for (let k = 0; k < 5; k++) {
      total += v.bins[k];
      if (v.bins[k] > v.bins[best]) best = k;
    }
    if (v.bins[best] < INDEX_RULES.mode * total) {
      counts.unresolved++;
      continue;
    }
    const c = keyChain(e.key);
    if (e.tier === TIER.flagged) {
      const root = s.root[c];
      if (seenRoot.has(root)) continue;
      seenRoot.add(root);
      if (best === 0 || allowFlips) proposals.push({ tier: e.tier, key: e.key, want: 0, confirm: best === 0, chain: c, root });
      continue;
    }
    if (best === 0) continue;
    // the shift of the child side q asks for this change of e.d
    proposals.push({ tier: e.tier, key: e.key, want: mod5(q === e.a ? best : -best), confirm: false, chain: c, root: -1 });
  }
  let cur = score(ctx), kept = 0;
  for (const p of proposals) {
    const e = f.tree.find((t) => t.key === p.key)!;
    let undo: () => void;
    if (p.tier === TIER.flagged) {
      const members = ctx.groups().get(p.root) ?? [];
      if (!members.length) continue;
      if (p.confirm) {
        for (const m of members) s.flagged[m] = 0;
        undo = () => { for (const m of members) s.flagged[m] = 1; };
      } else {
        for (const m of members) s.side[m] = -s.side[m] as -1 | 1;
        undo = () => { for (const m of members) s.side[m] = -s.side[m] as -1 | 1; };
      }
      const next = score(ctx);
      if (!better(next, cur, !p.confirm)) {
        undo();
        counts.unresolved++;
        continue;
      }
      cur = next;
      kept++;
      if (p.confirm) counts.confirmedGroups++;
      else {
        s.cls[p.root] = CLASS.index;
        for (const m of members) {
          s.corrected[m] ^= 1;
          s.flagged[m] = 0;
          counts.flippedLengthMm += g.chains[m].lengthMm;
        }
        counts.flippedGroups++;
      }
      continue;
    }
    if (p.tier === TIER.weakPair || p.tier === TIER.link || p.tier === TIER.linkSet) {
      const options = p.tier === TIER.weakPair ? [1, 2, 3, 4, 5] : linkSteps(ctx.linkSecondAbove[keyLink(p.key)]);
      const d = options.find((k) => mod5(k - e.d) === p.want);
      if (d === undefined) {
        counts.unresolved++;
        continue;
      }
      const prev = input.overrides.get(p.key);
      input.overrides.set(p.key, d);
      undo = () => (prev === undefined ? input.overrides.delete(p.key) : input.overrides.set(p.key, prev));
    } else if (p.tier === TIER.undecided) {
      // a = left, b = right: d = +1 means left is uphill
      if (p.want !== 1 && p.want !== 4) {
        counts.unresolved++;
        continue;
      }
      const c = p.chain;
      s.side[c] = p.want === 1 ? 1 : -1;
      undo = () => { s.side[c] = 0; };
    } else continue;
    const next = score(ctx);
    if (!better(next, cur, true)) {
      undo();
      counts.unresolved++;
      continue;
    }
    cur = next;
    kept++;
    if (p.tier === TIER.undecided) {
      s.cls[p.chain] = CLASS.index;
      s.root[p.chain] = p.chain;
      s.flagged[p.chain] = 0;
      counts.decidedChains++;
    } else counts.stepsSet++;
  }
  return kept;
}
