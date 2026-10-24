/**
 * Polygon helpers used by the stage's inclusion decisions and border
 * construction: flattening at a fixed tolerance, even-odd point-in-
 * polygon over rings, and polyline offsetting.
 *
 * Flattening here is a *stage* decision (the tolerance is in µm on paper
 * and the same for every backend), used only where the stage must reason
 * about area (pattern inclusion) or produce offset geometry (borders).
 * Objects' own paths stay as Béziers in the stream.
 */

import { COORD_FLAG, type RenderPath, type Slice, type StrokeJoin, makePath } from "./pass-stream.js";
import {
  type Segment,
  pathRings,
  pathSegments,
  ringSegments,
  segmentLength,
  segmentPoint,
  segmentSub,
  sliceSegments,
} from "./path.js";

/** Flattened ring: x,y pairs, not repeating the first point at the end. */
export type FlatRing = number[];

function flattenSegment(s: Segment, toleranceUm: number, out: number[]): void {
  if (s.kind === "line") {
    out.push(s.x1, s.y1);
    return;
  }
  // Pieces from the control polygon's deviation from the chord (conservative, deterministic).
  const dev =
    Math.hypot(s.cx0 - s.x0, s.cy0 - s.y0) +
    Math.hypot(s.cx1 - s.cx0, s.cy1 - s.cy0) +
    Math.hypot(s.x1 - s.cx1, s.y1 - s.cy1) -
    Math.hypot(s.x1 - s.x0, s.y1 - s.y0);
  const pieces = Math.min(256, Math.max(1, Math.ceil(Math.sqrt(dev / Math.max(0.01, toleranceUm)) * 2)));
  for (let k = 1; k <= pieces; k++) {
    const [x, y] = segmentPoint(s, k / pieces);
    out.push(x, y);
  }
}

/** Flattens a segment run into one polyline (x,y pairs, first point included). */
export function flattenSegments(segs: Segment[], toleranceUm = 5): number[] {
  if (segs.length === 0) return [];
  const out: number[] = [segs[0].x0, segs[0].y0];
  for (const s of segs) flattenSegment(s, toleranceUm, out);
  return out;
}

/** Flattens each ring of a path. Open paths produce one polyline (first point included). */
export function flattenRings(path: RenderPath, toleranceUm = 5): FlatRing[] {
  return pathRings(path).map((ring) => {
    const segs = ringSegments(path, ring, false);
    const out: number[] = [];
    if (segs.length === 0) {
      if (ring.end > ring.start) out.push(path.coords[2 * ring.start], path.coords[2 * ring.start + 1]);
      return out;
    }
    out.push(segs[0].x0, segs[0].y0);
    for (const s of segs) flattenSegment(s, toleranceUm, out);
    // Closed rings: drop a duplicated end point.
    if (path.closed && out.length >= 4) {
      const n = out.length;
      if (out[0] === out[n - 2] && out[1] === out[n - 1]) out.length = n - 2;
    }
    return out;
  });
}

/** Even-odd point-in-polygon over several rings (holes are just more rings). */
export function pointInRings(rings: FlatRing[], x: number, y: number): boolean {
  let inside = false;
  for (const r of rings) {
    const n = r.length / 2;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const xi = r[2 * i], yi = r[2 * i + 1];
      const xj = r[2 * j], yj = r[2 * j + 1];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}

/** True if segment (a,b) and (c,d) properly intersect or touch. */
function segmentsIntersect(ax: number, ay: number, bx: number, by: number, cx: number, cy: number, dx: number, dy: number): boolean {
  const o = (px: number, py: number, qx: number, qy: number, rx: number, ry: number) => {
    const v = (qy - py) * (rx - qx) - (qx - px) * (ry - qy);
    return v > 0 ? 1 : v < 0 ? -1 : 0;
  };
  const on = (px: number, py: number, qx: number, qy: number, rx: number, ry: number) =>
    Math.min(px, rx) <= qx && qx <= Math.max(px, rx) && Math.min(py, ry) <= qy && qy <= Math.max(py, ry);
  const o1 = o(ax, ay, bx, by, cx, cy), o2 = o(ax, ay, bx, by, dx, dy);
  const o3 = o(cx, cy, dx, dy, ax, ay), o4 = o(cx, cy, dx, dy, bx, by);
  if (o1 !== o2 && o3 !== o4) return true;
  if (o1 === 0 && on(ax, ay, cx, cy, bx, by)) return true;
  if (o2 === 0 && on(ax, ay, dx, dy, bx, by)) return true;
  if (o3 === 0 && on(cx, cy, ax, ay, dx, dy)) return true;
  if (o4 === 0 && on(cx, cy, bx, by, dx, dy)) return true;
  return false;
}

/** Does any edge of `rings` cross any edge of the convex quad `quad` (x,y ×4)? */
export function ringsCrossQuad(rings: FlatRing[], quad: number[]): boolean {
  for (const r of rings) {
    const n = r.length / 2;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      for (let q = 0; q < 4; q++) {
        const q2 = (q + 1) % 4;
        if (segmentsIntersect(r[2 * j], r[2 * j + 1], r[2 * i], r[2 * i + 1], quad[2 * q], quad[2 * q + 1], quad[2 * q2], quad[2 * q2 + 1])) {
          return true;
        }
      }
    }
  }
  return false;
}

