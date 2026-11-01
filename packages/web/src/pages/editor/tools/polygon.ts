/**
 * The area tools' drawing flow (docs/course-editor.md §6.4; 08 §5.3
 * "Area tools"): click per vertex, drag a vertex to adjust before closing,
 * close by double-click or a click on the first vertex, `Esc` cancels.
 * Line kinds (out-of-bounds line, marked route) finish by double-click or
 * `Enter` instead of closing. Pure: the page creates the object when
 * `step` reports `done`.
 */

type Pt = { x: number; y: number };

export type AreaKind = "oob_area" | "oob_line" | "whiteout" | "filter_region" | "marked_route";

/** Closed kinds need three vertices, line kinds two. */
export const isClosedKind = (k: AreaKind): boolean => k !== "oob_line" && k !== "marked_route";
export const minVertices = (k: AreaKind): number => (isClosedKind(k) ? 3 : 2);

export interface PolygonState {
  kind: AreaKind;
  vertices: Pt[];
}

export type PolygonEvent =
  | { type: "click"; pt: Pt; /** The click is within the snap distance of the first vertex. */ onFirst: boolean }
  | { type: "double-click"; pt: Pt }
  | { type: "move-vertex"; index: number; pt: Pt }
  | { type: "enter" };

export type PolygonStep = { state: PolygonState; done: Pt[] | null };

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
      vertices[e.index] = e.pt;
      return { state: { ...s, vertices }, done: null };
    }
  }
}

/** Convex hull (Andrew's monotone chain), counter-clockwise, without collinear points. */
export function convexHull(points: readonly Pt[]): Pt[] {
  const pts = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  if (pts.length < 3) return pts;
  const cross = (o: Pt, a: Pt, b: Pt) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: Pt[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: Pt[] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

/**
 * The toner saver's hull around a course (08 §4.5): every site offset by
 * `marginMm` in eight directions, then the convex hull — an octagon-rounded
 * hull at least `marginMm` from every site, editable afterwards. Null with
 * no positioned site.
 */
export function tonerSaverHull(sites: readonly Pt[], marginMm: number): Pt[] | null {
  if (sites.length === 0) return null;
  const ring: Pt[] = [];
  // The octagon's circumradius so its edges stay `marginMm` from the centre.
  const r = marginMm / Math.cos(Math.PI / 8);
  for (const s of sites) {
    for (let k = 0; k < 8; k++) {
      const a = (Math.PI / 4) * k + Math.PI / 8;
      ring.push({ x: s.x + r * Math.cos(a), y: s.y + r * Math.sin(a) });
    }
  }
  return convexHull(ring).map((p) => ({ x: Math.round(p.x * 1000) / 1000, y: Math.round(p.y * 1000) / 1000 }));
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
