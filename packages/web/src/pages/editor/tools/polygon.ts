/**
 * The area tools' drawing flow (docs/course-editor.md §6.4; 08 §5.3
 * "Area tools"): click per vertex, drag a vertex to adjust before closing,
 * close by double-click or a click on the first vertex, `Esc` cancels; a
 * click-drag makes a curve vertex with symmetric handles (`pull-handles`).
 * Line kinds (out-of-bounds line, marked route) finish by double-click or
 * `Enter` instead of closing. Pure: the page creates the object when
 * `step` reports `done`.
 */

import { constrain45, symmetricHandles, vertexRule, type Vertex } from "../../../lib/editor/geometry-edit";

type Pt = { x: number; y: number };

export type AreaKind = "oob_area" | "oob_line" | "whiteout" | "filter_region" | "marked_route";

/** Closed kinds need three vertices, line kinds two. */
export const isClosedKind = (k: AreaKind): boolean => k !== "oob_line" && k !== "marked_route";
export const minVertices = (k: AreaKind): number => (isClosedKind(k) ? 3 : 2);

export interface PolygonState {
  kind: AreaKind;
  vertices: Vertex[];
}

export type PolygonEvent =
  | { type: "click"; pt: Pt; /** The click is within the snap distance of the first vertex. */ onFirst: boolean }
  | { type: "double-click"; pt: Pt }
  | { type: "move-vertex"; index: number; pt: Pt }
  /** Click-drag: symmetric handles on vertex `index` — `hOut` = `vec`, `hIn` its negation; `shift` turns it to 45°. */
  | { type: "pull-handles"; index: number; vec: Pt; shift: boolean }
  | { type: "enter" };

export type PolygonStep = { state: PolygonState; done: Vertex[] | null };

/**
 * One step. `done` is the finished geometry when the flow closes (or a
 * line ends); null while drawing. A double-click's second click arrives
 * as a `click` first, at the same point: it is not added twice.
 */
export function step(s: PolygonState, e: PolygonEvent): PolygonStep {
  const n = s.vertices.length;
  switch (e.type) {
    case "click": {
      if (e.onFirst && isClosedKind(s.kind) && n >= 3) return { state: s, done: s.vertices };
      const last = s.vertices[n - 1];
      if (last && Math.hypot(last.x - e.pt.x, last.y - e.pt.y) < 1e-6) return { state: s, done: null };
      return { state: { ...s, vertices: [...s.vertices, e.pt] }, done: null };
    }
    case "double-click": {
      const last = s.vertices[n - 1];
      const vertices = last && Math.hypot(last.x - e.pt.x, last.y - e.pt.y) < 1e-6 ? s.vertices : [...s.vertices, e.pt];
      return vertices.length >= minVertices(s.kind) ? { state: { ...s, vertices }, done: vertices } : { state: { ...s, vertices }, done: null };
    }
    case "enter":
      return n >= minVertices(s.kind) ? { state: s, done: s.vertices } : { state: s, done: null };
    case "move-vertex": {
      if (e.index < 0 || e.index >= n) return { state: s, done: null };
      const vertices = [...s.vertices];
      vertices[e.index] = { ...vertices[e.index], x: e.pt.x, y: e.pt.y };
      return { state: { ...s, vertices }, done: null };
    }
    case "pull-handles": {
      // A filter region is a polygon (the schema refuses handles).
      if (e.index < 0 || e.index >= n || !vertexRule(s.kind).curves) return { state: s, done: null };
      return { state: { ...s, vertices: symmetricHandles(s.vertices, e.index, e.shift ? constrain45(e.vec) : e.vec) }, done: null };
    }
  }
}

/** Even-odd point in polygon (paper mm). */
export function pointInPolygon(pt: Pt, ring: readonly Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    if ((a.y > pt.y) !== (b.y > pt.y) && pt.x < ((b.x - a.x) * (pt.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}
