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

import type { RenderPath } from "./pass-stream.js";
import { type Segment, pathRings, ringSegments, segmentPoint } from "./path.js";

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
