/**
 * The area tools' drawing flow (docs/course-editor.md §6.4; 08 §5.3
 * "Area tools"): click per vertex, drag a vertex to adjust before closing,
 * close by double-click or a click on the first vertex, `Esc` cancels.
 * Line kinds (out-of-bounds line, marked route) finish by double-click or
 * `Enter` instead of closing. Smooth by default, Alt for sharp (F18): a
 * placed vertex is smooth, its handles following its neighbours
 * (`smoothHandles`), settled after every step and wrapped at close (an open
 * end is a corner); Alt at the press (`corner`) places a corner; a
 * click-drag pulls symmetric handles by hand (`pull-handles`, `pulled`).
 * The flags are drawing state only and `done` carries stored vertices
 * without them; kinds without curves (a filter region) are polygons. Pure:
 * the page creates the object when `step` reports `done`.
 */

import { constrain45, smoothHandles, symmetricHandles, vertexRule, type Vertex } from "../../../lib/editor/geometry-edit";

type Pt = { x: number; y: number };

/** The course editor's drawn kinds, and Layout mode's `P` polygon (`layout_path`, a closed page path, docs/course-layout.md §3). */
export type AreaKind = "oob_area" | "oob_line" | "whiteout" | "filter_region" | "marked_route" | "layout_path";

/** Closed kinds need three vertices, line kinds two. */
export const isClosedKind = (k: AreaKind): boolean => k !== "oob_line" && k !== "marked_route";
export const minVertices = (k: AreaKind): number => (isClosedKind(k) ? 3 : 2);

/**
 * A vertex while drawing: a stored `Vertex` plus the drawing-only flags (never stored) — `corner` (Alt at the
 * press), `pulled` (its handles pulled by a click-drag). Neither: smooth.
 */
export type DrawVertex = Vertex & { corner?: true; pulled?: true };

export interface PolygonState {
  kind: AreaKind;
  vertices: DrawVertex[];
}

export type PolygonEvent =
  | {
    type: "click"; pt: Pt; /** The click is within the snap distance of the first vertex. */ onFirst: boolean;
    /** Alt held: the vertex placed (or, closing, the first vertex) is a corner; kinds without curves ignore it. */ corner?: boolean;
  }
  | { type: "double-click"; pt: Pt; /** Alt held: the double-click's vertex is a corner. */ corner?: boolean }
  | { type: "move-vertex"; index: number; pt: Pt }
  /**
   * Click-drag: symmetric handles on vertex `index` — `hOut` = `vec`, `hIn` its negation; `shift` turns it to 45°. A
   * zero `vec` (the drag back within 3 px) returns the vertex to its press's kind.
   */
  | { type: "pull-handles"; index: number; vec: Pt; shift: boolean }
  | { type: "enter" };

export type PolygonStep = { state: PolygonState; done: Vertex[] | null };

/**
 * Every smooth vertex's handles (neither `corner` nor `pulled`) recomputed
 * from its current neighbours (`smoothHandles`); `closed` wraps the ends.
 * A kind without curves (`curves` false) is returned as it is. The preview
 * calls it with the hover point appended.
 */
export function smoothed(vertices: readonly DrawVertex[], closed: boolean, curves = true): DrawVertex[] {
  if (!curves) return [...vertices];
  let out: DrawVertex[] = [...vertices];
  vertices.forEach((v, i) => {
    if (v.corner || v.pulled) return;
    out = smoothHandles(out, i, closed);
  });
  return out;
}

/** The stored vertex: the drawing-only flags dropped. */
const stored = ({ corner: _corner, pulled: _pulled, ...v }: DrawVertex): Vertex => v;

/**
 * One step. `done` is the finished geometry when the flow closes (or a
 * line ends) — smooth vertices settled with the closing wrap, the flags
 * stripped; null while drawing. A double-click's second click arrives as
 * a `click` first, at the same point: it is not added twice.
 */
export function step(s: PolygonState, e: PolygonEvent): PolygonStep {
  const n = s.vertices.length;
  const curves = vertexRule(s.kind).curves;
  const drawing = (vertices: DrawVertex[]): PolygonStep => ({ state: { ...s, vertices: smoothed(vertices, false, curves) }, done: null });
  const finish = (vertices: readonly DrawVertex[]): Vertex[] => smoothed(vertices, isClosedKind(s.kind), curves).map(stored);
  const placed = (pt: Pt, corner?: boolean): DrawVertex => (corner && curves ? { x: pt.x, y: pt.y, corner: true } : { x: pt.x, y: pt.y });
  switch (e.type) {
    case "click": {
      if (e.onFirst && isClosedKind(s.kind) && n >= 3) {
        // Alt on the closing click makes the first vertex a corner (a pulled one keeps its handles).
        const vertices = e.corner && curves
          ? s.vertices.map((v, i): DrawVertex => (i === 0 && !v.pulled ? { x: v.x, y: v.y, corner: true } : v))
          : s.vertices;
        return { state: s, done: finish(vertices) };
      }
      const last = s.vertices[n - 1];
      if (last && Math.hypot(last.x - e.pt.x, last.y - e.pt.y) < 1e-6) return { state: s, done: null };
      return drawing([...s.vertices, placed(e.pt, e.corner)]);
    }
    case "double-click": {
      const last = s.vertices[n - 1];
      const vertices = last && Math.hypot(last.x - e.pt.x, last.y - e.pt.y) < 1e-6 ? s.vertices : smoothed([...s.vertices, placed(e.pt, e.corner)], false, curves);
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
      // The manual pull wins: the pulled handles stay until the drag comes back to zero, which returns the vertex to
      // its press's kind (smooth, or a corner with Alt; corner kept through the pull).
      const vec = e.shift ? constrain45(e.vec) : e.vec;
      const pulled = Math.hypot(vec.x, vec.y) > 1e-9;
      const corner = s.vertices[e.index].corner;
      const vertices = symmetricHandles(s.vertices, e.index, vec).map((v, i): DrawVertex => {
        if (i !== e.index) return v;
        return { ...v, ...(corner ? { corner } : {}), ...(pulled ? { pulled: true as const } : {}) };
      });
      return drawing(vertices);
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
