/**
 * A leg's bends (`LegProps.bends`, paper mm; 08 §4.3, docs/course-layer.md
 * §10.1, docs/course-editor.md §6.7): the leg is the polyline
 * [from, ...bends, to]. Pure geometry for the editor's bend gestures and the
 * gap tool along a bent leg (§6.3).
 */

export type Pt = { x: number; y: number };

/** The leg's polyline: from, its bends, to. */
export const legPolyline = (from: Pt, bends: readonly Pt[] | undefined, to: Pt): Pt[] => [from, ...(bends ?? []), to];

/** The polyline's length (mm). */
export function polylineLength(points: readonly Pt[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
  return total;
}

interface Projection {
  /** Segment index (points[segment] → points[segment + 1]). */
  segment: number;
  /** 0..1 along that segment. */
  t: number;
  point: Pt;
  dist: number;
  /** Distance along the polyline from its first point (mm). */
  along: number;
}

/** The nearest point of the polyline to `pt`; null for fewer than two points. */
export function projectOnPolyline(points: readonly Pt[], pt: Pt): Projection | null {
  let best: Projection | null = null;
  let along = 0;
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i], b = points[i + 1];
    const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy, len = Math.sqrt(l2);
    const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((pt.x - a.x) * dx + (pt.y - a.y) * dy) / l2));
    const point = { x: a.x + dx * t, y: a.y + dy * t };
    const dist = Math.hypot(pt.x - point.x, pt.y - point.y);
    if (!best || dist < best.dist) best = { segment: i, t, point, dist, along: along + len * t };
    along += len;
  }
  return best;
}

/** Distance from `pt` to the polyline (Infinity for fewer than two points). */
export const polylineDistance = (points: readonly Pt[], pt: Pt): number => projectOnPolyline(points, pt)?.dist ?? Infinity;

/** Fraction 0..1 of the bent length at the polyline's nearest point to `pt`. */
export function polylineFraction(points: readonly Pt[], pt: Pt): number {
  const p = projectOnPolyline(points, pt);
  const total = polylineLength(points);
  return !p || total === 0 ? 0 : Math.max(0, Math.min(1, p.along / total));
}

/** The point at fraction `f` (0..1) of the bent length. */
export function pointAtFraction(points: readonly Pt[], f: number): Pt {
  if (points.length === 0) return { x: 0, y: 0 };
  const total = polylineLength(points);
  let rest = Math.max(0, Math.min(1, f)) * total;
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i], b = points[i + 1];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (rest <= len || i + 2 === points.length) {
      const t = len === 0 ? 0 : Math.min(1, rest / len);
      return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
    }
    rest -= len;
  }
  return { ...points[0] };
}

/** The stretch of the polyline between fractions `f0` and `f1` (inclusive of its corners). */
export function polylineSlice(points: readonly Pt[], f0: number, f1: number): Pt[] {
  const total = polylineLength(points);
  if (points.length < 2 || total === 0) return [pointAtFraction(points, f0), pointAtFraction(points, f1)];
  const a = Math.min(f0, f1) * total, b = Math.max(f0, f1) * total;
  const out: Pt[] = [pointAtFraction(points, a / total)];
  let along = 0;
  for (let i = 1; i + 1 < points.length; i++) {
    along += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
    if (along > a && along < b) out.push({ ...points[i] });
  }
  out.push(pointAtFraction(points, b / total));
  return out;
}

const round = (v: number) => Math.round(v * 100) / 100;

/**
 * *Add bend here* (§6.7): `pt` becomes a bend on the segment of
 * [from, ...bends, to] nearest it, so the leg keeps its order of corners.
 */
export function insertBendAt(from: Pt, bends: readonly Pt[] | undefined, to: Pt, pt: Pt): Pt[] {
  const list = [...(bends ?? [])];
  const p = projectOnPolyline(legPolyline(from, list, to), pt);
  const at = p ? p.segment : list.length;
  list.splice(at, 0, { x: round(pt.x), y: round(pt.y) });
  return list;
}

/** The bends without bend `index`. */
export const removeBend = (bends: readonly Pt[], index: number): Pt[] => bends.filter((_, i) => i !== index);

/** The bends with bend `index` moved to `pt`. */
export const moveBend = (bends: readonly Pt[], index: number, pt: Pt): Pt[] =>
  bends.map((b, i) => (i === index ? { x: round(pt.x), y: round(pt.y) } : b));
