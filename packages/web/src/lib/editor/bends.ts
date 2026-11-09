/**
 * A leg's bends (`LegProps.bends`, paper mm; 08 §4.3, docs/course-layer.md
 * §10.1, docs/course-editor.md §6.7): the leg is the path
 * [from, ...bends, to], its bends path vertices with optional handles (F13),
 * drawn and measured as the shared flattened polyline (`legPolylineOf`).
 * Pure geometry for the editor's bend gestures and the gap tool along a
 * bent leg (§6.3).
 */

import { course, type PathVertex } from "@oxygen/shared";
import {
  constrain45, dragGrip, hasHandles, insertVertex, nearestEdge, retractHandles, smoothHandles, toggleSmooth, type Vertex,
} from "./geometry-edit";

export type Pt = { x: number; y: number };
/** A bend: a point with optional handles, offsets from it (F13) — the shared `PathVertex`. */
export type Bend = PathVertex;

/** The leg as drawn: from, its bends' path flattened (5 µm), to — the layer's own polyline. */
export const legPolyline = (from: Pt, bends: readonly Bend[] | undefined, to: Pt): Pt[] => course.legPolylineOf(from, bends, to);

const pointEqual = (a: Pt | undefined, b: Pt | undefined) => (a === undefined || b === undefined ? a === b : a.x === b.x && a.y === b.y);

/** Two bend lists alike by value (points and handles); absent and empty are alike (F21: a held leg draft meets the list). */
export function bendsEqual(a: readonly Bend[] | undefined, b: readonly Bend[] | undefined): boolean {
  const x = a ?? [], y = b ?? [];
  return x.length === y.length && x.every((p, i) => pointEqual(p, y[i]) && pointEqual(p.hIn, y[i].hIn) && pointEqual(p.hOut, y[i].hOut));
}

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

// Half away from zero, so round(−v) = −round(v) and a mirrored pair stays mirrored; −0 + 0 is 0 (no negative zero stored).
const round = (v: number) => Math.sign(v) * Math.round(Math.abs(v) * 100) / 100 + 0;
const roundPt = (p: Pt): Pt => ({ x: round(p.x), y: round(p.y) });

/**
 * The leg as an open vertex path (F16, docs/course-editor.md §6.7, §7
 * "Editing geometry"): `[from, …bends, to]`, edited open (`closed: false`),
 * curves allowed. The sites are its fixed ends: an open path's ends have
 * no smooth form (`smoothHandles`, `toggleSmooth`), a split gives a corner
 * end no handle, and only the path without its two ends is written back,
 * so a site never carries a handle (course-layer.md §10.1).
 */
export const legPath = (from: Pt, bends: readonly Bend[] | undefined, to: Pt): Vertex[] => [{ x: from.x, y: from.y }, ...(bends ?? []), { x: to.x, y: to.y }];

/** A bend at 0.01 mm: its point and its handles (a handle rounded to nothing is dropped). */
export function roundBend(v: Vertex): Bend {
  const out: Bend = roundPt(v);
  const hIn = v.hIn && roundPt(v.hIn), hOut = v.hOut && roundPt(v.hOut);
  if (hIn && (hIn.x || hIn.y)) out.hIn = hIn;
  if (hOut && (hOut.x || hOut.y)) out.hOut = hOut;
  return out;
}

/**
 * *Add bend here* (§6.7, F16): a bend on the segment of [from, ...bends,
 * to] whose (flattened) path is nearest `pt`, at that segment's nearest
 * point, so the leg keeps its order of vertices and its shape. It is
 * **smooth** (the user's answer Q2, F18's convention): on a straight
 * segment its handles come from its neighbours (`smoothHandles`, collinear
 * with the segment), on a curve the de Casteljau split (`insertVertex`)
 * keeps the curve, the neighbours' facing handles shortened. `corner`
 * (Alt) drops the new bend's handles. The other bends are untouched (a
 * stored corner stays one). `index` is the new bend's.
 */
export function insertBendAt(from: Pt, bends: readonly Bend[] | undefined, to: Pt, pt: Pt, corner = false): { bends: Bend[]; index: number } {
  const path = legPath(from, bends, to);
  const edge = nearestEdge(path, false, pt)!;
  const at = edge.index + 1;
  const split = insertVertex(path, false, edge.index, edge.t);
  const out = corner ? retractHandles(split, at) : hasHandles(split[at]) ? split : smoothHandles(split, at, false);
  // Untouched bends keep their stored numbers exactly; the edited ones are rounded.
  const kept = new Set<Vertex>(bends ?? []);
  const list = out.slice(1, -1).map((b) => (kept.has(b) ? (b as Bend) : roundBend(b)));
  return { bends: list, index: edge.index };
}

/** Alt-click on bend `index` (§6.7, F18's `toggleSmooth`): a bend with a handle becomes a corner, a corner smooth. Null out of range. */
export function toggleBendSmooth(from: Pt, bends: readonly Bend[], to: Pt, index: number): Bend[] | null {
  const path = legPath(from, bends, to);
  const out = index >= 0 && index < bends.length ? toggleSmooth(path, index + 1, false) : null;
  return out && bends.map((b, i) => (i === index ? roundBend(out[i + 1]) : b));
}

/** The bend row's **Smooth** / **Corner** (§6.7, tablets): bend `index` set to that kind; already that kind, unchanged. */
export function setBendKind(from: Pt, bends: readonly Bend[], to: Pt, index: number, kind: "smooth" | "corner"): Bend[] {
  const b = bends[index];
  if (!b || hasHandles(b) === (kind === "smooth")) return [...bends];
  return toggleBendSmooth(from, bends, to, index) ?? [...bends];
}

/**
 * A grip of bend `index` dragged to `vec`, its new offset (§6.7, §7
 * `dragGrip`): a mirrored or smooth pair stays so, `alt` breaks it,
 * `shift` turns the handle to 45°. Rounded.
 */
export function dragBendGrip(bends: readonly Bend[], index: number, which: "in" | "out", vec: Pt, alt: boolean, shift: boolean): Bend[] {
  const out = dragGrip(bends, index, which, shift ? constrain45(vec) : vec, alt);
  return out.map((b, i) => (i === index ? roundBend(b) : bends[i]));
}

/** The bends without bend `index`. */
export const removeBend = (bends: readonly Bend[], index: number): Bend[] => bends.filter((_, i) => i !== index);

/** The bends with bend `index` moved to `pt`, its handles (offsets) moving with it. */
export const moveBend = (bends: readonly Bend[], index: number, pt: Pt): Bend[] =>
  bends.map((b, i) => (i === index ? { ...b, x: round(pt.x), y: round(pt.y) } : b));
