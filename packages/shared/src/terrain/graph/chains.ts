/**
 * Contour pieces → chains: snap join, end classes, gap bridging
 * (docs/map-terrain.md §2.1–2.2).
 */

import { polylineEnd, polylineLength, type PolylineEnd } from "./flatten.js";
import { maskAt } from "./mask.js";
import { SegmentIndex } from "./seg-index.js";
import type { AreaMask, Chain, CliffLine, ContourPiece, EndClass } from "./types.js";

/** §2.2 constants (T1's, unchanged). */
export const CHAIN_RULES = {
  snapMm: 0.15,
  /** Two ends continue each other when their outward tangents' dot product is below this. */
  continueDot: -0.3,
  turnPenalty: 0.2,
  frameLookMm: 3,
  frameStepMm: 0.25,
  mergeMm: 0.2,
  cliffMm: 0.4,
  bridgeGroundM: 45,
  minChainMm: 0.3,
} as const;

const COS55 = Math.cos((55 * Math.PI) / 180);
const COS40 = Math.cos((40 * Math.PI) / 180);

type Compatible = (a: PolylineEnd, b: PolylineEnd, d: number) => boolean;

/** The continuation rule (§2.1). */
export const continues = (a: PolylineEnd, b: PolylineEnd): boolean => a.tx * b.tx + a.ty * b.ty < CHAIN_RULES.continueDot;

/** The bridging rule (§2.2): continues, and each end looks at the other within a cone that narrows with the gap. */
export const bridges: Compatible = (a, b, d) => {
  if (!continues(a, b)) return false;
  if (d < 1e-9) return true;
  const ux = (b.x - a.x) / d, uy = (b.y - a.y) / d;
  const la = a.tx * ux + a.ty * uy, lb = -(b.tx * ux + b.ty * uy);
  if (d <= 0.6) return la > 0 && lb > 0;
  if (d <= 1.5) return la > COS55 && lb > COS55;
  return la > COS40 && lb > COS40;
};

/** A piece as a one-piece chain with both ends dangling. */
function pieceChain(p: ContourPiece): Chain {
  const lengthMm = polylineLength(p.pts);
  return {
    pts: p.pts,
    closed: p.closed,
    lengthMm,
    indexLengthMm: p.index ? lengthMm : 0,
    index: p.index,
    ends: p.closed ? null : ["dangling", "dangling"],
    objects: [p.object],
  };
}

interface FreeEnd {
  chain: number;
  which: 0 | 1;
  e: PolylineEnd;
}

/**
 * Greedy end-to-end join of chains (§2.1): only `dangling` ends join;
 * candidates within `tol` that `compatible` accepts are taken in order
 * of distance plus turn penalty, ties by end order.
 */
export function joinEnds(input: readonly Chain[], tol: number, compatible: Compatible): { chains: Chain[]; joins: number } {
  const ends: FreeEnd[] = [];
  input.forEach((c, ci) => {
    if (!c.ends) return;
    for (const which of [0, 1] as const) if (c.ends[which] === "dangling") ends.push({ chain: ci, which, e: polylineEnd(c.pts, which) });
  });
  const cellOf = (v: number) => Math.floor(v / tol);
  const cellKey = (cx: number, cy: number) => `${cx},${cy}`;
  const grid = new Map<string, number[]>();
  ends.forEach((en, i) => {
    const k = cellKey(cellOf(en.e.x), cellOf(en.e.y));
    const l = grid.get(k);
    if (l) l.push(i);
    else grid.set(k, [i]);
  });
  const minSelfMm = Math.max(3 * tol, 1);
  const cand: [number, number, number][] = [];
  ends.forEach((a, i) => {
    const cx = cellOf(a.e.x), cy = cellOf(a.e.y);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const l = grid.get(cellKey(cx + dx, cy + dy));
        if (!l) continue;
        for (const j of l) {
          if (j <= i) continue;
          const b = ends[j];
          const d = Math.hypot(a.e.x - b.e.x, a.e.y - b.e.y);
          if (d > tol) continue;
          if (a.chain === b.chain && input[a.chain].lengthMm < minSelfMm) continue;
          if (compatible(a.e, b.e, d)) cand.push([d + CHAIN_RULES.turnPenalty * (1 + a.e.tx * b.e.tx + a.e.ty * b.e.ty), i, j]);
        }
      }
    }
  });
  cand.sort((p, q) => p[0] - q[0] || p[1] - q[1] || p[2] - q[2]);
  const link = new Int32Array(ends.length).fill(-1);
  let joins = 0;
  for (const [, i, j] of cand) {
    if (link[i] < 0 && link[j] < 0) {
      link[i] = j;
      link[j] = i;
      joins++;
    }
  }
  const endIdx = new Map<number, number>();
  ends.forEach((en, i) => endIdx.set(en.chain * 2 + en.which, i));
  const used = new Uint8Array(input.length);
  const out: Chain[] = [];

  const walk = (start: number, startWhich: 0 | 1): void => {
    const pts: number[] = [];
    let lengthMm = 0, indexLengthMm = 0;
    const objects: number[] = [];
    const first = input[start].ends![startWhich];
    let last: EndClass = "dangling";
    let closed = false;
    let ci = start, w: 0 | 1 = startWhich;
    for (;;) {
      used[ci] = 1;
      const c = input[ci];
      const n = c.pts.length / 2;
      for (let i = 0; i < n; i++) {
        const k = w === 0 ? i : n - 1 - i;
        pts.push(c.pts[k * 2], c.pts[k * 2 + 1]);
      }
      lengthMm += c.lengthMm;
      indexLengthMm += c.indexLengthMm;
      for (const o of c.objects) objects.push(o);
      const exit = (1 - w) as 0 | 1;
      const li = endIdx.get(ci * 2 + exit);
      const next = li === undefined ? -1 : link[li];
      if (next < 0) {
        last = c.ends![exit];
        break;
      }
      const ne = ends[next];
      if (ne.chain === start && ne.which === startWhich) {
        closed = true;
        break;
      }
      lengthMm += Math.hypot(ne.e.x - pts[pts.length - 2], ne.e.y - pts[pts.length - 1]);
      ci = ne.chain;
      w = ne.which;
    }
    out.push({
      pts: Float64Array.from(pts),
      closed,
      lengthMm,
      indexLengthMm,
      index: indexLengthMm > 0.5 * lengthMm,
      ends: closed ? null : [first, last],
      objects,
    });
  };

  input.forEach((c, ci) => {
    if (c.closed) {
      used[ci] = 1;
      out.push(c);
    }
  });
  input.forEach((_, ci) => {
    if (used[ci]) return;
    for (const w of [0, 1] as const) {
      const li = endIdx.get(ci * 2 + w);
      if ((li === undefined || link[li] < 0) && !used[ci]) walk(ci, w);
    }
  });
  input.forEach((_, ci) => {
    if (!used[ci]) walk(ci, 0);
  });
  return { chains: out, joins };
}

