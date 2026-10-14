/**
 * Arc-length parametrisation of a `RenderPath`, and the section split that
 * every along-the-line layout (dashes, spaced glyphs) starts from.
 *
 * Lengths are computed by fixed-rule subdivision of each segment so the
 * result is a property of the stage, not of any backend's flattening
 * (04 §4.3). Cubics are sampled at `piecesFor(chord)` uniform parameter
 * steps; inversion (length → t) is linear within a piece. The error is
 * well under 1 µm for map-scale curves, and — more importantly — it is
 * the same error everywhere.
 */

import { COORD_FLAG, type RenderPath, type Slice } from "./pass-stream.js";
import { type Segment, pathSegments, segmentPoint } from "./path.js";

export interface PointOnPath {
  seg: number;
  t: number;
  x: number;
  y: number;
  /** Unit tangent. */
  tx: number;
  ty: number;
}

/** Parameter samples per cubic as a function of its control-polygon length (µm). */
function piecesFor(polyLenUm: number): number {
  return Math.min(256, Math.max(8, Math.ceil(polyLenUm / 100)));
}

interface SegTable {
  /** Cumulative length at sample i (0 … pieces), from segment start. */
  cum: Float64Array;
  pieces: number;
}

export class PathMeasure {
  readonly segments: Segment[];
  /** Cumulative length at the start of each segment, plus total at the end. */
  readonly cumulative: Float64Array;
  readonly totalLength: number;
  /** Point index at which each segment starts (for flag lookup). */
  readonly segmentStartPoint: Int32Array;
  private readonly tables: (SegTable | null)[];
  readonly path: RenderPath;

  constructor(path: RenderPath) {
    this.path = path;
    this.segments = pathSegments(path);
    const n = this.segments.length;
    this.cumulative = new Float64Array(n + 1);
    this.tables = new Array(n).fill(null);
    this.segmentStartPoint = new Int32Array(n);
    // Map segments back to their starting point index by replaying the
    // same walk `ringSegments` does (anchors advance by 1 or 3 points).
    let pt = 0;
    const f = path.flags;
    for (let i = 0; i < n; i++) {
      this.segmentStartPoint[i] = pt;
      const s = this.segments[i];
      if (s.kind === "cubic") pt += 3;
      else {
        // A closing segment starts at the last point and returns to the
        // first; it does not advance past the end.
        pt = Math.min(pt + 1, f.length - 1);
      }
    }
    let acc = 0;
    for (let i = 0; i < n; i++) {
      acc += this.segmentLength(i);
      this.cumulative[i + 1] = acc;
    }
    this.totalLength = acc;
  }

  private table(i: number): SegTable | null {
    const s = this.segments[i];
    if (s.kind === "line") return null;
    let tb = this.tables[i];
    if (!tb) {
      const poly =
        Math.hypot(s.cx0 - s.x0, s.cy0 - s.y0) +
        Math.hypot(s.cx1 - s.cx0, s.cy1 - s.cy0) +
        Math.hypot(s.x1 - s.cx1, s.y1 - s.cy1);
      const pieces = piecesFor(poly);
      const cum = new Float64Array(pieces + 1);
      let [px, py] = [s.x0, s.y0];
      for (let k = 1; k <= pieces; k++) {
        const [x, y] = segmentPoint(s, k / pieces);
        cum[k] = cum[k - 1] + Math.hypot(x - px, y - py);
        px = x;
        py = y;
      }
      tb = { cum, pieces };
      this.tables[i] = tb;
    }
    return tb;
  }

  segmentLength(i: number): number {
    const s = this.segments[i];
    if (s.kind === "line") return Math.hypot(s.x1 - s.x0, s.y1 - s.y0);
    const tb = this.table(i)!;
    return tb.cum[tb.pieces];
  }

  /** Length from the path start to parameter t of segment i. */
  lengthAt(i: number, t: number): number {
    const s = this.segments[i];
    const base = this.cumulative[i];
    if (s.kind === "line") return base + t * this.segmentLength(i);
    const tb = this.table(i)!;
    const u = t * tb.pieces;
    const k = Math.min(tb.pieces - 1, Math.floor(u));
    const frac = u - k;
    return base + tb.cum[k] + (tb.cum[k + 1] - tb.cum[k]) * frac;
  }

