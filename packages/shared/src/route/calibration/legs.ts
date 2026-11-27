/**
 * A GPS track cut into the legs of its course and cleaned
 * (docs/course-elevation.md §7.9.2).
 */

import type { RoutePoint } from "../grid.js";
import type { PaperControl, PaperTrack } from "./record.js";

export interface SplitOptions {
  groundMPerMm: number;
  /** The map's extent, paper mm: a leg with a point outside is left out. */
  bounds?: { minX: number; minY: number; maxX: number; maxY: number } | null;
  /** A control is passed within this, ground metres. */
  controlReachM?: number;
  /** The pass is looked for this long round the punch, seconds. */
  punchWindowS?: number;
  maxSpeedMps?: number;
  maxGapS?: number;
  standRadiusM?: number;
  standMinS?: number;
  maxStandShare?: number;
  maxDroppedShare?: number;
}

export const SPLIT_DEFAULTS = {
  controlReachM: 15, punchWindowS: 20, maxSpeedMps: 9, maxGapS: 20, standRadiusM: 3, standMinS: 10, maxStandShare: 0.2, maxDroppedShare: 0.1,
} as const;

export type LegRejection = "control-missed" | "gap" | "jitter" | "off-map" | "standing" | "too-short";

export interface LegObservation {
  /** Index of the leg in the course: from control `leg` to control `leg + 1`. */
  leg: number;
  from: PaperControl;
  to: PaperControl;
  /** The track between the two passes, paper mm. */
  points: RoutePoint[];
  /** Seconds between the passes, standing taken out. */
  timeS: number;
  standingS: number;
}

export interface SplitResult {
  legs: LegObservation[];
  rejected: Partial<Record<LegRejection, number>>;
  /** Ground metres between each control and the track's pass of it (those found). */
  missM: number[];
}

