/**
 * Dash layout — turns a dash pattern and a section length into the length
 * intervals that are drawn. Two fitting algorithms, selected by
 * `DashPattern.layout`:
 *
 * - `ocad`: gaps keep their nominal length, all dashes are stretched or
 *   compressed by one common ratio so the section begins and ends with a
 *   full end dash. The gap count is the one whose nominal total is closest
 *   to the section length, bounded below by `minGaps`.
 * - `omap`: dashes and breaks are scaled by one common factor
 *   (OpenOrienteering Mapper's adjustment); `halfOuterDashes` begins and
 *   ends the section with a half dash; `dashesInGroup` groups dashes with
 *   `secondaryGapUm` between them.
 *
 * Provisional (docs/map-rendering.md §4.2): the choice of what stretches
 * is to be confirmed against OCAD / Mapper exports in the corpus run.
 * The structure — one fit per section, output as intervals — is not.
 */

import type { DashPattern } from "./symbol.js";

export type Interval = [number, number];

export interface DashLayoutOptions {
  /** The section is a closed loop with no split points (start = end). */
  closedLoop?: boolean;
  /**
   * Lay out even when the gap is zero (the stroke itself is solid), so a
   * solid line with spaced glyphs — OCAD's power line, where symbols sit
   * at the zero-width "gaps" — gets its positions from the same fit.
   */
  virtual?: boolean;
  /** The section starts at a dash point: a dash is centred on its start, half of it in this section. */
  halfStart?: boolean;
  /** The section ends at a dash point. */
  halfEnd?: boolean;
}

/**
 * One dash of a section's grid, in section-relative lengths. A dash
 * centred on a dash point (or on the seam of a closed loop) is listed
 * **whole**, so it reaches beyond the section (`a < 0` or `b > L`); the
 * section draws only its own part of it (`layoutDashes`), and the
 * neighbouring section draws the rest. `end` marks a dash at a line end
 * or corner, which takes `endGapUm` instead of `secondaryGapUm`.
 */
export interface GridDash {
  a: number;
  b: number;
  end: boolean;
}

export interface DashGrid {
  /** Section length. */
  length: number;
  /** Sorted, possibly reaching beyond `[0, length]` at dash points and loop seams. */
  dashes: GridDash[];
  closedLoop: boolean;
  /** No dash layout applies: the section is one solid stroke. */
  solid: boolean;
}

function ocadGrid(length: number, p: DashPattern, opts: DashLayoutOptions): DashGrid {
  const L = length;
  const D = p.dashUm;
  const G = p.gapUm;
  const closed = !!opts.closedLoop;
  // A dash point centres a dash: the section begins / ends with half of
  // it. A closed loop has no ends: its two end dashes are the two halves
  // of one ordinary dash at the start point.
  const halfS = closed || !!opts.halfStart;
  const halfE = closed || !!opts.halfEnd;
  const E = p.endDashUm ?? D;
  const Es = halfS ? D / 2 : E;
  const Ee = halfE ? D / 2 : E;
  // Secondary / end gaps need the dash grid even when the main gap is zero
  // (OCAD 517 ruined fence: touching 2.0 mm dashes, each cut by 0.35).
  const virtual = opts.virtual || (p.secondaryGapUm ?? 0) > 0 || (p.endGapUm ?? 0) > 0;
  if (G <= 0 && !virtual) return { length: L, dashes: [{ a: 0, b: L, end: true }], closedLoop: closed, solid: true };

  let n = Math.round((L - Es - Ee + D) / (D + G));
  n = Math.max(n, p.minGaps ?? 0, 0);
  if (closed) n = Math.max(n, 1);
  // Not even the gaps fit: fall back to fewer gaps until the dashes have positive length.
  while (n > 0 && L - n * G <= 0) n--;
  // One dash for the whole section: cut by the end gap like an end dash,
  // unless it touches a dash point (then it is part of that dash and stays whole).
  if (n === 0) {
    if (halfS || halfE) return { length: L, dashes: [{ a: 0, b: L, end: false }], closedLoop: closed, solid: false };
    return { length: L, dashes: splitSecondary([{ a: 0, b: L, end: true }], p), closedLoop: closed, solid: false };
  }

  // Gaps stay nominal; the dashes share what is left in proportion.
  const r = (L - n * G) / (Es + Ee + (n - 1) * D);
  const dashes: GridDash[] = [];
  let pos = 0;
  for (let i = 0; i <= n; i++) {
    const first = i === 0, last = i === n;
    const d = (first ? Es : last ? Ee : D) * r;
    if (first && halfS) dashes.push({ a: -d, b: d, end: false });
    else if (last && halfE) {
      // Numerical closure: the half dash is centred exactly on the section end.
      if (!closed) dashes.push({ a: L - d, b: L + d, end: false });
    } else dashes.push({ a: pos, b: pos + d, end: first || last });
    pos += d + G;
  }
  // Numerical closure: a last full end dash ends exactly at the section end.
  if (!halfE) dashes[dashes.length - 1].b = L;
  return { length: L, dashes: splitSecondary(dashes, p), closedLoop: closed, solid: false };
}

