/**
 * Direct side evidence for contour chains (docs/map-terrain.md §3.1).
 *
 * Each item says which side of one chain is uphill: `side` +1 uphill is
 * left of the chain's drawing direction, −1 right. Nothing here decides a
 * chain; the solve (§3.2) sums the items.
 */

import { walkPolyline } from "../graph/flatten.js";
import { cellIndex } from "../graph/raster.js";
import { SegmentIndex } from "../graph/seg-index.js";
import { LABEL, type ContourGraph } from "../graph/types.js";
import type { EvidenceClass, EvidenceSet, SideEvidence } from "./types.js";

export const EVIDENCE_RULES = {
  /** Weights per class (T1). */
  weight: { dem: 1, tick: 4, cliff: 1.5, lake: 1.5, top: 2, formTick: 1.5 } satisfies Record<EvidenceClass, number>,
  /** A tick or a tagged cliff speaks about the chain within this distance, mm. */
  tickOnChainMm: 0.3,
  cliffOnChainMm: 0.5,
  /** |sin| between a tick and its chain below which the tick is ignored (grazing). */
  tickMinCross: 0.5,
  cliffMinCross: 0.7,
  /** A ray grazing a chain at |sin| below this is dropped. */
  rayMinCross: 0.3,
  /** A ray's hit counts when a segment of the hit chain lies within 3 cells + this, mm. */
  rayHitMm: 0.2,
  /** The form-line crossing test starts this far beyond the ray's start, mm (past the tick's own line). */
  formSkipMm: 0.3,
  /** A form-line tick belongs to a form line within this distance, mm. */
  formTickOnLineMm: 0.3,
  /** Rays from a form-line tick: 0.25 … 8 mm; from a tagged cliff off any contour: 0.5 … 4 mm. */
  formTickRayMm: [0.25, 8] as const,
  cliffRayMm: [0.5, 4] as const,
  /** Tagged cliffs shorter than this (end to end) are ignored, mm. */
  cliffMinMm: 0.3,
  /** Lakes: rings of at least this area (mm²); rays every 0.5 mm, 0.2 … 10 mm; a chain counts at ≥ 4 hits and ≥ 20 % of the rays. */
  lakeMinAreaMm2: 2,
  lakeStepMm: 0.5,
  lakeRayMm: [0.2, 10] as const,
  lakeMinHits: 4,
  lakeMinShare: 0.2,
} as const;

/** Downhill direction of a slope tick at rotation `a` (counter-clockwise): the glyph's stroke is (0, 0) → (0, +len). */
export const tickDirection = (a: number): [number, number] => [-Math.sin(a), Math.cos(a)];

function ringArea(r: ArrayLike<number>): number {
  let a = 0;
  const n = r.length / 2;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    a += r[i * 2] * r[j * 2 + 1] - r[j * 2] * r[i * 2 + 1];
  }
  return a / 2;
}

/** Signed area of a closed chain (> 0 counter-clockwise: the inside is on the left). */
export const chainArea = ringArea;

interface RayHit {
  chain: number;
  fromLeft: boolean;
  dist: number;
}

export interface EvidenceContext {
  g: ContourGraph;
  chainIndex: SegmentIndex;
  formMask: Uint8Array;
}

export function evidenceContext(g: ContourGraph): EvidenceContext {
  const chainIndex = new SegmentIndex(1);
  g.chains.forEach((c, i) => chainIndex.addPolyline(c.pts, i, c.closed));
  const r = g.raster;
  const formMask = new Uint8Array(r.width * r.height);
  for (const c of g.formChains) {
    walkPolyline(c.pts, c.closed, r.cellMm * 0.5, (x, y) => {
      const i = cellIndex(r, x, y);
      if (i >= 0) formMask[i] = 1;
    });
  }
  return { g, chainIndex, formMask };
}

