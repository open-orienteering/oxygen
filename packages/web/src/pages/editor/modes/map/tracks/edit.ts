/**
 * Editing a GPS track in Map mode, the pure part (docs/map-gps-tracks.md §5.2; docs/course-editor.md §13 "GPS tracks:
 * editing"; row G27): the trim's two end handles as stored-point indices on the full projected track (index-aligned,
 * §3.2), where a drag puts a handle, where a click splits, which track a click is on, the kept line and an average's
 * single-pass ranges under the trim (§4.1), and what a split's undo writes. No React here.
 */

import { gpsTrack } from "@oxygen/shared";
import type { TrackImportItem, TrackMeta } from "../../../../../lib/editor/write-client";
import { deletedTrackImport } from "./model";

type Pt = { x: number; y: number };
type Range = gpsTrack.TrackRange;

/** A trim handle: `start` on stored point `trim.start`, `end` on `trim.end − 1` (§3.5: `end` is exclusive). */
export type TrackEnd = "start" | "end";

export const handleIndex = (end: TrackEnd, trim: Range): number => (end === "start" ? trim.start : trim.end - 1);

/** The trim with handle `end` on stored point `index`. */
export const trimOfHandle = (end: TrackEnd, index: number, trim: Range): Range =>
  end === "start" ? { start: index, end: trim.end } : { start: trim.start, end: index + 1 };

/**
 * The stored points handle `end` may sit on, inclusive: anywhere on the whole stored track (so a trim is restored by
 * dragging outward), keeping two points between the handles (§1.1's `trim_end − trim_start ≥ 2`).
 */
export function handleBounds(end: TrackEnd, trim: Range, pointCount: number): { lo: number; hi: number } {
  return end === "start" ? { lo: 0, hi: trim.end - 2 } : { lo: trim.start + 1, hi: pointCount - 1 };
}

const dist2 = (line: gpsTrack.ProjectedTrack, i: number, pt: Pt): number => {
  const dx = line.x[i] - pt.x, dy = line.y[i] - pt.y;
  return dx * dx + dy * dy;
};

/**
 * Where a dragged handle lands: a stored point of `full` in `[lo, hi]`. Among the points within `slackMm` of the
 * nearest one, the one nearest in index to `from` (the handle's index before), so on an out-and-back a handle stays on
 * its own leg where the two run side by side.
 */
export function dragIndex(full: gpsTrack.ProjectedTrack, from: number, pt: Pt, lo: number, hi: number, slackMm: number): number {
  let best = Infinity;
  for (let i = lo; i <= hi; i++) best = Math.min(best, dist2(full, i, pt));
  const reach = Math.sqrt(best) + slackMm;
  const r2 = reach * reach;
  let out = lo, gap = Infinity;
  for (let i = lo; i <= hi; i++) {
    if (dist2(full, i, pt) > r2) continue;
    const g = Math.abs(i - from);
    if (g < gap) { gap = g; out = i; }
  }
  return out;
}

/** The nearest segment of `line` among segments `[from, to)` (segment `k` joins points `k`, `k + 1`): its index and distance. */
function nearestSegment(line: gpsTrack.ProjectedTrack, from: number, to: number, pt: Pt): { k: number; d: number } | null {
  let out: { k: number; d: number } | null = null;
  for (let k = from; k < to; k++) {
    const d = gpsTrack.pointSegmentDistance(pt.x, pt.y, line.x[k], line.y[k], line.x[k + 1], line.y[k + 1]);
    if (!out || d < out.d) out = { k, d };
  }
  return out;
}

/**
 * The stored point a click at `pt` splits `full` at (§3.5, §1.2 "Split"): the nearer vertex of the nearest segment of
 * the kept range (ties to the earlier), when within `reachMm`; null out of reach or when the point leaves fewer than
 * two visible points on a side (`trim.start + 1 … trim.end − 2`).
 */
export function splitIndexAt(full: gpsTrack.ProjectedTrack, trim: Range, pt: Pt, reachMm: number): number | null {
  const s = nearestSegment(full, trim.start, trim.end - 1, pt);
  if (!s || s.d > reachMm) return null;
  const index = dist2(full, s.k + 1, pt) < dist2(full, s.k, pt) ? s.k + 1 : s.k;
  return index >= trim.start + 1 && index <= trim.end - 2 ? index : null;
}

