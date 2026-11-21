/**
 * The course's height profile as a graph (docs/course-elevation.md §5):
 * the model behind `pages/editor/ProfilePanel.tsx`. Pure — points along
 * the course, a scale, axis ticks, the paths and the place under a
 * pointer — so the panel only draws.
 */

import type { CourseProfile } from "@oxygen/shared/src/terrain/profile/index.js";

export interface GraphPoint {
  /** Along the course, ground metres. */
  dM: number;
  /** Height, metres; null without data (the line breaks). */
  zM: number | null;
  /** Index of the leg the point lies on. */
  leg: number;
}

/** The course's samples in order, each leg's shifted by its offset. */
export function profilePoints(profile: CourseProfile): GraphPoint[] {
  const out: GraphPoint[] = [];
  profile.legs.forEach((leg, i) => {
    for (const s of leg.profile.samples) out.push({ dM: leg.offsetM + s.dM, zM: s.zM, leg: i });
  });
  return out;
}

/** Where each leg starts and the course ends: `legs + 1` distances (the controls, in order). */
export function legBounds(profile: CourseProfile): number[] {
  return [...profile.legs.map((l) => l.offsetM), profile.lengthM];
}

/** The leg a distance lies on (a boundary belongs to the leg it starts). */
export function legAt(bounds: readonly number[], dM: number): number {
  let i = 0;
  while (i < bounds.length - 2 && dM >= bounds[i + 1]) i++;
  return i;
}

/**
 * About two points per pixel column — the column's lowest and highest,
 * in order, and the ends of each run of data — so a long course draws a bounded path that keeps its peaks.
 * A column with a point without data keeps one, so the break stays.
 */
export function decimate(points: readonly GraphPoint[], lengthM: number, columns: number): GraphPoint[] {
  if (columns <= 0 || lengthM <= 0 || points.length <= columns * 2) return [...points];
  const out: GraphPoint[] = [];
  let col = -1;
  let lo: GraphPoint | null = null, hi: GraphPoint | null = null, gap: GraphPoint | null = null;
  // The ends of each run of data are kept, so the line reaches the start, the finish and the edges of a gap.
  const ends = new Set<GraphPoint>();
  points.forEach((p, i) => {
    if (p.zM !== null && (i === 0 || i === points.length - 1 || points[i - 1].zM === null || points[i + 1].zM === null)) ends.add(p);
  });
  let kept: GraphPoint[] = [];
  const flush = () => {
    for (const p of [...new Set([lo, hi, gap, ...kept].filter((q): q is GraphPoint => q !== null))].sort((a, b) => a.dM - b.dM)) out.push(p);
    lo = hi = gap = null;
    kept = [];
  };
  for (const p of points) {
    const c = Math.min(columns - 1, Math.floor((p.dM / lengthM) * columns));
    if (c !== col) { flush(); col = c; }
    if (ends.has(p)) kept.push(p);
    if (p.zM === null) gap ??= p;
    else {
      if (!lo || p.zM < (lo.zM as number)) lo = p;
      if (!hi || p.zM > (hi.zM as number)) hi = p;
    }
  }
  flush();
  return out;
}

/** A round step — 1, 2 or 5 × 10ⁿ — that splits `span` into at most `count` parts. */
export function niceStep(span: number, count: number): number {
  if (!(span > 0) || count < 1) return 1;
  const raw = span / count;
  const pow = 10 ** Math.floor(Math.log10(raw));
  return [1, 2, 5, 10].map((m) => m * pow).find((s) => s >= raw * (1 - 1e-9)) ?? 10 * pow;
}

/** The multiples of `step` in `[min, max]`. */
export function ticksBy(min: number, max: number, step: number): number[] {
  const out: number[] = [];
  for (let k = Math.ceil(min / step - 1e-9); k * step <= max + step * 1e-9; k++) out.push(Math.round(k * step * 1e6) / 1e6 + 0);
  return out;
}

/** Round tick values inside `[min, max]`: steps of 1, 2 or 5 × 10ⁿ, about `count` of them. */
export function niceTicks(min: number, max: number, count: number): number[] {
  if (!(max - min > 0) || count < 1) return [min];
  return ticksBy(min, max, niceStep(max - min, count));
}

export interface GraphBox { width: number; height: number; left: number; right: number; top: number; bottom: number }

export interface GraphScale {
  /** The heights' range drawn, metres (at least `minSpanM` apart, padded to the ticks). */
  zMin: number;
  zMax: number;
  lengthM: number;
  x: (dM: number) => number;
  y: (zM: number) => number;
  /** The distance under a pixel x, clamped to the course. */
  dAt: (px: number) => number;
  zTicks: number[];
  dTicks: number[];
  /** The distance ticks' step, metres. */
  dStep: number;
}

