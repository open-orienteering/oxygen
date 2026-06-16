/**
 * Pure helpers for the speed-coloured track overlay (ReplaySpeedTrackLayer).
 *
 * The overlay lays out a runner's whole route as a static polyline whose colour
 * encodes running speed at each point, plus periodic time ticks whose spacing
 * reveals pace. These functions are framework-free so they can be unit tested
 * in isolation and reused without pulling in canvas/React code.
 *
 * Colour range note: the heatmap uses a warm orange additive blend. To stay
 * legible on top of it, the speed ramp here is intentionally COOL
 * (deep blue -> cyan -> green), a separate range that never touches the
 * heatmap's own colouring.
 */

import type { ReplayWaypoint } from "@oxygen/shared";

/** Approximate distance in metres between two lat/lng points. */
function distanceM(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const dLat = (lat2 - lat1) * 111320;
  const dLng = (lng2 - lng1) * 111320 * Math.cos(((lat1 + lat2) * Math.PI) / 360);
  return Math.sqrt(dLat * dLat + dLng * dLng);
}

/** Default smoothing window for speed (real-time milliseconds). */
export const DEFAULT_SPEED_WINDOW_MS = 12_000;
/** Default spacing between time ticks along the track. */
export const DEFAULT_TICK_INTERVAL_MS = 60_000;

/**
 * Per-waypoint speed in metres/second, smoothed over a sliding time window to
 * suppress GPS jitter. The window is centred on each waypoint and never spans
 * an interruption gap, so a paused/lost-signal segment doesn't bleed into the
 * speed of its neighbours. Waypoints with no usable window yield `NaN`.
 *
 * @param interruptions waypoint indices where a gap precedes the waypoint
 *   (i.e. the segment [i-1, i] is a signal gap), matching ReplayRoute.interruptions.
 */
export function computeSmoothedSpeeds(
  waypoints: ReplayWaypoint[],
  interruptions: number[],
  windowMs = DEFAULT_SPEED_WINDOW_MS,
): number[] {
  const n = waypoints.length;
  const speeds = new Array<number>(n).fill(NaN);
  if (n < 2) return speeds;

  const interruptSet = new Set(interruptions);
  const half = windowMs / 2;

  for (let i = 0; i < n; i++) {
    // Expand left while inside the window and not crossing a gap.
    let lo = i;
    while (
      lo > 0 &&
      !interruptSet.has(lo) &&
      waypoints[i].timeMs - waypoints[lo - 1].timeMs <= half
    ) {
      lo--;
    }
    // Expand right while inside the window and not crossing a gap.
    let hi = i;
    while (
      hi < n - 1 &&
      !interruptSet.has(hi + 1) &&
      waypoints[hi + 1].timeMs - waypoints[i].timeMs <= half
    ) {
      hi++;
    }
    // If the window collapsed to a single point, borrow one neighbour segment
    // so isolated-but-connected waypoints still get a speed.
    if (lo === hi) {
      if (hi < n - 1 && !interruptSet.has(hi + 1)) hi++;
      else if (lo > 0 && !interruptSet.has(lo)) lo--;
    }
    if (lo === hi) continue; // truly isolated between gaps -> NaN

    let dist = 0;
    for (let k = lo + 1; k <= hi; k++) {
      dist += distanceM(
        waypoints[k - 1].lat,
        waypoints[k - 1].lng,
        waypoints[k].lat,
        waypoints[k].lng,
      );
    }
    const dt = (waypoints[hi].timeMs - waypoints[lo].timeMs) / 1000;
    speeds[i] = dt > 0 ? dist / dt : NaN;
  }

  return speeds;
}

/** Linear-interpolated percentile of a pre-sorted ascending array. */
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] * (hi - idx) + sorted[hi] * (idx - lo);
}

/**
 * Normalise raw speeds to `[0, 1]`, clamped to the p5..p95 range so a single
 * GPS spike (or a long stop) doesn't compress the useful colour range. `NaN`
 * inputs stay `NaN`. When every speed is equal, returns `0.5` for finite values.
 */
export function normalizeSpeeds(speeds: number[]): number[] {
  const finite = speeds.filter((s) => Number.isFinite(s)).sort((a, b) => a - b);
  if (finite.length === 0) return speeds.map(() => NaN);

  const p5 = percentile(finite, 0.05);
  const p95 = percentile(finite, 0.95);
  const range = p95 - p5;

  return speeds.map((s) => {
    if (!Number.isFinite(s)) return NaN;
    if (range <= 0) return 0.5;
    const clamped = Math.min(p95, Math.max(p5, s));
    return (clamped - p5) / range;
  });
}

/**
 * Cool speed ramp: slow (deep blue) -> medium (cyan) -> fast (green).
 * Deliberately distinct from the warm orange heatmap. `t` is clamped to
 * `[0, 1]`; non-finite values are treated as the slow end.
 */
const RAMP: ReadonlyArray<readonly [number, readonly [number, number, number]]> = [
  [0, [30, 64, 175]], // deep blue (slow)
  [0.5, [34, 211, 238]], // cyan (medium)
  [1, [74, 222, 128]], // green (fast)
];

export function speedColor(t: number): string {
  const x = Math.min(1, Math.max(0, Number.isFinite(t) ? t : 0));
  let i = 0;
  while (i < RAMP.length - 1 && x > RAMP[i + 1][0]) i++;
  const [t0, c0] = RAMP[i];
  const [t1, c1] = RAMP[Math.min(i + 1, RAMP.length - 1)];
  const span = t1 - t0 || 1;
  const f = (x - t0) / span;
  const r = Math.round(c0[0] + (c1[0] - c0[0]) * f);
  const g = Math.round(c0[1] + (c1[1] - c0[1]) * f);
  const b = Math.round(c0[2] + (c1[2] - c0[2]) * f);
  return `rgb(${r}, ${g}, ${b})`;
}

/**
 * Positions of evenly-spaced time ticks along the route, measured from the
 * first waypoint. Each tick is interpolated onto its containing segment; ticks
 * that would fall inside an interruption gap are skipped.
 */
export function tickPositions(
  waypoints: ReplayWaypoint[],
  interruptions: number[],
  intervalMs = DEFAULT_TICK_INTERVAL_MS,
): { lat: number; lng: number }[] {
  const ticks: { lat: number; lng: number }[] = [];
  if (waypoints.length < 2 || intervalMs <= 0) return ticks;

  const interruptSet = new Set(interruptions);
  const start = waypoints[0].timeMs;
  const end = waypoints[waypoints.length - 1].timeMs;

  let seg = 1; // current candidate segment [seg-1, seg]
  for (let target = start + intervalMs; target <= end; target += intervalMs) {
    while (seg < waypoints.length - 1 && waypoints[seg].timeMs < target) seg++;
    const a = waypoints[seg - 1];
    const b = waypoints[seg];
    if (target < a.timeMs || target > b.timeMs) continue; // safety
    if (interruptSet.has(seg)) continue; // tick lands in a signal gap -> skip
    const dt = b.timeMs - a.timeMs;
    const f = dt > 0 ? (target - a.timeMs) / dt : 0;
    ticks.push({
      lat: a.lat + (b.lat - a.lat) * f,
      lng: a.lng + (b.lng - a.lng) * f,
    });
  }

  return ticks;
}