/** March from (x, y) along (dx, dy) through the raster to the first chain; which side the ray reached it from. */
function ray(ctx: EvidenceContext, x: number, y: number, dx: number, dy: number, start: number, max: number): RayHit | null {
  const r = ctx.g.raster;
  for (let s = start; s <= max; s += r.cellMm * 0.5) {
    const px = x + dx * s, py = y + dy * s;
    const c = cellIndex(r, px, py);
    if (c < 0) return null;
    const v = r.labels[c];
    if (v === LABEL.outside) return null;
    if (v <= LABEL.chain0) {
      const id = LABEL.chain0 - v;
      const n = ctx.chainIndex.nearest(px, py, 3 * r.cellMm + EVIDENCE_RULES.rayHitMm, id);
      if (!n) return null;
      const cross = n.tx * -dy - n.ty * -dx;
      if (Math.abs(cross) < EVIDENCE_RULES.rayMinCross) return null;
      return { chain: id, fromLeft: cross > 0, dist: s };
    }
  }
  return null;
}

function crossesForm(ctx: EvidenceContext, x: number, y: number, dx: number, dy: number, from: number, to: number): boolean {
  const r = ctx.g.raster;
  for (let s = from; s <= to; s += r.cellMm * 0.5) {
    const i = cellIndex(r, x + dx * s, y + dy * s);
    if (i >= 0 && ctx.formMask[i]) return true;
  }
  return false;
}

/**
 * A known downhill direction (dx, dy) at a point between contours: the next
 * chain downhill is seen from its uphill side, the next uphill from its
 * downhill side. Dropped when both rays reach the same chain (it wraps
 * around the point), and per ray when it crosses a form line first.
 */
function directional(ctx: EvidenceContext, out: SideEvidence[], x: number, y: number, dx: number, dy: number, start: number, max: number, weight: number): void {
  let down = ray(ctx, x, y, dx, dy, start, max);
  let up = ray(ctx, x, y, -dx, -dy, start, max);
  if (down && up && down.chain === up.chain) return;
  if (down && crossesForm(ctx, x, y, dx, dy, start + EVIDENCE_RULES.formSkipMm, down.dist)) down = null;
  if (up && crossesForm(ctx, x, y, -dx, -dy, start + EVIDENCE_RULES.formSkipMm, up.dist)) up = null;
  if (down) out.push({ chain: down.chain, side: down.fromLeft ? 1 : -1, weight });
  if (up) out.push({ chain: up.chain, side: up.fromLeft ? -1 : 1, weight });
}

/** Slope ticks on contours (101.b): the tick points downhill. */
export function tickEvidence(ctx: EvidenceContext): SideEvidence[] {
  const out: SideEvidence[] = [];
  for (const t of ctx.g.inputs.ticks) {
    const n = ctx.chainIndex.nearest(t.x, t.y, EVIDENCE_RULES.tickOnChainMm);
    if (!n) continue;
    const [dx, dy] = tickDirection(t.angleRad);
    const cross = n.tx * dy - n.ty * dx; // > 0: downhill points left
    if (Math.abs(cross) < EVIDENCE_RULES.tickMinCross) continue;
    out.push({ chain: n.id, side: cross > 0 ? -1 : 1, weight: EVIDENCE_RULES.weight.tick });
  }
  return out;
}

/** Slope ticks on open form lines (103.b): they speak about the contours on either side, by ray. */
export function formTickEvidence(ctx: EvidenceContext): SideEvidence[] {
  const out: SideEvidence[] = [];
  const formIndex = new SegmentIndex(1);
  ctx.g.formChains.forEach((c, i) => formIndex.addPolyline(c.pts, i, c.closed));
  const [a, b] = EVIDENCE_RULES.formTickRayMm;
  for (const t of ctx.g.inputs.formTicks) {
    const n = formIndex.nearest(t.x, t.y, EVIDENCE_RULES.formTickOnLineMm);
    if (!n || ctx.g.formChains[n.id].closed) continue;
    const [dx, dy] = tickDirection(t.angleRad);
    directional(ctx, out, t.x, t.y, dx, dy, a, b, EVIDENCE_RULES.weight.formTick);
  }
  return out;
}

/**
 * Tagged cliffs: the tags point downhill. A cliff drawn on a contour (its
 * midpoint within 0.5 mm) speaks about that contour like a tick; otherwise
 * about its neighbours by ray.
 */
