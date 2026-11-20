/**
 * Map mode's Tracks tool `T`, the reducer (docs/map-gps-tracks.md §5.2; docs/course-editor.md §13 "GPS tracks:
 * editing"; rows G27, G29): the tool's tracks are the selected visible ones; on each a press on an end handle drags it
 * along the stored points — the trim, one write on release —, and a click on one splits it at the stored point under
 * the pointer (the hovered node, `hoverCandidate`); a click on another track selects it. Pure: the binding
 * (`bindings.ts` `mapTracksBinding`) keeps the state in a ref and turns the effects into the page's writes.
 */

import type { gpsTrack } from "@oxygen/shared";
import { dragIndex, handleBounds, handleIndex, keptLine, nearestTrack, splitIndexAt, trimOfHandle, type TrackEnd } from "../modes/map/tracks/edit";

type Pt = { x: number; y: number };
type Range = gpsTrack.TrackRange;

/** A tool's track: its full projection (index `i` is stored point `i`) and its trim. */
export interface TrackToolTarget {
  id: string;
  full: gpsTrack.ProjectedTrack;
  trim: Range;
}

export type TrackToolState =
  | { kind: "idle" }
  /** Handle `end` held: `from` its index at the press, `index` where it is now; moved once past `dragMm`. */
  | { kind: "drag"; target: TrackToolTarget; end: TrackEnd; from: number; index: number; press: Pt; dragMm: number; slackMm: number; moved: boolean };

export const IDLE: TrackToolState = { kind: "idle" };

export type TrackToolEvent =
  /** A press: on a handle within `handleMm` it is taken. */
  | { type: "down"; pt: Pt; handleMm: number; dragMm: number; targets: readonly TrackToolTarget[] }
  | { type: "drag"; pt: Pt }
  /** The release; null when cancelled (Escape, the pointer left). */
  | { type: "up"; pt: Pt | null }
  /** A click; `lines` are the visible tracks as drawn (trimmed), for a click on another one. */
  | { type: "click"; pt: Pt; reachMm: number; targets: readonly TrackToolTarget[]; lines: readonly TrackLine[] };

type TrackLine = { id: string; line: gpsTrack.ProjectedTrack };

/** Where a click at `pt` would split: a tool's track and the stored point (the node the pointer is on), else null. */
export interface SplitCandidate { id: string; index: number }

export type TrackToolEffect =
  | { kind: "trim"; id: string; trim: Range; before: Range }
  | { kind: "split"; id: string; index: number }
  | { kind: "select"; id: string };

export interface TrackToolStep {
  state: TrackToolState;
  /** A press was taken (the map does not pan). */
  taken: boolean;
  effect: TrackToolEffect | null;
}

const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);
const pointOf = (line: gpsTrack.ProjectedTrack, i: number): Pt => ({ x: line.x[i], y: line.y[i] });

/** The trim the drag shows now, or null when no handle is held. */
export function liveTrim(s: TrackToolState): { id: string; trim: Range } | null {
  return s.kind === "drag" ? { id: s.target.id, trim: trimOfHandle(s.end, s.index, s.target.trim) } : null;
}

/**
 * The click's track: the nearest visible track within `reachMm`, the tool's own first on a tie (in their order),
 * then list order. A tool's track gives a split candidate (or none next to a handle), another one its id to select.
 */
function clickedTrack(pt: Pt, reachMm: number, targets: readonly TrackToolTarget[], lines: readonly TrackLine[]): { split: SplitCandidate | null } | { select: string } | null {
  const own = new Set(targets.map((t) => t.id));
  const all = [...targets.map((t) => ({ id: t.id, line: keptLine(t.full, t.trim) })), ...lines.filter((l) => !own.has(l.id))];
  const id = nearestTrack(all, pt, reachMm);
  if (id === null) return null;
  const t = targets.find((x) => x.id === id);
  if (!t) return { select: id };
  const index = splitIndexAt(t.full, t.trim, pt, reachMm);
  return { split: index === null ? null : { id, index } };
}

/** The node a click at `pt` would split at now (drawn highlighted under the pointer), else null. */
export function hoverCandidate(pt: Pt, reachMm: number, targets: readonly TrackToolTarget[], lines: readonly TrackLine[]): SplitCandidate | null {
  if (targets.length === 0) return null;
  const c = clickedTrack(pt, reachMm, targets, lines);
  return c && "split" in c ? c.split : null;
}

export function trackToolStep(s: TrackToolState, e: TrackToolEvent): TrackToolStep {
  const none = (state: TrackToolState = s): TrackToolStep => ({ state, taken: false, effect: null });
  switch (e.type) {
    case "down": {
      // The nearest handle within reach over the tool's tracks (a two-point track has its two close together).
      let best: { t: TrackToolTarget; end: TrackEnd; d: number } | null = null;
      for (const t of e.targets) {
        for (const end of ["start", "end"] as const) {
          const d = dist(pointOf(t.full, handleIndex(end, t.trim)), e.pt);
          if (d <= e.handleMm && (!best || d < best.d)) best = { t, end, d };
        }
      }
      if (!best) return none(IDLE);
      const t = best.t;
      const from = handleIndex(best.end, t.trim);
      return { state: { kind: "drag", target: t, end: best.end, from, index: from, press: e.pt, dragMm: e.dragMm, slackMm: e.handleMm, moved: false }, taken: true, effect: null };
    }
    case "drag": {
      if (s.kind !== "drag") return none();
      if (!s.moved && dist(s.press, e.pt) <= s.dragMm) return none();
      const { lo, hi } = handleBounds(s.end, s.target.trim, s.target.full.x.length);
      const index = dragIndex(s.target.full, s.index, e.pt, lo, hi, s.slackMm);
      return none({ ...s, index, moved: true });
    }
    case "up": {
      if (s.kind !== "drag") return none(IDLE);
      if (!e.pt || !s.moved || s.index === s.from) return none(IDLE);
      return { state: IDLE, taken: false, effect: { kind: "trim", id: s.target.id, trim: trimOfHandle(s.end, s.index, s.target.trim), before: s.target.trim } };
    }
    case "click": {
      const c = clickedTrack(e.pt, e.reachMm, e.targets, e.lines);
      if (!c) return none();
      if ("select" in c) return { state: s, taken: false, effect: { kind: "select", id: c.select } };
      return { state: s, taken: false, effect: c.split ? { kind: "split", ...c.split } : null };
    }
  }
}