/**
 * The splittable stored points (`trim.start + 1 … trim.end − 2`) within `radiusMm` of stored point `index`, in index
 * order: drawn round the hovered node (G30), so every point the pointer can reach shows whatever the thinning.
 */
export function nodesNear(full: gpsTrack.ProjectedTrack, trim: Range, index: number, radiusMm: number): number[] {
  const out: number[] = [];
  const c = { x: full.x[index], y: full.y[index] }, r2 = radiusMm * radiusMm;
  for (let i = trim.start + 1; i <= trim.end - 2; i++) if (dist2(full, i, c) <= r2) out.push(i);
  return out;
}

const boxes = new WeakMap<ArrayLike<number>, { minX: number; minY: number; maxX: number; maxY: number }>();
/** A line's bounding box, cached per coordinate array (a line's arrays never change under it). */
function boxOf(line: gpsTrack.ProjectedTrack) {
  let b = boxes.get(line.x);
  if (!b) {
    b = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
    for (let i = 0; i < line.x.length; i++) {
      b.minX = Math.min(b.minX, line.x[i]); b.maxX = Math.max(b.maxX, line.x[i]);
      b.minY = Math.min(b.minY, line.y[i]); b.maxY = Math.max(b.maxY, line.y[i]);
    }
    boxes.set(line.x, b);
  }
  return b;
}

/**
 * The id of the line nearest `pt` within `reachMm` (ties to list order), else null. Lines whose box is out of reach
 * are passed over unscanned (T's hover runs this on every pointer move, G30).
 */
export function nearestTrack(lines: readonly { id: string; line: gpsTrack.ProjectedTrack }[], pt: Pt, reachMm: number): string | null {
  let out: string | null = null, best = reachMm;
  for (const l of lines) {
    const b = boxOf(l.line);
    if (pt.x < b.minX - reachMm || pt.x > b.maxX + reachMm || pt.y < b.minY - reachMm || pt.y > b.maxY + reachMm) continue;
    const s = nearestSegment(l.line, 0, l.line.x.length - 1, pt);
    if (s && (s.d < best || (out === null && s.d <= best))) { best = s.d; out = l.id; }
  }
  return out;
}

/** The trim's slice of the full projection (§5.1: index `i` is stored point `trim.start + i`); the line itself when untrimmed. */
export function keptLine(full: gpsTrack.ProjectedTrack, trim: Range): gpsTrack.ProjectedTrack {
  if (trim.start === 0 && trim.end === full.x.length) return full;
  return { x: full.x.subarray(trim.start, trim.end), y: full.y.subarray(trim.start, trim.end), metresPerMm: full.metresPerMm };
}

/** An average's single-pass ranges (stored-point indices, §4.1) on its trimmed line: clipped to the trim, shifted by `trim.start`. */
export function viewRanges(singlePass: readonly Range[] | null, trim: Range): Range[] {
  const out: Range[] = [];
  for (const r of singlePass ?? []) {
    const start = Math.max(r.start, trim.start), end = Math.min(r.end, trim.end);
    if (end > start) out.push({ start: start - trim.start, end: end - trim.start });
  }
  return out;
}

export interface SplitUndo {
  /** The two parts. */
  remove: string[];
  /** The original again under its id, at the end of the list (a new `created_at`; §5.2, user 2026-11-15). */
  item: TrackImportItem;
  /** Its trim, when not the whole track. */
  trim: Range | null;
  /** Its mark, when converted. */
  mark: { id: string; opId: string } | null;
}

/** What undoing a split of `meta` into `parts` writes, in order: remove, import, then trim and mark when set (§5.2). */
export function splitUndo(meta: TrackMeta, points: gpsTrack.TrackPoints, parts: readonly [string, string]): SplitUndo {
  const full = meta.trim.start === 0 && meta.trim.end === meta.pointCount;
  return {
    remove: [...parts],
    item: deletedTrackImport(meta, points),
    trim: full ? null : { ...meta.trim },
    mark: meta.convertedOp ? { id: meta.id, opId: meta.convertedOp } : null,
  };
}