/** A flat course still gets a readable axis: the range is at least this many metres. */
export const MIN_SPAN_M = 10;

export function graphScale(points: readonly GraphPoint[], lengthM: number, box: GraphBox): GraphScale {
  let lo = Infinity, hi = -Infinity;
  for (const p of points) if (p.zM !== null) { lo = Math.min(lo, p.zM); hi = Math.max(hi, p.zM); }
  if (lo > hi) lo = hi = 0;
  if (hi - lo < MIN_SPAN_M) { const mid = (lo + hi) / 2; lo = mid - MIN_SPAN_M / 2; hi = mid + MIN_SPAN_M / 2; }
  const innerW = Math.max(1, box.width - box.left - box.right), innerH = Math.max(1, box.height - box.top - box.bottom);
  // The range ends on ticks: the step is chosen for the data's span, the ends widened to its multiples.
  const step = niceStep(hi - lo, Math.max(2, Math.floor(innerH / 26)));
  const zMin = Math.floor(lo / step + 1e-9) * step, zMax = Math.ceil(hi / step - 1e-9) * step;
  const dStep = niceStep(lengthM, Math.max(2, Math.floor(innerW / 90)));
  const len = lengthM > 0 ? lengthM : 1;
  return {
    zMin, zMax, lengthM,
    x: (dM) => box.left + (dM / len) * innerW,
    y: (zM) => box.top + (1 - (zM - zMin) / (zMax - zMin)) * innerH,
    dAt: (px) => Math.max(0, Math.min(lengthM, ((px - box.left) / innerW) * len)),
    zTicks: ticksBy(zMin, zMax, step),
    dTicks: lengthM > 0 ? ticksBy(0, lengthM, dStep) : [0],
    dStep,
  };
}

const n1 = (v: number) => (Math.round(v * 10) / 10).toString();

/** The line and its area down to the baseline, as SVG paths; each run of points with data is its own sub-path. */
export function graphPaths(points: readonly GraphPoint[], scale: GraphScale, baselineY: number): { line: string; area: string } {
  let line = "", area = "";
  let run: GraphPoint[] = [];
  const flush = () => {
    if (run.length >= 2) {
      const pts = run.map((p) => `${n1(scale.x(p.dM))},${n1(scale.y(p.zM as number))}`);
      line += `M${pts.join("L")}`;
      area += `M${n1(scale.x(run[0].dM))},${n1(baselineY)}L${pts.join("L")}L${n1(scale.x(run[run.length - 1].dM))},${n1(baselineY)}Z`;
    }
    run = [];
  };
  for (const p of points) {
    if (p.zM === null) flush();
    else run.push(p);
  }
  flush();
  return { line, area };
}

/** The height at a distance, between the two points around it; null in a stretch without data or outside the course. */
export function heightAtDistance(points: readonly GraphPoint[], dM: number): number | null {
  if (points.length === 0 || dM < points[0].dM || dM > points[points.length - 1].dM) return null;
  let a = 0, b = points.length - 1;
  while (b - a > 1) {
    const m = (a + b) >> 1;
    if (points[m].dM <= dM) a = m; else b = m;
  }
  const p = points[a], q = points[b];
  if (p.zM === null || q.zM === null) return p.dM === dM ? p.zM : q.dM === dM ? q.zM : null;
  const t = q.dM > p.dM ? (dM - p.dM) / (q.dM - p.dM) : 0;
  return p.zM + (q.zM - p.zM) * t;
}

/** The control marks to label along the top: every one when they fit, else every n-th, at least `gapPx` apart; the first and last always. */
export function boundLabels(bounds: readonly number[], x: (dM: number) => number, gapPx = 16): number[] {
  const out: number[] = [];
  let last = -Infinity;
  const end = bounds.length - 1;
  bounds.forEach((d, i) => {
    const px = x(d);
    if (i === end) {
      while (out.length > 1 && px - x(bounds[out[out.length - 1]]) < gapPx) out.pop();
      out.push(i);
    } else if (px - last >= gapPx) { out.push(i); last = px; }
  });
  return out;
}

// ─── The panel's preference (this device) ─────────────────────────────

export const PROFILE_PREF_KEY = "oxygen.editor.profilePanel";

export function readProfileOpen(storage: Pick<Storage, "getItem"> | null): boolean {
  try {
    return storage?.getItem(PROFILE_PREF_KEY) === "open";
  } catch {
    return false;
  }
}

export function writeProfileOpen(storage: Pick<Storage, "setItem"> | null, open: boolean): void {
  try {
    storage?.setItem(PROFILE_PREF_KEY, open ? "open" : "closed");
  } catch {
    // Private mode: the panel still opens for this visit.
  }
}