/**
 * Secondary gaps split each interior dash into `dashesInGroup` equal
 * parts separated by `secondaryGapUm`; the end dashes are split by
 * `endGapUm` instead and stay whole when it is 0 — OCAD's "Sec. gap" /
 * "End gap" pair (ISOM 507: 2.25 dashes each cut by 0.25, end dashes too
 * because `endGap` = 0.25). A dash centred on a dash point is interior:
 * it is split whole, so the cut lies symmetrically about the point.
 */
function splitSecondary(dashes: GridDash[], p: DashPattern): GridDash[] {
  const sec = p.secondaryGapUm ?? 0;
  const endSec = p.endGapUm ?? 0;
  const k = Math.max(1, p.dashesInGroup ?? 2);
  if (k <= 1 || (sec <= 0 && endSec <= 0)) return dashes;
  const out: GridDash[] = [];
  for (const dash of dashes) {
    const gap = dash.end ? endSec : sec;
    const part = (dash.b - dash.a - (k - 1) * gap) / k;
    if (gap <= 0 || part <= 0) {
      out.push(dash);
      continue;
    }
    for (let j = 0; j < k; j++) {
      const s = dash.a + j * (part + gap);
      out.push({ a: s, b: s + part, end: dash.end });
    }
  }
  return out;
}

function omapGrid(length: number, p: DashPattern, opts: DashLayoutOptions): DashGrid {
  const D = p.dashUm;
  const B = p.gapUm;
  const k = p.dashesInGroup ?? 1;
  const ib = k > 1 ? (p.secondaryGapUm ?? 0) : 0;
  const group = k * D + (k - 1) * ib;
  const closed = !!opts.closedLoop;
  if (B <= 0 && !opts.virtual) return { length, dashes: [{ a: 0, b: length, end: true }], closedLoop: closed, solid: true };
  const out: GridDash[] = [];
  const pushGroup = (at: number, f: number): number => {
    let pos = at;
    for (let j = 0; j < k; j++) {
      out.push({ a: pos, b: pos + D * f, end: false });
      pos += D * f + (j < k - 1 ? ib * f : 0);
    }
    return pos;
  };

  if (closed) {
    // The loop has no ends: n groups and n breaks around the loop, the
    // first group centred on the start point.
    const n = Math.max(1, Math.round(length / (group + B)));
    const f = length / (n * (group + B));
    let pos = -(group * f) / 2;
    for (let i = 0; i < n; i++) pos = pushGroup(pos, f) + B * f;
    return { length, dashes: out, closedLoop: true, solid: false };
  }

  // Half dashes: Mapper's `half_outer_dashes` at the line's ends, and a
  // dash centred on every dash point (only for single dashes, as Mapper).
  const hs = (opts.halfStart ? k === 1 : !!p.halfOuterDashes) ? 1 : 0;
  const he = (opts.halfEnd ? k === 1 : !!p.halfOuterDashes) ? 1 : 0;
  // half?, B, [group, B]×n, half?  —  breaks = n − 1 + hs + he.
  let n = Math.round((length - (hs + he) * (D / 2) - (hs + he - 1) * B) / (group + B));
  if (hs + he === 2) n = Math.max(0, n);
  else if (n < 1) {
    if (hs + he === 0 && p.showAtLeastOne === false) return { length, dashes: [{ a: 0, b: length, end: true }], closedLoop: false, solid: true };
    n = 1;
  }
  const nominal = (hs + he) * (D / 2) + n * group + (n - 1 + hs + he) * B;
  const f = length / nominal;
  let pos = 0;
  if (hs) {
    // At a dash point the half is one half of a whole dash centred on the start.
    out.push(opts.halfStart ? { a: -(D / 2) * f, b: (D / 2) * f, end: false } : { a: 0, b: (D / 2) * f, end: true });
    pos = (D / 2) * f + B * f;
  }
  for (let i = 0; i < n; i++) {
    pos = pushGroup(pos, f);
    if (i < n - 1 || he) pos += B * f;
  }
  if (he) out.push(opts.halfEnd ? { a: length - (D / 2) * f, b: length + (D / 2) * f, end: false } : { a: pos, b: length, end: true });
  else out[out.length - 1].b = length;
  return { length, dashes: out, closedLoop: false, solid: false };
}

