/**
 * The gap tool (`G`, docs/course-editor.md §6.3; 08 §5.3): a drag along a
 * control circle's rim opens a gap in `controls.circle_gaps` (compass
 * degrees: 0° = +y, clockwise, the gap sweeping clockwise from `start` to
 * `end`), a drag along a leg one in the leg's `LegProps.gaps` (fractions
 * 0..1 of the centre-to-centre leg) — the conventions of
 * docs/course-layer.md §2. A click on a gap removes it. Pure geometry.
 */

type Pt = { x: number; y: number };
export type AngularGap = { start: number; end: number };
export type FractionGap = { from: number; to: number };

/** Gaps narrower than this are a click, not a drag: degrees on a circle, a fraction on a leg. */
export const MIN_CIRCLE_GAP_DEG = 3;
export const MIN_LEG_GAP_MM = 0.4;

const norm = (deg: number) => ((deg % 360) + 360) % 360;
const round = (v: number, step: number) => Math.round(v / step) * step;

/** Compass bearing of `pt` from `centre`, degrees 0..360 (0° = +y, clockwise). */
export function compassDeg(centre: Pt, pt: Pt): number {
  return norm((Math.atan2(pt.x - centre.x, pt.y - centre.y) * 180) / Math.PI);
}

/** Clockwise sweep from `a` to `b`, degrees 0..360. */
const sweep = (a: number, b: number) => norm(b - a);

/**
 * The gap a rim drag from `from` to `to` opens: the shorter way round,
 * whichever direction the pointer went. Null below the minimum.
 */
export function circleGapFromDrag(centre: Pt, from: Pt, to: Pt): AngularGap | null {
  const a = compassDeg(centre, from), b = compassDeg(centre, to);
  const cw = sweep(a, b);
  const gap = cw <= 180 ? { start: a, end: b } : { start: b, end: a };
  if (sweep(gap.start, gap.end) < MIN_CIRCLE_GAP_DEG) return null;
  return { start: round(gap.start, 0.1), end: round(gap.end, 0.1) };
}

const inArc = (deg: number, g: AngularGap) => sweep(g.start, deg) <= sweep(g.start, g.end);

/** Union of angular gaps (overlapping or touching arcs merged), sorted by start. */
export function mergeCircleGaps(gaps: readonly AngularGap[]): AngularGap[] {
  // Unroll onto [0, 360): an arc through north becomes two intervals; merge; join across north again.
  const spans: [number, number][] = [];
  for (const g of gaps) {
    const s = norm(g.start), len = sweep(g.start, g.end);
    if (s + len <= 360) spans.push([s, s + len]);
    else spans.push([s, 360], [0, s + len - 360]);
  }
  spans.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const sp of spans) {
    const last = merged[merged.length - 1];
    if (last && sp[0] <= last[1]) last[1] = Math.max(last[1], sp[1]);
    else merged.push([...sp]);
  }
  if (merged.length > 1 && merged[0][0] === 0 && merged[merged.length - 1][1] === 360) {
    const tail = merged.pop()!;
    merged[0] = [tail[0], merged[0][1] + 360];
  }
  return merged.map(([a, b]) => ({ start: norm(a), end: b - a >= 360 ? norm(a + 359.9) : norm(b) })).sort((x, y) => x.start - y.start);
}

/** The gap at compass angle `deg`, by index; −1 when none. */
export function circleGapAt(gaps: readonly AngularGap[], deg: number): number {
  return gaps.findIndex((g) => inArc(norm(deg), g));
}

/** Fraction of `pt` projected on the leg a → b (clamped 0..1). */
export function legFraction(a: Pt, b: Pt, pt: Pt): number {
  const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
  return l2 === 0 ? 0 : Math.max(0, Math.min(1, ((pt.x - a.x) * dx + (pt.y - a.y) * dy) / l2));
}

/** The gap a drag along the leg a → b opens; null below the minimum. */
export function legGapFromDrag(a: Pt, b: Pt, from: Pt, to: Pt): FractionGap | null {
  const f0 = legFraction(a, b, from), f1 = legFraction(a, b, to);
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  if (len === 0 || Math.abs(f1 - f0) * len < MIN_LEG_GAP_MM) return null;
  return { from: round(Math.min(f0, f1), 0.0001), to: round(Math.max(f0, f1), 0.0001) };
}

/** Union of fraction gaps, sorted. */
export function mergeLegGaps(gaps: readonly FractionGap[]): FractionGap[] {
  const sorted = [...gaps].sort((a, b) => a.from - b.from);
  const out: FractionGap[] = [];
  for (const g of sorted) {
    const last = out[out.length - 1];
    if (last && g.from <= last.to) last.to = Math.max(last.to, g.to);
    else out.push({ ...g });
  }
  return out;
}

/** The gap at fraction `f`, by index; −1 when none. */
export function legGapAt(gaps: readonly FractionGap[], f: number): number {
  return gaps.findIndex((g) => f >= g.from && f <= g.to);
}
