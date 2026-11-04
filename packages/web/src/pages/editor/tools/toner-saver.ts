/**
 * The toner saver's outline (docs/course-editor.md §6.4; 08 §4.5): the exact
 * offset hull of the course's sites. The convex hull of the site centres
 * (one site is a circle, two a stadium), offset outward by the margin: a
 * straight edge parallel to every hull edge, and at every hull vertex an
 * arc of radius = margin between the two edge normals, in pieces of at most
 * 90° — each a cubic whose handle is (4/3)·tan(θ/4)·r, the formula of
 * `shared/src/course/arcs.ts`. Paper mm, `PathVertex` shape (handles
 * relative to their vertex), so the course layer and the print draw the
 * curves as they are stored.
 */

import type { Vertex } from "../../../lib/editor/geometry-edit";

type Pt = { x: number; y: number };

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

/** The toner saver's default margin around the course, paper mm (feedback 2026-11-04: 25). */
export const TONER_MARGIN_MM = 25;

/** Paper mm rounded to a micrometre, as everywhere an object's geometry is stored. */
const um = (n: number): number => Math.round(n * 1000) / 1000 + 0; // + 0 folds -0 into 0
const TWO_PI = Math.PI * 2;

/**
 * The closed outline of the toner saver for `sites` (paper mm) and `marginMm`:
 * every site is at least the margin inside it. Null with no site (or, with a
 * zero margin, fewer than three hull points: nothing to draw).
 */
export function tonerSaverGeometry(sites: readonly Pt[], marginMm: number): Vertex[] | null {
  const seen = new Set<string>();
  const unique = sites.filter((s) => {
    const key = `${um(s.x)},${um(s.y)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (unique.length === 0) return null;
  const hull = convexHull(unique);
  const r = Math.max(0, marginMm);
  if (r === 0) return hull.length >= 3 ? hull.map((p) => ({ x: um(p.x), y: um(p.y) })) : null;

  /** One arc around `c` from angle `a0` sweeping `sweep` ≥ 0 (counter-clockwise), ≤ 90° per cubic. */
  const arc = (c: Pt, a0: number, sweep: number): Vertex[] => {
    const n = Math.max(1, Math.ceil(sweep / (Math.PI / 2) - 1e-9));
    const step = sweep / n;
    const k = (4 / 3) * Math.tan(step / 4) * r;
    const out: Vertex[] = [];
    for (let j = 0; j <= n; j++) {
      const a = a0 + j * step;
      const v: Vertex = { x: um(c.x + r * Math.cos(a)), y: um(c.y + r * Math.sin(a)) };
      if (j > 0) v.hIn = { x: um(k * Math.sin(a)), y: um(-k * Math.cos(a)) };
      if (j < n) v.hOut = { x: um(-k * Math.sin(a)), y: um(k * Math.cos(a)) };
      out.push(v);
    }
    return out;
  };

  if (hull.length === 1) {
    // A circle: four quarter arcs, closed on the first vertex.
    const quarters = [0, 1, 2, 3].map((q) => arc(hull[0], (q * Math.PI) / 2, Math.PI / 2));
    return quarters.map((q, i) => ({ ...q[0], hIn: quarters[(i + 3) % 4][1].hIn }));
  }

  // The outward normal's angle of the edge leaving each hull vertex (counter-clockwise hull: the right-hand normal).
  const normal = hull.map((p, i) => {
    const q = hull[(i + 1) % hull.length];
    return Math.atan2(-(q.x - p.x), q.y - p.y);
  });
  const out: Vertex[] = [];
  hull.forEach((p, i) => {
    const prev = normal[(i + hull.length - 1) % hull.length];
    let sweep = (normal[i] - prev) % TWO_PI;
    if (sweep < 0) sweep += TWO_PI;
    // A hull turns by at most 180°: a "turn" near 360° is float noise on a (nearly) straight vertex.
    if (sweep > Math.PI + 1e-6 || sweep < 1e-9) out.push({ x: um(p.x + r * Math.cos(normal[i])), y: um(p.y + r * Math.sin(normal[i])) });
    else out.push(...arc(p, prev, sweep));
  });
  return out;
}