/** The dash grid of one section, before it is clipped to the section (see `GridDash`). */
export function dashGrid(length: number, p: DashPattern, opts: DashLayoutOptions = {}): DashGrid {
  if (length <= 0) return { length: 0, dashes: [], closedLoop: !!opts.closedLoop, solid: false };
  return p.layout === "omap" ? omapGrid(length, p, opts) : ocadGrid(length, p, opts);
}

/**
 * The drawn intervals of a grid: each dash clipped to the section, or on a
 * closed loop wrapped round it. Sorted.
 */
export function gridIntervals(g: DashGrid): Interval[] {
  const L = g.length;
  const out: Interval[] = [];
  for (const { a, b } of g.dashes) {
    if (g.closedLoop) {
      if (a < 0) out.push([a + L, L], [0, Math.min(b, L)]);
      else if (b > L) out.push([a, L], [0, b - L]);
      else out.push([a, b]);
    } else {
      const a1 = Math.max(0, a), b1 = Math.min(L, b);
      if (b1 > a1) out.push([a1, b1]);
    }
  }
  return out.filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]);
}

/**
 * Where a grid feature centred at `c` is placed, or `undefined` when it
 * belongs to the neighbouring section: a dash or gap centred on a dash
 * point is owned by the section that **starts** there, so it is placed
 * once. On a closed loop every centre is folded onto the loop.
 */
export function gridCentre(g: DashGrid, c: number): number | undefined {
  const L = g.length;
  if (g.closedLoop) return ((c % L) + L) % L;
  return c >= 0 && c < L ? c : undefined;
}

/** Gaps between consecutive grid dashes; on a closed loop also the one across the seam. */
export function gridGaps(g: DashGrid): Interval[] {
  const d = g.dashes;
  const out: Interval[] = [];
  for (let i = 1; i < d.length; i++) out.push([d[i - 1].b, d[i].a]);
  if (g.closedLoop && d.length > 0) out.push([d[d.length - 1].b, d[0].a + g.length]);
  // Zero-width gaps are kept: a solid line's virtual grid places glyphs at its joints (516).
  return out.filter(([a, b]) => b >= a);
}

export function layoutDashesOcad(length: number, p: DashPattern, opts: DashLayoutOptions = {}): Interval[] {
  return gridIntervals(dashGrid(length, { ...p, layout: "ocad" }, opts));
}

export function layoutDashesOmap(length: number, p: DashPattern, opts: DashLayoutOptions = {}): Interval[] {
  return gridIntervals(dashGrid(length, { ...p, layout: "omap" }, opts));
}

export function layoutDashes(length: number, p: DashPattern, opts: DashLayoutOptions = {}): Interval[] {
  return gridIntervals(dashGrid(length, p, opts));
}

/** Gaps between consecutive dashes (and nothing before the first / after the last). */
export function gapsOf(dashes: Interval[]): Interval[] {
  const out: Interval[] = [];
  for (let i = 1; i < dashes.length; i++) out.push([dashes[i - 1][1], dashes[i][0]]);
  return out;
}