/** Shoelace area of a flat ring (signed, +ve counter-clockwise in y-up). */
export function ringArea(r: FlatRing): number {
  let a = 0;
  const n = r.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) a += r[2 * j] * r[2 * i + 1] - r[2 * i] * r[2 * j + 1];
  return a / 2;
}

/**
 * Offsets an open polyline by `d` to its left (+d) or right (−d) with
 * mitred joins (mitre limited to 4× the offset, then bevelled). Returns
 * x,y pairs. Used for line-symbol borders, whose paths are therefore
 * polylines flattened at 5 µm — invisible on paper, and identical in
 * every backend.
 */
export function offsetPolyline(pts: number[], d: number, closed = false): number[] {
  const n = pts.length / 2;
  if (n < 2) return pts.slice();
  const px = (i: number) => pts[2 * ((i + n) % n)];
  const py = (i: number) => pts[2 * ((i + n) % n) + 1];
  const normal = (i: number, j: number): [number, number] => {
    const dx = px(j) - px(i), dy = py(j) - py(i);
    const l = Math.hypot(dx, dy) || 1;
    return [-dy / l, dx / l];
  };
  const out: number[] = [];
  const limit = 4 * Math.abs(d);
  for (let i = 0; i < n; i++) {
    const hasPrev = closed || i > 0;
    const hasNext = closed || i < n - 1;
    if (!hasPrev) {
      const [nx, ny] = normal(i, i + 1);
      out.push(px(i) + nx * d, py(i) + ny * d);
    } else if (!hasNext) {
      const [nx, ny] = normal(i - 1, i);
      out.push(px(i) + nx * d, py(i) + ny * d);
    } else {
      const [n0x, n0y] = normal(i - 1, i);
      const [n1x, n1y] = normal(i, i + 1);
      const mx = n0x + n1x, my = n0y + n1y;
      const ml = Math.hypot(mx, my);
      if (ml < 1e-9) {
        out.push(px(i) + n0x * d, py(i) + n0y * d);
        continue;
      }
      const cosHalf = ml / 2;
      const mitre = d / cosHalf;
      if (Math.abs(mitre) <= limit) {
        out.push(px(i) + (mx / ml) * mitre, py(i) + (my / ml) * mitre);
      } else {
        out.push(px(i) + n0x * d, py(i) + n0y * d, px(i) + n1x * d, py(i) + n1y * d);
      }
    }
  }
  return out;
}

/**
 * Rounds the polyline corners of a path with circular arcs of radius
 * `radiusUm`, one cubic Bézier per corner (OCAD rectangle symbols'
 * corner radius, map-rendering §4.4). A corner is an anchor between two
 * straight segments; points next to Bézier control points, the ends of
 * an open path, collinear points and full reversals are left alone. Where
 * the radius does not fit, it shrinks so that the arc takes at most half
 * of each adjacent edge. Rings (hole flag 16) are rounded separately;
 * a closed ring's duplicated closing point is dropped. The arc's first
 * point keeps the corner's flags (minus Bézier bits).
 */