/** Snap join at 0.15 mm under the continuation rule (§2.1). */
export function snapJoin(pieces: readonly ContourPiece[]): { chains: Chain[]; joins: number } {
  return joinEnds(pieces.map(pieceChain), CHAIN_RULES.snapMm, continues);
}

/** Classifies the open ends of snap-joined chains in place: frame, merge, cliff, else dangling (§2.2). */
export function classifyEnds(chains: Chain[], cliffs: readonly CliffLine[], mask: AreaMask): void {
  const cliffIdx = new SegmentIndex(1);
  cliffs.forEach((c, i) => cliffIdx.addPolyline(c.pts, i));
  const chainIdx = new SegmentIndex(1);
  chains.forEach((c, i) => chainIdx.addPolyline(c.pts, i, c.closed));
  const R = CHAIN_RULES;
  chains.forEach((c, ci) => {
    if (!c.ends) return;
    const ends: [EndClass, EndClass] = ["dangling", "dangling"];
    for (const w of [0, 1] as const) {
      const e = polylineEnd(c.pts, w);
      let cls: EndClass = "dangling";
      for (let s = R.frameStepMm; s <= R.frameLookMm; s += R.frameStepMm) {
        if (!maskAt(mask, e.x + e.tx * s, e.y + e.ty * s)) {
          cls = "frame";
          break;
        }
      }
      if (cls === "dangling" && chainIdx.nearest(e.x, e.y, R.mergeMm, -1, ci)) cls = "merge";
      if (cls === "dangling" && cliffIdx.nearest(e.x, e.y, R.cliffMm)) cls = "cliff";
      ends[w] = cls;
    }
    c.ends = ends;
  });
}

export interface JoinContext {
  cliffs: readonly CliffLine[];
  mask: AreaMask;
  groundMPerMm: number;
  /** Default 45 m. */
  bridgeGroundM?: number;
}

export interface JoinResult {
  chains: Chain[];
  snapJoins: number;
  bridgedGaps: number;
}

/** Contour pieces → chains: snap join, end classes, gap bridging in ground metres, short chains dropped (§2.1–2.2). */
export function joinChains(pieces: readonly ContourPiece[], ctx: JoinContext): JoinResult {
  const snap = snapJoin(pieces);
  classifyEnds(snap.chains, ctx.cliffs, ctx.mask);
  const bridgeMm = (ctx.bridgeGroundM ?? CHAIN_RULES.bridgeGroundM) / ctx.groundMPerMm;
  const bridged = joinEnds(snap.chains, bridgeMm, bridges);
  return {
    chains: bridged.chains.filter((c) => c.lengthMm > CHAIN_RULES.minChainMm),
    snapJoins: snap.joins,
    bridgedGaps: bridged.joins,
  };
}
