/**
 * Geometry helpers over `RenderPath`: segment iteration honouring the
 * Bézier flags, ring splitting at hole flags, bounds, Bézier splitting for
 * slices, and the shared hatch-line generator.
 *
 * All functions are pure and backend-independent; both the reference
 * raster and the PDF backend walk paths through these so they agree on
 * what a path *is* before either draws it.
 */

import { COORD_FLAG, type RenderPath, type Slice } from "./pass-stream.js";

export type Segment =
  | { kind: "line"; x0: number; y0: number; x1: number; y1: number }
  | {
      kind: "cubic";
      x0: number; y0: number;
      cx0: number; cy0: number;
      cx1: number; cy1: number;
      x1: number; y1: number;
    };

export interface Ring {
  /** Point indices [start, end) into the path. */
  start: number;
  end: number;
  hole: boolean;
}

/**
 * Splits a path into rings at `hole` flags. The first ring is the outer
 * boundary; every point carrying flag 16 starts a hole ring. A path
 * without hole flags is one ring.
 */
export function pathRings(path: RenderPath): Ring[] {
  const n = path.flags.length;
  const rings: Ring[] = [];
  let start = 0;
  for (let i = 1; i < n; i++) {
    if (path.flags[i] & COORD_FLAG.hole) {
      rings.push({ start, end: i, hole: rings.length > 0 });
      start = i;
    }
  }
  rings.push({ start, end: n, hole: rings.length > 0 });
  return rings;
}

/**
 * Segments of one ring, in order. Control points are consumed by the
 * anchor that follows them; a malformed run (a control point without a
 * second control + anchor) degrades to straight lines rather than
 * throwing, matching how OCAD itself renders such files.
 */
export function ringSegments(path: RenderPath, ring: Ring, closed = path.closed): Segment[] {
  const c = path.coords;
  const f = path.flags;
  const segs: Segment[] = [];
  const px = (i: number) => c[2 * i];
  const py = (i: number) => c[2 * i + 1];
  let i = ring.start;
  const last = ring.end - 1;
  while (i < last) {
    const next = i + 1;
    if (
      next + 2 <= last &&
      f[next] & COORD_FLAG.bezierFirst &&
      f[next + 1] & COORD_FLAG.bezierSecond
    ) {
      segs.push({
        kind: "cubic",
        x0: px(i), y0: py(i),
        cx0: px(next), cy0: py(next),
        cx1: px(next + 1), cy1: py(next + 1),
        x1: px(next + 2), y1: py(next + 2),
      });
      i = next + 2;
    } else {
      segs.push({ kind: "line", x0: px(i), y0: py(i), x1: px(next), y1: py(next) });
      i = next;
    }
  }
  if (closed && ring.end - ring.start > 1) {
    const fx = px(ring.start), fy = py(ring.start);
    const lx = px(last), ly = py(last);
    if (fx !== lx || fy !== ly) {
      segs.push({ kind: "line", x0: lx, y0: ly, x1: fx, y1: fy });
    }
  }
  return segs;
}