  /**
   * Parameter (segment, t) at a length from the path start; clamped to
   * the path. Exactly on a segment boundary, `preferEnd` resolves to
   * (previous segment, 1) instead of (next segment, 0) — used for the end
   * of a slice so a slice never spills into a segment it does not cover.
   */
  paramAt(len: number, preferEnd = false): { seg: number; t: number } {
    const n = this.segments.length;
    if (n === 0) return { seg: 0, t: 0 };
    if (len <= 0) return { seg: 0, t: 0 };
    if (len >= this.totalLength) return { seg: n - 1, t: 1 };
    // Binary search the segment.
    let lo = 0, hi = n - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.cumulative[mid] <= len) lo = mid;
      else hi = mid - 1;
    }
    if (preferEnd && lo > 0 && this.cumulative[lo] === len) return { seg: lo - 1, t: 1 };
    const seg = lo;
    const local = len - this.cumulative[seg];
    const s = this.segments[seg];
    if (s.kind === "line") {
      const L = this.segmentLength(seg);
      return { seg, t: L === 0 ? 0 : Math.min(1, local / L) };
    }
    const tb = this.table(seg)!;
    let k = 0, kh = tb.pieces - 1;
    while (k < kh) {
      const mid = (k + kh + 1) >> 1;
      if (tb.cum[mid] <= local) k = mid;
      else kh = mid - 1;
    }
    const span = tb.cum[k + 1] - tb.cum[k];
    const frac = span === 0 ? 0 : (local - tb.cum[k]) / span;
    return { seg, t: Math.min(1, (k + frac) / tb.pieces) };
  }

  pointAt(len: number): PointOnPath {
    const { seg, t } = this.paramAt(len);
    const s = this.segments[seg];
    const [x, y] = segmentPoint(s, t);
    const [tx, ty] = this.tangentAt(seg, t);
    return { seg, t, x, y, tx, ty };
  }

  tangentAt(seg: number, t: number): [number, number] {
    const s = this.segments[seg];
    let dx: number, dy: number;
    if (s.kind === "line") {
      dx = s.x1 - s.x0;
      dy = s.y1 - s.y0;
    } else {
      const mt = 1 - t;
      dx = 3 * mt * mt * (s.cx0 - s.x0) + 6 * mt * t * (s.cx1 - s.cx0) + 3 * t * t * (s.x1 - s.cx1);
      dy = 3 * mt * mt * (s.cy0 - s.y0) + 6 * mt * t * (s.cy1 - s.cy0) + 3 * t * t * (s.y1 - s.cy1);
      if (dx === 0 && dy === 0) {
        // Degenerate derivative at a cusp / coincident control point: fall back to the chord.
        const [ax, ay] = segmentPoint(s, Math.max(0, t - 0.01));
        const [bx, by] = segmentPoint(s, Math.min(1, t + 0.01));
        dx = bx - ax;
        dy = by - ay;
      }
    }
    const l = Math.hypot(dx, dy);
    return l === 0 ? [1, 0] : [dx / l, dy / l];
  }

  /** Slice between two lengths from the path start. */
  sliceBetween(l0: number, l1: number): Slice {
    const a = this.paramAt(l0);
    const b = this.paramAt(l1, true);
    return { seg0: a.seg, t0: a.t, seg1: b.seg, t1: b.t };
  }

  /** Length positions of points carrying any of `mask`, in path order (excluding the first point). */
  flaggedLengths(mask: number): number[] {
    const out: number[] = [];
    const f = this.path.flags;
    for (let i = 0; i < this.segments.length; i++) {
      const p = this.segmentStartPoint[i];
      if (i > 0 && f[p] & mask) out.push(this.cumulative[i]);
    }
    return out;
  }
}

export interface Section {
  startLen: number;
  endLen: number;
  /** True when both ends of this section are the same point of a closed path with no split points. */
  closedLoop: boolean;
}

/**
 * Splits a path into layout sections at corner (4) and dash (8) points —
 * both reset dash and glyph layout (03 §6.9 item 1). A closed path without
 * split points is one `closedLoop` section; a closed path with split
 * points is cut at them, and the final section wraps through the start
 * point as its own section (the start point is not an implicit split).
 */
export function pathSections(m: PathMeasure, mask: number = COORD_FLAG.corner | COORD_FLAG.dash): Section[] {
  const L = m.totalLength;
  const cuts = m.flaggedLengths(mask).filter((l) => l > 0 && l < L);
  if (cuts.length === 0) return [{ startLen: 0, endLen: L, closedLoop: m.path.closed }];
  const out: Section[] = [];
  let prev = 0;
  for (const c of cuts) {
    if (c > prev) out.push({ startLen: prev, endLen: c, closedLoop: false });
    prev = c;
  }
  if (L > prev) out.push({ startLen: prev, endLen: L, closedLoop: false });
  return out;
}

/** Removes the `[from, to]` length intervals (gap points, flag 128) from a list of intervals. */
export function subtractIntervals(
  intervals: [number, number][],
  holes: [number, number][],
): [number, number][] {
  let cur = intervals;
  for (const [h0, h1] of holes) {
    const next: [number, number][] = [];
    for (const [a, b] of cur) {
      if (h1 <= a || h0 >= b) next.push([a, b]);
      else {
        if (h0 > a) next.push([a, h0]);
        if (h1 < b) next.push([h1, b]);
      }
    }
    cur = next;
  }
  return cur;
}

/** Length intervals between gap points (flag 128): from a gap point to the next one. */
export function gapIntervals(m: PathMeasure): [number, number][] {
  const f = m.path.flags;
  const out: [number, number][] = [];
  let open: number | null = null;
  for (let i = 0; i < m.segments.length; i++) {
    const p = m.segmentStartPoint[i];
    if (f[p] & COORD_FLAG.gap) {
      const l = m.cumulative[i];
      if (open === null) open = l;
      else {
        out.push([open, l]);
        open = null;
      }
    }
  }
  const lastPt = f.length - 1;
  if (open !== null && f[lastPt] & COORD_FLAG.gap) out.push([open, m.totalLength]);
  return out;
}