export function roundCorners(path: RenderPath, radiusUm: number): RenderPath {
  if (!(radiusUm > 0)) return path;
  const n = path.flags.length;
  const starts: number[] = [];
  for (let i = 0; i < n; i++) if (i === 0 || path.flags[i] & COORD_FLAG.hole) starts.push(i);
  const coords: number[] = [];
  const flags: number[] = [];
  const BEZ = COORD_FLAG.bezierFirst | COORD_FLAG.bezierSecond;
  const KAPPA_ARC = (theta: number) => (4 / 3) * Math.tan(theta / 4);
  starts.forEach((s, ri) => {
    let e = ri + 1 < starts.length ? starts[ri + 1] : n;
    const X = (i: number) => path.coords[2 * i], Y = (i: number) => path.coords[2 * i + 1];
    // A closed ring may repeat its first point at the end.
    if (path.closed && e - s > 2 && X(e - 1) === X(s) && Y(e - 1) === Y(s)) e--;
    const m = e - s;
    const at = (k: number) => s + ((k % m) + m) % m;
    for (let k = 0; k < m; k++) {
      const i = s + k;
      const f = path.flags[i];
      const endOfOpen = !path.closed && (k === 0 || k === m - 1);
      const p = at(k - 1), q = at(k + 1);
      const plain = (f & BEZ) === 0 && (path.flags[p] & BEZ) === 0 && (path.flags[q] & BEZ) === 0 && m >= 3;
      if (endOfOpen || !plain) {
        coords.push(X(i), Y(i));
        flags.push(f);
        continue;
      }
      const ax = X(i) - X(p), ay = Y(i) - Y(p), bx = X(q) - X(i), by = Y(q) - Y(i);
      const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by);
      const turn = la > 0 && lb > 0 ? Math.acos(Math.max(-1, Math.min(1, (ax * bx + ay * by) / (la * lb)))) : 0;
      if (turn < 1e-6 || turn > Math.PI - 1e-3) {
        coords.push(X(i), Y(i));
        flags.push(f);
        continue;
      }
      // Tangent length t = r·tan(turn/2), at most half of each edge.
      const t = Math.min(radiusUm * Math.tan(turn / 2), la / 2, lb / 2);
      const r = t / Math.tan(turn / 2);
      const h = r * KAPPA_ARC(turn);
      const ux = ax / la, uy = ay / la, vx = bx / lb, vy = by / lb;
      const p1x = X(i) - t * ux, p1y = Y(i) - t * uy;
      const p2x = X(i) + t * vx, p2y = Y(i) + t * vy;
      coords.push(p1x, p1y, p1x + h * ux, p1y + h * uy, p2x - h * vx, p2y - h * vy, p2x, p2y);
      flags.push(f & ~BEZ, COORD_FLAG.bezierFirst, COORD_FLAG.bezierSecond, 0);
    }
  });
  return makePath(coords.map(Math.round), flags, path.closed);
}

export interface StrokeOutlineOptions {
  widthUm: number;
  join: StrokeJoin;
  /** Linear width taper over the first / last `n` µm of the whole path (map-rendering §3.2). */
  taper?: { startUm?: number; endUm?: number };
  /** Dash slices; each is outlined on its own, the taper still measured along the whole path. */
  slices?: Slice[];
  toleranceUm?: number;
}

/** Mitre limit shared by every backend: mitre length ≤ 4 × width (SVG and PDF `4 M`). */
export const STROKE_MITRE_LIMIT = 4;

/**
 * A stroke as fill geometry, for what PDF and SVG strokes cannot draw:
 * `pointed` caps with a `taper` (map-rendering §3.2, research 05 §5.3).
 * The width falls linearly to 0 over `taper.startUm` from the path's
 * start and `taper.endUm` towards its end, measured along the whole path
 * (also when only slices are drawn); the ends are butt.
 *
 * The result is a set of closed rings — one quad per flattened piece and
 * one wedge per join — all counter-clockwise, to be filled with the
 * **non-zero** rule (their union; even-odd would cut the overlaps out).
 * Curves are flattened at the stage tolerance (5 µm); coordinates are
 * integer µm. The PDF backend and the reference raster both fill this,
 * so a taper looks the same in both.
 */
