/**
 * Region levels: a weighted union-find in trust tiers (docs/map-terrain.md §3.3).
 *
 * Every edge says level(a) − level(b) = d. Decided chains put their uphill
 * region one level (or, when index repair set it, `k` levels) above the
 * downhill one; cliff links and undecided chains join at a zero step, as
 * weak links, unless index repair set a step. Edges are taken tier by
 * tier, most samples first; an edge whose regions are already joined
 * closes a cycle: consistent, multi-step (same direction, larger step) or
 * a conflict.
 */

import type { ContourGraph } from "../graph/types.js";
import { CLIFF_STEP_SOURCE, NO_LEVEL } from "./types.js";

export class LevelUnion {
  readonly parent: Int32Array;
  /** Level relative to the parent (relative to the root after `find`). */
  readonly off: Int32Array;

  constructor(n: number) {
    this.parent = new Int32Array(n);
    this.off = new Int32Array(n);
    for (let i = 0; i < n; i++) this.parent[i] = i;
  }

  find(r: number): number {
    const path: number[] = [];
    while (this.parent[r] !== r) {
      path.push(r);
      r = this.parent[r];
    }
    for (let i = path.length - 1; i >= 0; i--) {
      const q = path[i], p = this.parent[q];
      if (p !== r) this.off[q] += this.off[p];
      this.parent[q] = r;
    }
    return r;
  }

  /** Level of r relative to its root. */
  level(r: number): number {
    this.find(r);
    return this.off[r];
  }

  /** Joins so that level(a) − level(b) = d; false when already joined. */
  join(a: number, b: number, d: number): boolean {
    const ra = this.find(a), rb = this.find(b);
    if (ra === rb) return false;
    this.parent[ra] = rb;
    this.off[ra] = d - this.off[a] + this.off[b];
    return true;
  }
}

/**
 * Trust tiers, taken in this order (§3.3): pairs of strict chains; pairs of
 * flagged chains; weak pairs (along a cliff, or beside a band that spans
 * two levels); cliff links with a step set by index repair; other cliff
 * links; pairs of undecided chains.
 */
export const TIER = { strict: 1, flagged: 2, weakPair: 3, linkSet: 4, link: 5, undecided: 6 } as const;
/** Tiers whose tree edges index repair may change. */
export const SUSPECT_TIER = TIER.flagged;

export interface ForestEdge {
  a: number;
  b: number;
  /** level(a) − level(b). */
  d: number;
  tier: number;
  weight: number;
  /** Chain pair: chain · 4096 + pair; cliff link i: −1 − i. */
  key: number;
}

export const edgeKey = (chain: number, pair: number) => chain * 4096 + pair;
export const linkKey = (i: number) => -1 - i;
export const keyChain = (k: number) => (k >= 0 ? Math.floor(k / 4096) : -1);
export const keyPair = (k: number) => (k >= 0 ? k % 4096 : -1);
export const keyLink = (k: number) => (k < 0 ? -1 - k : -1);

export interface ForestInput {
  side: Int8Array;
  flagged: Uint8Array;
  cliffBorne: Uint8Array[];
  linkSamples: Uint32Array;
  /** Steps set by index repair, by edge key. */
  overrides: Map<number, number>;
  /** Per region: 1 when it spans two levels (§3.3); pairs beside it are weak. */
  leakyRegion: Uint8Array;
}

export interface Forest {
  /** Per region: floor level, 0 the lowest region of its connected set. */
  regionLevel: Int32Array;
  /** Per region: root of its component over tiers 1–4 (decided chains and index-set links). */
  regionComponent: Int32Array;
  /** Per region: root of its connected set over all tiers. */
  regionSet: Int32Array;
  regionWeak: Uint8Array;
  chainLevel: Int32Array;
  chainStep: Uint8Array;
  conflict: Float32Array;
  cliffStep: Int32Array;
  cliffStepSource: Uint8Array;
  /** Tree edges, in join order. */
  tree: ForestEdge[];
  /** Per region: the tree edge to its parent (index into `tree`), −1 at a root; BFS order and depth. */
  parentEdge: Int32Array;
  parentRegion: Int32Array;
  depth: Int32Array;
  order: Int32Array;
  /** Length of decided chains whose pairs contradict the levels (conflict share ≥ 0.5 counts whole). */
  conflictLengthMm: number;
}

/** All edges of the graph with their tiers and default (or overridden) steps, in join order. */
export function forestEdges(g: ContourGraph, f: ForestInput): ForestEdge[] {
  const edges: ForestEdge[] = [];
  g.pairs.forEach((ps, c) => {
    const s = f.side[c];
    ps.forEach((p, pi) => {
      const key = edgeKey(c, pi);
      if (!s) {
        edges.push({ a: p.left, b: p.right, d: 0, tier: TIER.undecided, weight: p.samples, key });
        return;
      }
      const [up, down] = s > 0 ? [p.left, p.right] : [p.right, p.left];
      const weak = f.cliffBorne[c][pi] || f.leakyRegion[p.left] || f.leakyRegion[p.right];
      const tier = weak ? TIER.weakPair : f.flagged[c] ? TIER.flagged : TIER.strict;
      edges.push({ a: up, b: down, d: f.overrides.get(key) ?? 1, tier, weight: p.samples, key });
    });
  });
  g.cliffLinks.forEach(([first, second], i) => {
    const key = linkKey(i);
    const set = f.overrides.get(key);
    edges.push({ a: second, b: first, d: set ?? 0, tier: set === undefined ? TIER.link : TIER.linkSet, weight: f.linkSamples[i], key });
  });
  edges.sort((x, y) => x.tier - y.tier || y.weight - x.weight || x.key - y.key);
  return edges;
}