export function cliffEvidence(ctx: EvidenceContext): SideEvidence[] {
  const out: SideEvidence[] = [];
  const w = EVIDENCE_RULES.weight.cliff;
  for (const c of ctx.g.inputs.cliffs) {
    if (!c.tagSide) continue;
    const p = c.pts, n = p.length / 2;
    const tx0 = p[n * 2 - 2] - p[0], ty0 = p[n * 2 - 1] - p[1], l = Math.hypot(tx0, ty0);
    if (l < EVIDENCE_RULES.cliffMinMm) continue;
    const mid = Math.floor(n / 2);
    const mx = n % 2 ? p[mid * 2] : (p[mid * 2 - 2] + p[mid * 2]) / 2;
    const my = n % 2 ? p[mid * 2 + 1] : (p[mid * 2 - 1] + p[mid * 2 + 1]) / 2;
    const dx = (-ty0 / l) * c.tagSide, dy = (tx0 / l) * c.tagSide;
    const on = ctx.chainIndex.nearest(mx, my, EVIDENCE_RULES.cliffOnChainMm);
    if (on) {
      const cross = on.tx * dy - on.ty * dx;
      if (Math.abs(cross) > EVIDENCE_RULES.cliffMinCross) out.push({ chain: on.id, side: cross > 0 ? -1 : 1, weight: w });
    } else directional(ctx, out, mx, my, dx, dy, EVIDENCE_RULES.cliffRayMm[0], EVIDENCE_RULES.cliffRayMm[1], w);
  }
  return out;
}

/** Lakes: the chains a lake's shore mostly looks at lie above it. */
export function lakeEvidence(ctx: EvidenceContext): SideEvidence[] {
  const out: SideEvidence[] = [];
  const R = EVIDENCE_RULES;
  for (const wa of ctx.g.inputs.water) {
    const outer = wa.rings[0];
    if (!outer) continue;
    const area = ringArea(outer);
    if (Math.abs(area) < R.lakeMinAreaMm2) continue;
    const hits = new Map<number, number>();
    let rays = 0;
    walkPolyline(outer, true, R.lakeStepMm, (x, y, tx, ty) => {
      rays++;
      const ox = area > 0 ? ty : -ty, oy = area > 0 ? -tx : tx;
      const h = ray(ctx, x, y, ox, oy, R.lakeRayMm[0], R.lakeRayMm[1]);
      if (h) {
        const k = h.chain * 2 + (h.fromLeft ? 1 : 0);
        hits.set(k, (hits.get(k) ?? 0) + 1);
      }
    });
    for (const [k, n] of hits) {
      // the lake lies on the side the ray came from: that side is downhill
      if (n >= R.lakeMinHits && n >= R.lakeMinShare * rays) out.push({ chain: k >> 1, side: k & 1 ? -1 : 1, weight: R.weight.lake });
    }
  }
  return out;
}

/** Innermost closed contours are tops: the inside region borders no other chain and does not touch the outside. */
export function topEvidence(g: ContourGraph): SideEvidence[] {
  const out: SideEvidence[] = [];
  g.chains.forEach((c, ci) => {
    if (!c.closed || g.leaky[ci] || !g.pairs[ci].length) return;
    const ccw = chainArea(c.pts) > 0;
    const inside = new Set(g.pairs[ci].map((p) => (ccw ? p.left : p.right)));
    for (const r of inside) if (g.regionChains[r].size !== 1 || g.raster.regionTouchesOutside[r]) return;
    out.push({ chain: ci, side: ccw ? 1 : -1, weight: EVIDENCE_RULES.weight.top });
  });
  return out;
}

/** Every class read from the map (§3.1); the external side comes from outside (H9). */
export function gatherEvidence(g: ContourGraph): EvidenceSet {
  const ctx = evidenceContext(g);
  return {
    tick: tickEvidence(ctx),
    cliff: cliffEvidence(ctx),
    lake: lakeEvidence(ctx),
    top: topEvidence(g),
    formTick: formTickEvidence(ctx),
  };
}