export function strokeOutline(path: RenderPath, opts: StrokeOutlineOptions): RenderPath {
  const tol = opts.toleranceUm ?? 5;
  const half = opts.widthUm / 2;
  const segs = pathSegments(path);
  const cum: number[] = [0];
  for (const s of segs) cum.push(cum[cum.length - 1] + segmentLength(s));
  const total = cum[segs.length];
  const t0 = opts.taper?.startUm ?? 0;
  const t1 = opts.taper?.endUm ?? 0;
  const halfAt = (s: number): number => {
    let f = 1;
    if (t0 > 0) f = Math.min(f, s / t0);
    if (t1 > 0) f = Math.min(f, (total - s) / t1);
    return half * Math.max(0, Math.min(1, f));
  };
  const breaks = [t0, total - t1].filter((b) => b > 0 && b < total);

  const rings: number[][] = [];
  const addRing = (pts: number[]) => {
    const r = pts.map(Math.round);
    const a = ringArea(r);
    if (Math.abs(a) < 1e-9) return;
    if (a < 0) {
      const rev: number[] = [];
      for (let i = r.length - 2; i >= 0; i -= 2) rev.push(r[i], r[i + 1]);
      rings.push(rev);
    } else rings.push(r);
  };

  /** Outlines one run of segments starting at arc length `s0`; `closed` adds the closing join. */
  const outlineRun = (run: Segment[], s0: number, closed: boolean) => {
    const flat = flattenSegments(run, tol);
    if (flat.length < 4) return;
    // Points with their arc length, taper breakpoints inserted.
    const xs: number[] = [flat[0]], ys: number[] = [flat[1]], ss: number[] = [s0];
    for (let i = 2; i < flat.length; i += 2) {
      const px = xs[xs.length - 1], py = ys[ys.length - 1], ps = ss[ss.length - 1];
      const len = Math.hypot(flat[i] - px, flat[i + 1] - py);
      if (len === 0) continue;
      for (const b of breaks) {
        if (b > ps && b < ps + len) {
          const f = (b - ps) / len;
          xs.push(px + (flat[i] - px) * f);
          ys.push(py + (flat[i + 1] - py) * f);
          ss.push(b);
        }
      }
      xs.push(flat[i]);
      ys.push(flat[i + 1]);
      ss.push(ps + len);
    }
    const n = xs.length;
    if (n < 2) return;
    const dir = (i: number): [number, number] => {
      const dx = xs[i + 1] - xs[i], dy = ys[i + 1] - ys[i];
      const l = Math.hypot(dx, dy) || 1;
      return [dx / l, dy / l];
    };
    for (let i = 0; i + 1 < n; i++) {
      const [dx, dy] = dir(i);
      const nx = -dy, ny = dx;
      const h0 = halfAt(ss[i]), h1 = halfAt(ss[i + 1]);
      if (h0 === 0 && h1 === 0) continue;
      addRing([
        xs[i] + nx * h0, ys[i] + ny * h0,
        xs[i] - nx * h0, ys[i] - ny * h0,
        xs[i + 1] - nx * h1, ys[i + 1] - ny * h1,
        xs[i + 1] + nx * h1, ys[i + 1] + ny * h1,
      ]);
    }
    const joinAt = (i: number, d0: [number, number], d1: [number, number]) => {
      const h = halfAt(ss[i]);
      if (h === 0) return;
      const cross = d0[0] * d1[1] - d0[1] * d1[0];
      const dot = d0[0] * d1[0] + d0[1] * d1[1];
      const turn = Math.atan2(cross, dot);
      if (Math.abs(turn) < 1e-6) return;
      // Outer side: right of the path on a left turn, left on a right turn.
      const side = cross > 0 ? -1 : 1;
      const ax = xs[i] - d0[1] * h * side, ay = ys[i] + d0[0] * h * side;
      const bx = xs[i] - d1[1] * h * side, by = ys[i] + d1[0] * h * side;
      const pts = [xs[i], ys[i], ax, ay];
      if (opts.join === "round") {
        const a0 = Math.atan2(ay - ys[i], ax - xs[i]);
        const steps = Math.max(1, Math.ceil(Math.abs(turn) / (2 * Math.acos(Math.max(-1, 1 - tol / h)))));
        for (let k = 1; k < steps; k++) {
          const a = a0 + (turn * k) / steps;
          pts.push(xs[i] + Math.cos(a) * h, ys[i] + Math.sin(a) * h);
        }
      } else if (opts.join === "miter") {
        const ratio = 1 / Math.cos(turn / 2);
        if (ratio <= STROKE_MITRE_LIMIT) {
          const mx = (ax + bx) / 2 - xs[i], my = (ay + by) / 2 - ys[i];
          const ml = Math.hypot(mx, my) || 1;
          pts.push(xs[i] + (mx / ml) * h * ratio, ys[i] + (my / ml) * h * ratio);
        }
      }
      pts.push(bx, by);
      addRing(pts);
    };
    for (let i = 1; i + 1 < n; i++) joinAt(i, dir(i - 1), dir(i));
    if (closed && n > 2 && xs[0] === xs[n - 1] && ys[0] === ys[n - 1]) joinAt(0, dir(n - 2), dir(0));
  };

  if (opts.slices) {
    for (const sl of opts.slices) {
      const run = sliceSegments(path, sl);
      if (run.length === 0 || sl.seg0 >= segs.length) continue;
      const s0 = cum[sl.seg0] + (sl.t0 > 0 ? segmentLength(segmentSub(segs[sl.seg0], 0, sl.t0)) : 0);
      outlineRun(run, s0, false);
    }
  } else {
    let s0 = 0;
    for (const ring of pathRings(path)) {
      const run = ringSegments(path, ring);
      outlineRun(run, s0, path.closed);
      for (const s of run) s0 += segmentLength(s);
    }
  }

  const coords: number[] = [];
  const flags: number[] = [];
  rings.forEach((r, k) => {
    for (let i = 0; i < r.length; i += 2) {
      coords.push(r[i], r[i + 1]);
      flags.push(i === 0 && k > 0 ? COORD_FLAG.hole : 0);
    }
  });
  return makePath(coords, flags, true);
}
