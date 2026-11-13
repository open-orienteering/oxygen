/**
 * Resampling, smoothing and simplification of a projected track
 * (docs/map-gps-tracks.md §3.3–3.4). A converted line is a polyline:
 * smoothed, then Douglas–Peucker (SLICES.md slice G, "Decided in this
 * split"). Pure and deterministic: float arithmetic in a fixed order, no
 * randomness, inputs never mutated — the same track gives the same bytes
 * on every device.
 */

import type { ProjectedTrack } from "./project.js";

export const DEFAULT_STEP_M = 2;
export const DEFAULT_WINDOW_M = 10;
export const DEFAULT_TOLERANCE_MM = 0.1;

export interface SmoothOptions {
  /** Resampling step along the line, ground metres. Default 2. */
  stepM?: number;
  /** Full width of the averaging window, ground metres. Default 10. */
  windowM?: number;
}

function copy(line: ProjectedTrack): ProjectedTrack {
  return { x: Float64Array.from(line.x), y: Float64Array.from(line.y), metresPerMm: line.metresPerMm };
}

/** The line without consecutive duplicate points. */
function dedupe(line: ProjectedTrack): { x: number[]; y: number[] } {
  const x: number[] = [], y: number[] = [];
  for (let i = 0; i < line.x.length; i++) {
    const n = x.length;
    if (n > 0 && x[n - 1] === line.x[i] && y[n - 1] === line.y[i]) continue;
    x.push(line.x[i]);
    y.push(line.y[i]);
  }
  return { x, y };
}

/**
 * Resample by arc length: consecutive duplicates dropped, the line of
 * length L divided into `max(1, ceil(L / step))` equal intervals, so both
 * ends are exact and the spacing is at most `stepM` ground metres. A line
 * with fewer than two distinct points comes back unchanged.
 */
export function resampleTrack(line: ProjectedTrack, stepM: number = DEFAULT_STEP_M): ProjectedTrack {
  if (!(stepM > 0)) throw new RangeError(`Resampling step must be positive (got ${stepM})`);
  const { x, y } = dedupe(line);
  const m = x.length;
  if (m < 2) return copy(line);
  const s = new Float64Array(m);
  for (let i = 1; i < m; i++) s[i] = s[i - 1] + Math.hypot(x[i] - x[i - 1], y[i] - y[i - 1]);
  const total = s[m - 1];
  const intervals = Math.max(1, Math.ceil(total / (stepM / line.metresPerMm)));
  const ox = new Float64Array(intervals + 1), oy = new Float64Array(intervals + 1);
  ox[0] = x[0];
  oy[0] = y[0];
  let seg = 1;
  for (let k = 1; k < intervals; k++) {
    // k · total / intervals, not repeated addition, so positions do not drift.
    const at = (k * total) / intervals;
    while (seg < m - 1 && s[seg] < at) seg++;
    const len = s[seg] - s[seg - 1];
    const t = len > 0 ? (at - s[seg - 1]) / len : 0;
    ox[k] = x[seg - 1] + (x[seg] - x[seg - 1]) * t;
    oy[k] = y[seg - 1] + (y[seg] - y[seg - 1]) * t;
  }
  ox[intervals] = x[m - 1];
  oy[intervals] = y[m - 1];
  return { x: ox, y: oy, metresPerMm: line.metresPerMm };
}

/**
 * Symmetric triangular moving average of half-width `K` samples (weights
 * K + 1 − |j|, so 1, 2, 3, 2, 1 for K = 2). At sample i the half-width is
 * min(K, i, n − 1 − i): the window shrinks symmetrically near the ends, so
 * the ends stay exactly where they are and a straight, evenly sampled
 * line is a fixed point.
 */
export function movingAverage(line: ProjectedTrack, K: number): ProjectedTrack {
  const n = line.x.length;
  if (n < 3 || K < 1) return copy(line);
  const ox = new Float64Array(n), oy = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const h = Math.min(K, i, n - 1 - i);
    let sx = 0, sy = 0, sw = 0;
    for (let j = -h; j <= h; j++) {
      const w = K + 1 - Math.abs(j);
      sx += w * line.x[i + j];
      sy += w * line.y[i + j];
      sw += w;
    }
    ox[i] = sx / sw;
    oy[i] = sy / sw;
  }
  // h = 0 at both ends already gives the input; assigned outright so the ends are bit-identical.
  ox[0] = line.x[0];
  oy[0] = line.y[0];
  ox[n - 1] = line.x[n - 1];
  oy[n - 1] = line.y[n - 1];
  return { x: ox, y: oy, metresPerMm: line.metresPerMm };
}

/**
 * Resample every `stepM` (`resampleTrack`), then `movingAverage` with
 * K = floor(windowM / 2 / stepM) — 2 at the defaults: the window spans
 * 10 m of samples.
 */
export function smoothTrack(line: ProjectedTrack, opts: SmoothOptions = {}): ProjectedTrack {
  const stepM = opts.stepM ?? DEFAULT_STEP_M;
  const windowM = opts.windowM ?? DEFAULT_WINDOW_M;
  if (!(windowM >= 0)) throw new RangeError(`Smoothing window must be zero or more (got ${windowM})`);
  return movingAverage(resampleTrack(line, stepM), Math.floor(windowM / 2 / stepM));
}

/** Squared distance from (px, py) to the segment a–b; a squared point distance when a = b. */
function pointSegmentDistance2(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const ex = px - (ax + t * dx), ey = py - (ay + t * dy);
  return ex * ex + ey * ey;
}

/** Distance from (px, py) to the segment a–b; a point distance when a = b. */
export function pointSegmentDistance(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  return Math.sqrt(pointSegmentDistance2(px, py, ax, ay, bx, by));
}

/**
 * Douglas–Peucker, tolerance in paper mm (default 0.1). The result is a
 * subset of the vertices in order, keeps both ends, and every input point
 * lies within the tolerance of the output polyline (distance to the
 * replacing segment, so a closed loop's degenerate chord works).
 * Iterative over an explicit stack — a 200 000-point track does not
 * overflow the call stack. Ties go to the first vertex.
 */
export function simplifyTrack(line: ProjectedTrack, toleranceMm: number = DEFAULT_TOLERANCE_MM): ProjectedTrack {
  if (!(toleranceMm >= 0)) throw new RangeError(`Tolerance must be zero or more (got ${toleranceMm})`);
  const { x, y } = line;
  const n = x.length;
  if (n < 3) return copy(line);
  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;
  const tol2 = toleranceMm * toleranceMm;
  const stack: number[] = [0, n - 1];
  while (stack.length) {
    const b = stack.pop()!;
    const a = stack.pop()!;
    let worst = -1, at = -1;
    for (let i = a + 1; i < b; i++) {
      const d = pointSegmentDistance2(x[i], y[i], x[a], y[a], x[b], y[b]);
      if (d > worst) {
        worst = d;
        at = i;
      }
    }
    if (at >= 0 && worst > tol2) {
      keep[at] = 1;
      stack.push(a, at, at, b);
    }
  }
  let count = 0;
  for (let i = 0; i < n; i++) count += keep[i];
  const ox = new Float64Array(count), oy = new Float64Array(count);
  for (let i = 0, k = 0; i < n; i++) {
    if (!keep[i]) continue;
    ox[k] = x[i];
    oy[k] = y[i];
    k++;
  }
  return { x: ox, y: oy, metresPerMm: line.metresPerMm };
}