const median = (v: number[]): number => {
  if (v.length === 0) return Number.NaN;
  const s = [...v].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** The track's legs between its passes of the course's controls. */
export function splitTrack(controls: readonly PaperControl[], track: PaperTrack, options: SplitOptions): SplitResult {
  const o = { ...SPLIT_DEFAULTS, ...options };
  const g = o.groundMPerMm;
  const rejected: Partial<Record<LegRejection, number>> = {};
  const reject = (r: LegRejection) => { rejected[r] = (rejected[r] ?? 0) + 1; };
  const dist = (a: RoutePoint, b: RoutePoint) => Math.hypot(a.x - b.x, a.y - b.y) * g;

  // Times that do not increase are dropped, then fixes that need more than the top speed from both neighbours.
  let pts: { p: RoutePoint; t: number }[] = [];
  for (let i = 0; i < track.points.length; i++) {
    const t = track.timeS[i];
    if (pts.length === 0 || t > pts[pts.length - 1].t) pts.push({ p: track.points[i], t });
  }
  const droppedAt: number[] = [];
  const speed = (a: { p: RoutePoint; t: number }, b: { p: RoutePoint; t: number }) => dist(a.p, b.p) / Math.max(1e-6, b.t - a.t);
  // One wild fix, or two in a row: the fixes either side of them agree, they do not.
  const wild = new Set<number>();
  for (let i = 1; i + 1 < pts.length; i++) {
    if (wild.has(i) || speed(pts[i - 1], pts[i]) <= o.maxSpeedMps) continue;
    if (speed(pts[i], pts[i + 1]) > o.maxSpeedMps) wild.add(i);
    else if (i + 2 < pts.length && speed(pts[i + 1], pts[i + 2]) > o.maxSpeedMps && speed(pts[i - 1], pts[i + 2]) <= o.maxSpeedMps) { wild.add(i); wild.add(i + 1); }
  }
  pts = pts.filter((q, i) => {
    if (wild.has(i)) droppedAt.push(q.t);
    return !wild.has(i);
  });
  const empty: SplitResult = { legs: [], rejected, missM: [] };
  if (pts.length < 2 || controls.length < 2) return empty;

  // The punch of each control on the track's clock, where the record has one.
  const expected: (number | null)[] = controls.map(() => null);
  let next = 0;
  for (const [i, c] of controls.entries()) {
    if (c.type === "start") { expected[i] = track.startS; continue; }
    if (c.type === "finish" && i === controls.length - 1 && track.finishS !== null) { expected[i] = track.finishS; continue; }
    const at = track.splits.findIndex((s, k) => k >= next && s.code === c.code);
    if (at >= 0) { expected[i] = track.splits[at].atS; next = at + 1; }
  }
  /** The track's nearest approach to `c` between two times: a point on a segment, with its interpolated time. */
  interface Pass { seg: number; k: number; t: number; p: RoutePoint; d: number }
  const approach = (c: RoutePoint, i: number): Pass => {
    const a = pts[i], b = pts[i + 1];
    const dx = b.p.x - a.p.x, dy = b.p.y - a.p.y;
    const len2 = dx * dx + dy * dy;
    const k = len2 > 0 ? Math.min(1, Math.max(0, ((c.x - a.p.x) * dx + (c.y - a.p.y) * dy) / len2)) : 0;
    const p = { x: a.p.x + dx * k, y: a.p.y + dy * k };
    return { seg: i, k, t: a.t + (b.t - a.t) * k, p, d: dist(p, c) };
  };
  /**
   * The pass between two times: the nearest approach, and among approaches as near as it within
   * the standing radius — a runner waiting on the start line, or stopped at the finish — the one
   * closest to `prefer`, the punch on the track's clock.
   */
  const nearestIn = (c: RoutePoint, t0: number, t1: number, fromSeg = 0, prefer = (t0 + t1) / 2): Pass | null => {
    const found: Pass[] = [];
    for (let i = fromSeg; i + 1 < pts.length; i++) {
      if (pts[i + 1].t < t0) continue;
      if (pts[i].t > t1) break;
      const q = approach(c, i);
      if (q.t >= t0 - 1e-9 && q.t <= t1 + 1e-9) found.push(q);
    }
    if (found.length === 0) return null;
    const nearest = Math.min(...found.map((q) => q.d));
    let best: Pass | null = null;
    for (const q of found) if (q.d <= nearest + o.standRadiusM && (!best || Math.abs(q.t - prefer) < Math.abs(best.t - prefer))) best = q;
    return best;
  };
  // One clock offset per track: the watch and the punching system are two clocks.
  const offsets: number[] = [];
  for (const [i, c] of controls.entries()) {
    const e = expected[i];
    if (e === null) continue;
    const q = nearestIn(c, e - 3 * o.punchWindowS, e + 3 * o.punchWindowS);
    if (q && q.d <= o.controlReachM) offsets.push(q.t - e);
  }
  const offset = offsets.length > 0 ? median(offsets) : 0;

  const pass: (Pass | null)[] = [];
  let last = 0;
  for (const [i, c] of controls.entries()) {
    const e = expected[i];
    let q: Pass | null = null;
    if (e !== null) q = nearestIn(c, e + offset - o.punchWindowS, e + offset + o.punchWindowS, last);
    else {
      // No punch time: the first pass after the control before it, followed to its nearest point.
      for (let j = last; j + 1 < pts.length; j++) {
        let cur = approach(c, j);
        if (cur.d > o.controlReachM) continue;
        while (cur.seg + 2 < pts.length) {
          const nxt = approach(c, cur.seg + 1);
          if (nxt.d >= cur.d) break;
          cur = nxt;
        }
        q = cur;
        break;
      }
    }
    if (q && q.d > o.controlReachM) q = null;
    pass.push(q);
    if (q) last = q.seg;
  }
  const missM = pass.flatMap((q) => (q ? [q.d] : []));

  // A leg is never left out for being slow: slow ground and a mistake look alike here, and the fit
  // weighs down the legs its model cannot explain (§7.9.4).
  const legs: LegObservation[] = [];
  for (let leg = 0; leg + 1 < controls.length; leg++) {
    const a = pass[leg], b = pass[leg + 1];
    if (!a || !b) { reject("control-missed"); continue; }
    if (b.t - a.t <= 0) { reject("too-short"); continue; }
    // The pass points with the fixes between them.
    const seg = [{ p: a.p, t: a.t }, ...pts.slice(a.seg + 1, b.seg + 1).filter((q) => q.t > a.t && q.t < b.t), { p: b.p, t: b.t }];
    const total = b.t - a.t;
    if (seg.some((q, i) => i > 0 && q.t - seg[i - 1].t > o.maxGapS)) { reject("gap"); continue; }
    const dropped = droppedAt.filter((t) => t > a.t && t < b.t).length;
    if (dropped / (seg.length + dropped) > o.maxDroppedShare) { reject("jitter"); continue; }
    const bnd = o.bounds;
    if (bnd && seg.some((q) => q.p.x < bnd.minX || q.p.x > bnd.maxX || q.p.y < bnd.minY || q.p.y > bnd.maxY)) { reject("off-map"); continue; }
    let standingS = 0;
    for (let i = 0; i < seg.length - 1;) {
      let j = i;
      while (j + 1 < seg.length && dist(seg[i].p, seg[j + 1].p) < o.standRadiusM) j++;
      if (j > i && seg[j].t - seg[i].t >= o.standMinS) { standingS += seg[j].t - seg[i].t; i = j; } else i++;
    }
    if (standingS / total > o.maxStandShare) { reject("standing"); continue; }
    legs.push({ leg, from: controls[leg], to: controls[leg + 1], points: seg.map((q) => q.p), timeS: total - standingS, standingS });
  }
  return { legs, rejected, missM };
}
