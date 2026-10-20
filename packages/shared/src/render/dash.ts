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
}

/** Nominal total length of an OCAD section with `n` gaps. */
function ocadNominal(p: DashPattern, n: number, endDash: number): number {
  return 2 * endDash + Math.max(0, n - 1) * p.dashUm + n * p.gapUm;
}

export function layoutDashesOcad(length: number, p: DashPattern, opts: DashLayoutOptions = {}): Interval[] {
  if (length <= 0) return [];
  const D = p.dashUm;
  const G = p.gapUm;
  // A closed loop has no ends: the two end dashes meet and form one
  // ordinary dash at the start point, so each "end dash" is half a dash.
  const E = opts.closedLoop ? D / 2 : (p.endDashUm ?? D);
  const L = length;
  // Secondary / end gaps need the dash grid even when the main gap is zero
  // (OCAD 517 ruined fence: touching 2.0 mm dashes, each cut by 0.35).
  const virtual = opts.virtual || (p.secondaryGapUm ?? 0) > 0 || (p.endGapUm ?? 0) > 0;
  if (G <= 0 && !virtual) return [[0, L]];

  let n = Math.round((L - 2 * E + D) / (D + G));
  n = Math.max(n, p.minGaps ?? 0, 0);
  if (opts.closedLoop) n = Math.max(n, 1);
  // Not even the gaps fit: fall back to fewer gaps until the dashes have positive length.
  while (n > 0 && L - n * G <= 0) n--;
  if (n === 0) return splitSecondary([[0, L]], p, [0]);

  // Gaps stay nominal; the dashes share what is left in proportion.
  const r = (L - n * G) / (ocadNominal(p, n, E) - n * G);
  const out: Interval[] = [];
  let pos = 0;
  for (let i = 0; i <= n; i++) {
    const nominal = i === 0 || i === n ? E : D;
    const d = nominal * r;
    out.push([pos, pos + d]);
    pos += d + G;
  }
  // Numerical closure: the last dash must end exactly at the section end.
  out[out.length - 1][1] = L;
  return splitSecondary(out, p, opts.closedLoop ? [] : [0, out.length - 1]);
}

/**
 * Secondary gaps split each interior dash into `dashesInGroup` equal
 * parts separated by `secondaryGapUm`; the end dashes (indices in `ends`)
 * are split by `endGapUm` instead and stay whole when it is 0 — OCAD's
 * "Sec. gap" / "End gap" pair (ISOM 507: 2.25 dashes each cut by 0.25,
 * end dashes too because `endGap` = 0.25).
 */
function splitSecondary(dashes: Interval[], p: DashPattern, ends: number[]): Interval[] {
  const sec = p.secondaryGapUm ?? 0;
  const endSec = p.endGapUm ?? 0;
  const k = Math.max(1, p.dashesInGroup ?? 2);
  if (k <= 1 || (sec <= 0 && endSec <= 0)) return dashes;
  const out: Interval[] = [];
  dashes.forEach(([a, b], idx) => {
    const gap = ends.includes(idx) ? endSec : sec;
    const part = (b - a - (k - 1) * gap) / k;
    if (gap <= 0 || part <= 0) {
      out.push([a, b]);
      return;
    }
    for (let j = 0; j < k; j++) {
      const s = a + j * (part + gap);
      out.push([s, s + part]);
    }
  });
  return out;
}

export function layoutDashesOmap(length: number, p: DashPattern, opts: DashLayoutOptions = {}): Interval[] {
  if (length <= 0) return [];
  const D = p.dashUm;
  const B = p.gapUm;
  const k = p.dashesInGroup ?? 1;
  const ib = k > 1 ? (p.secondaryGapUm ?? 0) : 0;
  const group = k * D + (k - 1) * ib;
  if (B <= 0 && !opts.virtual) return [[0, length]];
  const half = !!p.halfOuterDashes && !opts.closedLoop;

  let n: number; // number of full groups
  let nominal: number;
  if (half) {
    // half, B, [group, B]×n, half
    n = Math.max(0, Math.round((length - D - B) / (group + B)));
    nominal = D + n * group + (n + 1) * B;
  } else {
    n = Math.round((length + B) / (group + B));
    if (n < 1) {
      if (p.showAtLeastOne === false) return [[0, length]];
      n = 1;
    }
    nominal = n * group + (n - 1) * B;
  }
  if (opts.closedLoop) {
    // The loop has no ends: n groups and n breaks around the loop, the
    // first group centred on the start point.
    n = Math.max(1, Math.round(length / (group + B)));
    nominal = n * (group + B);
  }
  const f = length / nominal;
  const out: Interval[] = [];
  const pushGroup = (at: number): number => {
    let pos = at;
    for (let j = 0; j < k; j++) {
      out.push([pos, pos + D * f]);
      pos += D * f + (j < k - 1 ? ib * f : 0);
    }
    return pos;
  };
  if (opts.closedLoop) {
    let pos = -(group * f) / 2;
    for (let i = 0; i < n; i++) {
      pos = pushGroup(pos) + B * f;
    }
    // Wrap the negative-start piece to the end of the loop.
    return out.flatMap(([a, b]): Interval[] => {
      if (a >= 0) return [[a, b]];
      return [[a + length, length], [0, b]];
    });
  }
  let pos = 0;
  if (half) {
    out.push([0, (D / 2) * f]);
    pos = (D / 2) * f + B * f;
  }
  for (let i = 0; i < n; i++) {
    pos = pushGroup(pos);
    if (i < n - 1 || half) pos += B * f;
  }
  if (half) out.push([pos, length]);
  else out[out.length - 1][1] = length;
  return out;
}

export function layoutDashes(length: number, p: DashPattern, opts: DashLayoutOptions = {}): Interval[] {
  return p.layout === "omap" ? layoutDashesOmap(length, p, opts) : layoutDashesOcad(length, p, opts);
}

/** Gaps between consecutive dashes (and nothing before the first / after the last). */
export function gapsOf(dashes: Interval[]): Interval[] {
  const out: Interval[] = [];
  for (let i = 1; i < dashes.length; i++) out.push([dashes[i - 1][1], dashes[i][0]]);
  return out;
}