/** Segments of the whole path (all rings concatenated, in ring order). */
export function pathSegments(path: RenderPath): Segment[] {
  return pathRings(path).flatMap((r) => ringSegments(path, r));
}

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** Control-point bounds (a superset of the curve's true bounds). */
export function pathBounds(path: RenderPath): Bounds {
  const c = path.coords;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < c.length; i += 2) {
    const x = c[i], y = c[i + 1];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  if (c.length === 0) return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  return { minX, minY, maxX, maxY };
}

export function unionBounds(a: Bounds | undefined, b: Bounds): Bounds {
  if (!a) return { ...b };
  return {
    minX: Math.min(a.minX, b.minX),
    minY: Math.min(a.minY, b.minY),
    maxX: Math.max(a.maxX, b.maxX),
    maxY: Math.max(a.maxY, b.maxY),
  };
}

/** Point on a segment at parameter t ∈ [0, 1]. */
export function segmentPoint(s: Segment, t: number): [number, number] {
  if (s.kind === "line") {
    return [s.x0 + (s.x1 - s.x0) * t, s.y0 + (s.y1 - s.y0) * t];
  }
  const mt = 1 - t;
  const a = mt * mt * mt, b = 3 * mt * mt * t, c = 3 * mt * t * t, d = t * t * t;
  return [
    a * s.x0 + b * s.cx0 + c * s.cx1 + d * s.x1,
    a * s.y0 + b * s.cy0 + c * s.cy1 + d * s.y1,
  ];
}

/**
 * The part of a segment between t0 and t1 (de Casteljau for cubics), so
 * a dash on a curve is itself an exact curve.
 */
export function segmentSub(s: Segment, t0: number, t1: number): Segment {
  if (s.kind === "line") {
    const [x0, y0] = segmentPoint(s, t0);
    const [x1, y1] = segmentPoint(s, t1);
    return { kind: "line", x0, y0, x1, y1 };
  }
  // Split at t0, keep the right part; then split that at the rescaled t1.
  const right = splitCubic(s, t0)[1];
  const u = t0 === 1 ? 0 : (t1 - t0) / (1 - t0);
  return splitCubic(right, u)[0];
}

type Cubic = Extract<Segment, { kind: "cubic" }>;

function splitCubic(s: Cubic, t: number): [Cubic, Cubic] {
  const lerp = (a: number, b: number) => a + (b - a) * t;
  const ax = lerp(s.x0, s.cx0), ay = lerp(s.y0, s.cy0);
  const bx = lerp(s.cx0, s.cx1), by = lerp(s.cy0, s.cy1);
  const cx = lerp(s.cx1, s.x1), cy = lerp(s.cy1, s.y1);
  const abx = lerp(ax, bx), aby = lerp(ay, by);
  const bcx = lerp(bx, cx), bcy = lerp(by, cy);
  const mx = lerp(abx, bcx), my = lerp(aby, bcy);
  return [
    { kind: "cubic", x0: s.x0, y0: s.y0, cx0: ax, cy0: ay, cx1: abx, cy1: aby, x1: mx, y1: my },
    { kind: "cubic", x0: mx, y0: my, cx0: bcx, cy0: bcy, cx1: cx, cy1: cy, x1: s.x1, y1: s.y1 },
  ];
}

/**
 * Segments covered by a slice of a path. Segment indices refer to
 * `pathSegments(path)` ordering.
 */
export function sliceSegments(path: RenderPath, slice: Slice): Segment[] {
  const segs = pathSegments(path);
  if (slice.seg0 > slice.seg1 || (slice.seg0 === slice.seg1 && slice.t0 >= slice.t1)) {
    return [];
  }
  const out: Segment[] = [];
  for (let i = slice.seg0; i <= slice.seg1 && i < segs.length; i++) {
    const t0 = i === slice.seg0 ? slice.t0 : 0;
    const t1 = i === slice.seg1 ? slice.t1 : 1;
    if (t1 <= t0) continue;
    out.push(t0 === 0 && t1 === 1 ? segs[i] : segmentSub(segs[i], t0, t1));
  }
  return out;
}

/**
 * Arc length of a segment. Cubics use fixed-rule adaptive subdivision to
 * `toleranceUm` so the result does not depend on any backend's flattening.
 */
export function segmentLength(s: Segment, toleranceUm = 1): number {
  if (s.kind === "line") return Math.hypot(s.x1 - s.x0, s.y1 - s.y0);
  const chord = Math.hypot(s.x1 - s.x0, s.y1 - s.y0);
  const poly =
    Math.hypot(s.cx0 - s.x0, s.cy0 - s.y0) +
    Math.hypot(s.cx1 - s.cx0, s.cy1 - s.cy0) +
    Math.hypot(s.x1 - s.cx1, s.y1 - s.cy1);
  if (poly - chord <= toleranceUm) return (2 * chord + poly) / 3;
  const [l, r] = splitCubic(s, 0.5);
  return segmentLength(l, toleranceUm) + segmentLength(r, toleranceUm);
}

export interface HatchParams {
  spacingUm: number;
  offsetUm: number;
  angleDeg: number;
}

export interface HatchLine {
  x0: number; y0: number; x1: number; y1: number;
}

/**
 * Hatch lines covering `bounds`, to be clipped by the area by the caller.
 * Lines run along `angleDeg` (0 = +x, counter-clockwise in y-up paper
 * space) and are spaced `spacingUm` apart perpendicular to that direction,
 * with the family anchored so that a line passes through the paper origin
 * shifted by `offsetUm` — the OCAD convention, which makes adjacent areas
 * with the same symbol hatch continuously. The GL stripe shader samples
 * the same formula.
 */
export function hatchLines(bounds: Bounds, params: HatchParams): HatchLine[] {
  const a = (params.angleDeg * Math.PI) / 180;
  const dx = Math.cos(a), dy = Math.sin(a);     // along the line
  const nx = -dy, ny = dx;                       // perpendicular
  const corners: [number, number][] = [
    [bounds.minX, bounds.minY], [bounds.maxX, bounds.minY],
    [bounds.minX, bounds.maxY], [bounds.maxX, bounds.maxY],
  ];
  const proj = (x: number, y: number) => x * nx + y * ny;
  const along = (x: number, y: number) => x * dx + y * dy;
  const pMin = Math.min(...corners.map(([x, y]) => proj(x, y)));
  const pMax = Math.max(...corners.map(([x, y]) => proj(x, y)));
  const aMin = Math.min(...corners.map(([x, y]) => along(x, y)));
  const aMax = Math.max(...corners.map(([x, y]) => along(x, y)));
  const s = params.spacingUm;
  if (!(s > 0)) return [];
  const k0 = Math.ceil((pMin - params.offsetUm) / s);
  const k1 = Math.floor((pMax - params.offsetUm) / s);
  const lines: HatchLine[] = [];
  for (let k = k0; k <= k1; k++) {
    const p = params.offsetUm + k * s;
    lines.push({
      x0: nx * p + dx * aMin, y0: ny * p + dy * aMin,
      x1: nx * p + dx * aMax, y1: ny * p + dy * aMax,
    });
  }
  return lines;
}
