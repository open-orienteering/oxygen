/**
 * A leg's bends as a path (docs/course-layer.md §10.1, F13): the leg runs
 * from the previous site through its bends `{ x, y, hIn?, hOut? }` (paper
 * mm, handles as offsets from their vertex — `pathVertexSchema`, the
 * course objects' convention) to its own site. A segment is a cubic when
 * its start has `hOut` or its end `hIn`; the missing control is its
 * anchor. The sites are corners: handles go on bends only (user answer
 * 2026-11-08 Q1), so an end's handles are never read.
 *
 * Every consumer — the derivation (pieces, gaps, clipping, cuts, number
 * placement), the checks, the corridor, the lengths and exports and the
 * web's readouts — reads the one flattened polyline `legPolylineOf`.
 */

import type { MapPoint, PathVertex } from "../course-maps/schema.js";
import { flattenSegment } from "../render/geometry.js";
import type { Segment } from "../render/path.js";

/** The derivation's flattening tolerance, paper mm (5 µm, the stage's own). */
export const LEG_FLATTEN_TOLERANCE_MM = 0.005;
/** Purple Pen export: a curved leg's `<bends>` points (user answer 2026-11-08 Q3). */
export const PPEN_FLATTEN_TOLERANCE_MM = 0.1;

/** Whether segment `i` of [a, …bends, b] is a cubic (its start has `hOut` or its end `hIn`; the sites never do). */
export function isCurvedSegment(bends: readonly PathVertex[] | undefined, i: number): boolean {
  const list = bends ?? [];
  const start = i > 0 ? list[i - 1] : undefined;
  const end = i < list.length ? list[i] : undefined;
  return !!(start?.hOut || end?.hIn);
}

/** Whether any bend carries a handle (the leg is not a plain polyline). */
export const hasCurvedBends = (bends: readonly PathVertex[] | undefined): boolean => !!bends?.some((b) => b.hIn || b.hOut);

const UM = 1000;

/**
 * Segment `i` of [a, …bends, b] flattened, its start excluded and its end
 * included verbatim; a cubic yields `pieces` points at t = k / pieces.
 * Built in µm: the flattener's floor is 10 nm in its own unit.
 */
function segmentPoints(a: MapPoint, bends: readonly PathVertex[], b: MapPoint, i: number, toleranceMm: number): MapPoint[] {
  const p: PathVertex = i === 0 ? a : bends[i - 1];
  const q: PathVertex = i === bends.length ? b : bends[i];
  const out: MapPoint = { x: q.x, y: q.y };
  if (!isCurvedSegment(bends, i)) return [out];
  const c0 = i > 0 && p.hOut ? { x: p.x + p.hOut.x, y: p.y + p.hOut.y } : p;
  const c1 = i < bends.length && q.hIn ? { x: q.x + q.hIn.x, y: q.y + q.hIn.y } : q;
  const seg: Segment = {
    kind: "cubic",
    x0: p.x * UM, y0: p.y * UM, cx0: c0.x * UM, cy0: c0.y * UM, cx1: c1.x * UM, cy1: c1.y * UM, x1: q.x * UM, y1: q.y * UM,
  };
  const flat: number[] = [];
  flattenSegment(seg, toleranceMm * UM, flat);
  const pts: MapPoint[] = [];
  for (let k = 0; k + 2 < flat.length; k += 2) pts.push({ x: flat[k] / UM, y: flat[k + 1] / UM });
  pts.push(out);
  return pts;
}

/**
 * The leg as drawn and measured: a, the bends' path, b, with cubics
 * flattened at `toleranceMm` and consecutive repeats dropped. The anchors
 * (sites and bends) appear verbatim, so a crossing point joined as a bend
 * is found by its coordinate. Without handles: exactly [a, …bends, b].
 */
export function legPolylineOf(a: MapPoint, bends: readonly PathVertex[] | undefined, b: MapPoint, toleranceMm = LEG_FLATTEN_TOLERANCE_MM): MapPoint[] {
  const list = bends ?? [];
  const out: MapPoint[] = [{ x: a.x, y: a.y }];
  for (let i = 0; i <= list.length; i++) {
    for (const p of segmentPoints(a, list, b, i, toleranceMm)) {
      const last = out[out.length - 1];
      if (Math.abs(last.x - p.x) > 1e-9 || Math.abs(last.y - p.y) > 1e-9) out.push(p);
    }
  }
  if (out.length === 1) out.push({ x: b.x, y: b.y });
  return out;
}

/** The bend segment nearest a point: `index` ∈ [0, bends.length] (segment i runs into bend i, the last into b). */
export interface BendSegmentHit {
  index: number;
  /** The segment's own parameter (a cubic's t; a line's fraction), 0..1. */
  t: number;
  /** Distance from the point to the flattened segment, mm. */
  dist: number;
  /** The nearest point on the flattened segment. */
  point: MapPoint;
}

/**
 * The segment of [a, …bends, b] whose flattened path is nearest `pt`
 * (ties to the lowest index): where a crossing point joins the leg, so
 * it keeps its order of vertices (§10.3). (The editor's *Add bend here*
 * finds its segment on the vertex path, `nearestEdge`, since F16.)
 */
export function bendSegmentAt(a: MapPoint, bends: readonly PathVertex[] | undefined, b: MapPoint, pt: MapPoint): BendSegmentHit {
  const list = bends ?? [];
  let best: BendSegmentHit | null = null;
  for (let i = 0; i <= list.length; i++) {
    const start: MapPoint = i === 0 ? a : list[i - 1];
    const pts = [start, ...segmentPoints(a, list, b, i, LEG_FLATTEN_TOLERANCE_MM)];
    const pieces = pts.length - 1;
    for (let k = 0; k < pieces; k++) {
      const p = pts[k], q = pts[k + 1];
      const dx = q.x - p.x, dy = q.y - p.y, l2 = dx * dx + dy * dy;
      const u = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((pt.x - p.x) * dx + (pt.y - p.y) * dy) / l2));
      const point = { x: p.x + dx * u, y: p.y + dy * u };
      const dist = Math.hypot(pt.x - point.x, pt.y - point.y);
      if (!best || dist < best.dist) best = { index: i, t: (k + u) / pieces, dist, point };
    }
  }
  return best!;
}

/** The bends of the leg run backwards (b → a): reversed, each vertex's `hIn` and `hOut` swapped. */
export function reverseBends(bends: readonly PathVertex[] | undefined): PathVertex[] {
  return [...(bends ?? [])].reverse().map((v) => {
    const out: PathVertex = { x: v.x, y: v.y };
    if (v.hOut) out.hIn = { ...v.hOut };
    if (v.hIn) out.hOut = { ...v.hIn };
    return out;
  });
}
