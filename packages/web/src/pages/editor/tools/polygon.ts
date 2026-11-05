/**
 * The area tools' drawing flow (docs/course-editor.md §6.4; 08 §5.3
 * "Area tools"): click per vertex, drag a vertex to adjust before closing,
 * close by double-click or a click on the first vertex, `Esc` cancels; a
 * click-drag makes a curve vertex with symmetric handles (`pull-handles`).
 * Line kinds (out-of-bounds line, marked route) finish by double-click or
 * `Enter` instead of closing. Alt at the press (`smooth`) places a smooth
 * vertex whose handles follow its neighbours (`smoothHandles`), settled
 * after every step; the flag is drawing state only and `done` carries
 * stored vertices without it. Pure: the page creates the object when
 * `step` reports `done`.
 */

import { constrain45, smoothHandles, symmetricHandles, vertexRule, type Vertex } from "../../../lib/editor/geometry-edit";

type Pt = { x: number; y: number };

/** The course editor's drawn kinds, and Layout mode's `P` polygon (`layout_path`, a closed page path, docs/course-layout.md §3). */
export type AreaKind = "oob_area" | "oob_line" | "whiteout" | "filter_region" | "marked_route" | "layout_path";

/** Closed kinds need three vertices, line kinds two. */
export const isClosedKind = (k: AreaKind): boolean => k !== "oob_line" && k !== "marked_route";
export const minVertices = (k: AreaKind): number => (isClosedKind(k) ? 3 : 2);

/** A vertex while drawing: a stored `Vertex` plus the drawing-only smooth flag (never stored). */
export type DrawVertex = Vertex & { smooth?: true };

export interface PolygonState {
  kind: AreaKind;
  vertices: DrawVertex[];
}

export type PolygonEvent =
  | {
    type: "click"; pt: Pt; /** The click is within the snap distance of the first vertex. */ onFirst: boolean;
    /** Alt held: the vertex placed (or, closing, the first vertex) is smooth; kinds without curves ignore it. */ smooth?: boolean;
  }
  | { type: "double-click"; pt: Pt; /** Alt held: the double-click's vertex is smooth. */ smooth?: boolean }
  | { type: "move-vertex"; index: number; pt: Pt }
  /** Click-drag: symmetric handles on vertex `index` — `hOut` = `vec`, `hIn` its negation; `shift` turns it to 45°. */
  | { type: "pull-handles"; index: number; vec: Pt; shift: boolean }
  | { type: "enter" };

export type PolygonStep = { state: PolygonState; done: Vertex[] | null };

/**
 * Every flagged vertex's handles recomputed from its current neighbours
 * (`smoothHandles`), the flags kept; `closed` wraps the ends. The preview
 * calls it with the hover point appended.
 */
export function smoothed(vertices: readonly DrawVertex[], closed: boolean): DrawVertex[] {
  let out: DrawVertex[] = [...vertices];
  vertices.forEach((v, i) => {
    if (!v.smooth) return;
    out = smoothHandles(out, i, closed);
    out[i] = { ...out[i], smooth: true };
  });
  return out;
}

/** The stored vertex: the drawing-only flag dropped. */
const stored = ({ smooth: _smooth, ...v }: DrawVertex): Vertex => v;

/**
 * One step. `done` is the finished geometry when the flow closes (or a
 * line ends) — smooth vertices settled with the closing wrap, the flags
 * stripped; null while drawing. A double-click's second click arrives as
 * a `click` first, at the same point: it is not added twice.
 */
export function step(s: PolygonState, e: PolygonEvent): PolygonStep {
  const n = s.vertices.length;
  const curves = vertexRule(s.kind).curves;
  const drawing = (vertices: DrawVertex[]): PolygonStep => ({ state: { ...s, vertices: smoothed(vertices, false) }, done: null });
  const finish = (vertices: readonly DrawVertex[]): Vertex[] => smoothed(vertices, isClosedKind(s.kind)).map(stored);
  const placed = (pt: Pt, smooth?: boolean): DrawVertex => (smooth && curves ? { x: pt.x, y: pt.y, smooth: true } : { x: pt.x, y: pt.y });
  switch (e.type) {
    case "click": {
      if (e.onFirst && isClosedKind(s.kind) && n >= 3) {
        const vertices = e.smooth && curves ? s.vertices.map((v, i): DrawVertex => (i === 0 ? { ...v, smooth: true } : v)) : s.vertices;
        return { state: s, done: finish(vertices) };
      }
      const last = s.vertices[n - 1];
      if (last && Math.hypot(last.x - e.pt.x, last.y - e.pt.y) < 1e-6) return { state: s, done: null };
      return drawing([...s.vertices, placed(e.pt, e.smooth)]);
    }
    case "double-click": {
      const last = s.vertices[n - 1];
      const vertices = last && Math.hypot(last.x - e.pt.x, last.y - e.pt.y) < 1e-6 ? s.vertices : smoothed([...s.vertices, placed(e.pt, e.smooth)], false);
      return { state: { ...s, vertices }, done: vertices.length >= minVertices(s.kind) ? finish(vertices) : null };
    }
    case "enter":
      return { state: s, done: n >= minVertices(s.kind) ? finish(s.vertices) : null };
    case "move-vertex": {
      if (e.index < 0 || e.index >= n) return { state: s, done: null };
      const vertices = [...s.vertices];
      vertices[e.index] = { ...vertices[e.index], x: e.pt.x, y: e.pt.y };
      return drawing(vertices);
    }
    case "pull-handles": {
      // A filter region is a polygon (the schema refuses handles).
      if (e.index < 0 || e.index >= n || !curves) return { state: s, done: null };
      // The manual pull wins: the vertex is no longer smooth, its pulled handles stay.
      const vertices = s.vertices.map((v, i) => (i === e.index ? stored(v) : v));
      return drawing(symmetricHandles(vertices, e.index, e.shift ? constrain45(e.vec) : e.vec));
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
