/**
 * Map mode's Tracks tool `T`, the reducer (docs/map-gps-tracks.md §5.2; docs/course-editor.md §13 "GPS tracks:
 * editing"; row G27): on the tool's track (the one selected track) a press on an end handle drags it along the stored
 * points — the trim, one write on release —, and a click on the track splits it at the nearest stored point; a click
 * on another track selects it. Pure: the binding (`bindings.ts` `mapTracksBinding`) keeps the state in a ref and
 * turns the effects into the page's writes.
 */

import type { gpsTrack } from "@oxygen/shared";
import { dragIndex, handleBounds, handleIndex, keptLine, nearestTrack, splitIndexAt, trimOfHandle, type TrackEnd } from "../modes/map/tracks/edit";

type Pt = { x: number; y: number };
type Range = gpsTrack.TrackRange;

/** The tool's track: its full projection (index `i` is stored point `i`) and its trim. */
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
  | { type: "down"; pt: Pt; handleMm: number; dragMm: number; target: TrackToolTarget | null }
  | { type: "drag"; pt: Pt }
  /** The release; null when cancelled (Escape, the pointer left). */
  | { type: "up"; pt: Pt | null }
  /** A click; `lines` are the visible tracks as drawn (trimmed), for a click on another one. */
  | { type: "click"; pt: Pt; reachMm: number; target: TrackToolTarget | null; lines: readonly { id: string; line: gpsTrack.ProjectedTrack }[] };

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

export function trackToolStep(s: TrackToolState, e: TrackToolEvent): TrackToolStep {
  const none = (state: TrackToolState = s): TrackToolStep => ({ state, taken: false, effect: null });
  switch (e.type) {
    case "down": {
      const t = e.target;
      if (!t) return none(IDLE);
      // The nearer of the two handles within reach (a two-point track has them close together).
      let best: { end: TrackEnd; d: number } | null = null;
      for (const end of ["start", "end"] as const) {
        const d = dist(pointOf(t.full, handleIndex(end, t.trim)), e.pt);
        if (d <= e.handleMm && (!best || d < best.d)) best = { end, d };
      }
      if (!best) return none(IDLE);
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
      const t = e.target;
      // On the tool's track: a split, or nothing next to a handle (a click there never selects another track).
      if (t && nearestTrack([{ id: t.id, line: keptLine(t.full, t.trim) }], e.pt, e.reachMm) !== null) {
        const index = splitIndexAt(t.full, t.trim, e.pt, e.reachMm);
        return { state: s, taken: false, effect: index === null ? null : { kind: "split", id: t.id, index } };
      }
      const id = nearestTrack(e.lines.filter((l) => l.id !== t?.id), e.pt, e.reachMm);
      return { state: s, taken: false, effect: id === null ? null : { kind: "select", id } };
    }
  }
}
