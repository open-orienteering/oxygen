/**
 * Object geometry → flat polylines in paper mm (docs/map-terrain.md §1.4).
 */

import type { MapDocument } from "../../map-document/codec.js";
import { pathRings, ringSegments, segmentPoint } from "../../render/path.js";
import type { RenderPath } from "../../render/pass-stream.js";

/** Chord length a cubic is cut into, mm (clamped to 3–24 chords). */
const CUBIC_CHORD_MM = 0.25;

/**
 * The parts of object `i` (an area's rings, split at hole flags), each a
 * flat `[x0, y0, x1, y1, …]` in paper mm with Béziers cut into chords.
 */
export function flattenObject(doc: MapDocument, i: number): Float64Array[] {
  const s = doc.coordStart[i];
  const e = doc.coordStart[i + 1];
  if (e <= s) return [];
  const path: RenderPath = { coords: doc.coords.subarray(s * 2, e * 2), flags: doc.flags.subarray(s, e), closed: false };
  const u = 1 / doc.header.unitsPerMm;
  const parts: Float64Array[] = [];
  for (const ring of pathRings(path)) {
    const out: number[] = [path.coords[ring.start * 2] * u, path.coords[ring.start * 2 + 1] * u];
    for (const seg of ringSegments(path, ring, false)) {
      if (seg.kind === "line") {
        out.push(seg.x1 * u, seg.y1 * u);
        continue;
      }
      const approx =
        (Math.hypot(seg.cx0 - seg.x0, seg.cy0 - seg.y0) + Math.hypot(seg.cx1 - seg.cx0, seg.cy1 - seg.cy0) + Math.hypot(seg.x1 - seg.cx1, seg.y1 - seg.cy1)) * u;
      const n = Math.max(3, Math.min(24, Math.ceil(approx / CUBIC_CHORD_MM)));
      for (let j = 1; j <= n; j++) {
        const [x, y] = segmentPoint(seg, j / n);
        out.push(x * u, y * u);
      }
    }
    parts.push(Float64Array.from(out));
  }
  return parts;
}

/** Length of a flat polyline (open). */
export function polylineLength(p: ArrayLike<number>): number {
  let l = 0;
  for (let i = 2; i < p.length; i += 2) l += Math.hypot(p[i] - p[i - 2], p[i + 1] - p[i - 1]);
  return l;
}

/**
 * Walks a polyline at a fixed step (the first sample half a step in),
 * calling `f(x, y, tx, ty)` with the unit tangent of the segment.
 */
export function walkPolyline(p: ArrayLike<number>, closed: boolean, step: number, f: (x: number, y: number, tx: number, ty: number) => void): void {
  const n = p.length / 2;
  let carry = step / 2;
  for (let i = 0; i < n - 1 + (closed ? 1 : 0); i++) {
    const j = (i + 1) % n;
    const x1 = p[i * 2], y1 = p[i * 2 + 1];
    const dx = p[j * 2] - x1, dy = p[j * 2 + 1] - y1;
    const l = Math.hypot(dx, dy);
    if (l < 1e-9) continue;
    while (carry <= l) {
      f(x1 + (dx * carry) / l, y1 + (dy * carry) / l, dx / l, dy / l);
      carry += step;
    }
    carry -= l;
  }
}

/** An end of a polyline: the end point and its outward unit tangent. */
export interface PolylineEnd {
  x: number;
  y: number;
  tx: number;
  ty: number;
}

/** Arc length the end tangent is measured over, mm. */
const END_TANGENT_MM = 0.6;

/** The start (`which` 0) or end (1) of a polyline with the outward tangent over 0.6 mm (§2.1). */
export function polylineEnd(p: ArrayLike<number>, which: 0 | 1): PolylineEnd {
  const n = p.length / 2;
  const at = (i: number) => (which ? n - 1 - i : i);
  const x = p[at(0) * 2], y = p[at(0) * 2 + 1];
  let px = x, py = y, acc = 0;
  for (let i = 1; i < n; i++) {
    const qx = p[at(i) * 2], qy = p[at(i) * 2 + 1];
    acc += Math.hypot(qx - px, qy - py);
    px = qx;
    py = qy;
    if (acc >= END_TANGENT_MM) break;
  }
  const l = Math.hypot(x - px, y - py) || 1;
  return { x, y, tx: (x - px) / l, ty: (y - py) / l };
}