export function buildForest(g: ContourGraph, f: ForestInput): Forest {
  const NR = g.raster.regionCount + 1, NC = g.chains.length;
  const u = new LevelUnion(NR);
  const edges = forestEdges(g, f);
  const chainStep = new Uint8Array(NC), conflict = new Float32Array(NC);
  const cliffStep = new Int32Array(g.cliffLinks.length), cliffStepSource = new Uint8Array(g.cliffLinks.length).fill(CLIFF_STEP_SOURCE.assumed);
  const tree: ForestEdge[] = [];
  const regionComponent = new Int32Array(NR), block = new Int32Array(NR);
  let snapStrict = false, snapBlock = false;
  const totals = g.pairs.map((ps) => ps.reduce((a, p) => a + p.samples, 0));
  for (const e of edges) {
    if (!snapBlock && e.tier > TIER.strict) {
      for (let r = 0; r < NR; r++) block[r] = u.find(r);
      snapBlock = true;
    }
    if (!snapStrict && e.tier > TIER.linkSet) {
      for (let r = 0; r < NR; r++) regionComponent[r] = u.find(r);
      snapStrict = true;
    }
    const c = e.key >= 0 ? keyChain(e.key) : -1;
    if (u.join(e.a, e.b, e.d)) {
      tree.push(e);
      if (c >= 0 && e.tier <= TIER.weakPair) chainStep[c] = Math.max(chainStep[c], Math.abs(e.d));
      if (e.key < 0) {
        cliffStep[keyLink(e.key)] = e.d;
        cliffStepSource[keyLink(e.key)] = e.tier === TIER.linkSet ? CLIFF_STEP_SOURCE.index : CLIFF_STEP_SOURCE.assumed;
      }
      continue;
    }
    const dAct = u.level(e.a) - u.level(e.b);
    if (e.key < 0) {
      cliffStep[keyLink(e.key)] = dAct;
      cliffStepSource[keyLink(e.key)] = CLIFF_STEP_SOURCE.implied;
    } else if (e.tier <= TIER.weakPair) {
      if (dAct >= 1) chainStep[c] = Math.max(chainStep[c], Math.min(255, dAct));
      else conflict[c] += e.weight / totals[c];
    }
  }
  if (!snapBlock) for (let r = 0; r < NR; r++) block[r] = u.find(r);
  if (!snapStrict) for (let r = 0; r < NR; r++) regionComponent[r] = u.find(r);
  const regionSet = new Int32Array(NR);
  for (let r = 0; r < NR; r++) regionSet[r] = u.find(r);

  // explicit tree, rooted per connected set at the largest strict block
  const blockSize = new Map<number, number>();
  for (let r = 1; r < NR; r++) blockSize.set(block[r], (blockSize.get(block[r]) ?? 0) + 1);
  const rootOf = new Map<number, number>();
  for (let r = 1; r < NR; r++) {
    const s = regionSet[r], cur = rootOf.get(s);
    if (cur === undefined || blockSize.get(block[r])! > blockSize.get(block[cur])!) rootOf.set(s, block[r]);
  }
  const adj: number[][] = Array.from({ length: NR }, () => []);
  tree.forEach((e, i) => {
    adj[e.a].push(i);
    adj[e.b].push(i);
  });
  const parentEdge = new Int32Array(NR).fill(-1), parentRegion = new Int32Array(NR).fill(-1), depth = new Int32Array(NR);
  const level = new Int32Array(NR), seen = new Uint8Array(NR), order: number[] = [];
  for (let r = 1; r < NR; r++) {
    const root = rootOf.get(regionSet[r])!;
    if (seen[root]) continue;
    seen[root] = 1;
    order.push(root);
    for (let k = order.length - 1; k < order.length; k++) {
      const p = order[k];
      for (const i of adj[p]) {
        const e = tree[i], q = e.a === p ? e.b : e.a;
        if (seen[q]) continue;
        seen[q] = 1;
        parentEdge[q] = i;
        parentRegion[q] = p;
        depth[q] = depth[p] + 1;
        level[q] = q === e.a ? level[p] + e.d : level[p] - e.d;
        order.push(q);
      }
    }
  }
  // level 0 = the lowest region of each connected set
  const lo = new Map<number, number>();
  for (let r = 1; r < NR; r++) lo.set(regionSet[r], Math.min(lo.get(regionSet[r]) ?? Infinity, level[r]));
  const regionLevel = new Int32Array(NR), regionWeak = new Uint8Array(NR);
  for (let r = 1; r < NR; r++) {
    regionLevel[r] = level[r] - lo.get(regionSet[r])!;
    regionWeak[r] = regionComponent[r] !== regionComponent[rootOf.get(regionSet[r])!] ? 1 : 0;
  }
  const chainLevel = new Int32Array(NC).fill(NO_LEVEL);
  let conflictLengthMm = 0;
  g.pairs.forEach((ps, c) => {
    if (!ps.length) return;
    const p = ps.reduce((a, b) => (b.samples > a.samples ? b : a));
    chainLevel[c] = Math.max(regionLevel[p.left], regionLevel[p.right]);
    const cf = conflict[c] > 0.5 ? 1 : Math.min(1, conflict[c]);
    conflictLengthMm += cf * g.chains[c].lengthMm;
  });
  return { regionLevel, regionComponent, regionSet, regionWeak, chainLevel, chainStep, conflict, cliffStep, cliffStepSource, tree, parentEdge, parentRegion, depth, order: Int32Array.from(order), conflictLengthMm };
}
