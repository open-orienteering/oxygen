/**
 * Pure edits of a course object's vertex path (docs/course-editor.md §7
 * "Editing geometry"; 08 §4.5; `course-layer.md` §8.1): paper mm, each
 * vertex with optional Bézier handles `hIn` / `hOut` as offsets from it. A
 * segment is a cubic when either end has its handle (the layer's
 * `vertexPath`), else straight. Every function returns a new array and
 * leaves untouched vertices as they were.
 */

type Pt = { x: number; y: number };

/** A stored vertex (`PathVertex`). */
export interface Vertex { x: number; y: number; hIn?: Pt; hOut?: Pt }

/** The UI layer samples each curved segment in this many steps. */
export const CURVE_STEPS = 8;

const EPS = 1e-6;

/**
 * What a kind's path allows (`courseObjectBodySchema`): its vertex count
 * and whether the editor curves it — a filter region is a polygon (the
 * schema refuses handles), a text its anchor, an image two corners.
 */
export function vertexRule(kind: string): { min: number; max: number; curves: boolean; closed: boolean } {
  switch (kind) {
    case "oob_line": case "marked_route": case "inset_frame": return { min: 2, max: Infinity, curves: true, closed: false };
    case "text": return { min: 1, max: 1, curves: false, closed: false };
    case "image": return { min: 2, max: 2, curves: false, closed: false };
    case "filter_region": return { min: 3, max: Infinity, curves: false, closed: true };
    default: return { min: 3, max: Infinity, curves: true, closed: true };
  }
}
const lerp = (a: Pt, b: Pt, t: number): Pt => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
const len = (v: Pt) => Math.hypot(v.x, v.y);
const sub = (a: Pt, b: Pt): Pt => ({ x: a.x - b.x, y: a.y - b.y });
const neg = (v: Pt): Pt => ({ x: -v.x, y: -v.y });

export const hasHandles = (v: Vertex): boolean => !!(v.hIn || v.hOut);
const isCurve = (a: Vertex, b: Vertex) => !!(a.hOut || b.hIn);

/** `v` with its handles set; a missing or zero-length handle is dropped. */
function withHandles(v: Vertex, hIn: Pt | undefined, hOut: Pt | undefined): Vertex {
  const out: Vertex = { x: v.x, y: v.y };
  if (hIn && len(hIn) > EPS) out.hIn = hIn;
  if (hOut && len(hOut) > EPS) out.hOut = hOut;
  return out;
}

/** The cubic's four points (absolute) for the segment a → b. */
function controls(a: Vertex, b: Vertex): [Pt, Pt, Pt, Pt] {
  const p0 = { x: a.x, y: a.y }, p3 = { x: b.x, y: b.y };
  return [p0, a.hOut ? { x: a.x + a.hOut.x, y: a.y + a.hOut.y } : p0, b.hIn ? { x: b.x + b.hIn.x, y: b.y + b.hIn.y } : p3, p3];
}

function cubicAt([p0, p1, p2, p3]: [Pt, Pt, Pt, Pt], t: number): Pt {
  const u = 1 - t;
  const a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
  return { x: a * p0.x + b * p1.x + c * p2.x + d * p3.x, y: a * p0.y + b * p1.y + c * p2.y + d * p3.y };
}

/** The points after `a` up to and including `b`: `b` alone when straight, `steps` samples of the cubic when curved. */
export function sampleSegment(a: Vertex, b: Vertex, steps = CURVE_STEPS): Pt[] {
  if (!isCurve(a, b)) return [{ x: b.x, y: b.y }];
  const c = controls(a, b);
  return Array.from({ length: steps }, (_, i) => (i === steps - 1 ? { x: b.x, y: b.y } : cubicAt(c, (i + 1) / steps)));
}

/**
 * The outline the UI layer draws: the vertices with every curved segment
 * sampled. A closed path's straight closing segment is left to the
 * drawing's own close; a curved one is sampled back to the first vertex.
 */
export function outlinePoints(g: readonly Vertex[], closed: boolean): Pt[] {
  if (g.length === 0) return [];
  const out: Pt[] = [{ x: g[0].x, y: g[0].y }];
  for (let i = 1; i < g.length; i++) out.push(...sampleSegment(g[i - 1], g[i]));
  const last = g[g.length - 1];
  if (closed && g.length > 1 && isCurve(last, g[0])) out.push(...sampleSegment(last, g[0]));
  return out;
}

/** The segments of a path: `index` runs from vertex `index` to the next (the last one back to 0 when closed). */
const segmentCount = (g: readonly Vertex[], closed: boolean) => (g.length < 2 ? 0 : closed && g.length > 2 ? g.length : g.length - 1);

export interface EdgeHit { index: number; t: number; dist: number; point: Pt }

/** The nearest point on the path to `p`: which segment, where along it (0..1), how far. Null without a segment. */
export function nearestEdge(g: readonly Vertex[], closed: boolean, p: Pt): EdgeHit | null {
  let best: EdgeHit | null = null;
  for (let i = 0; i < segmentCount(g, closed); i++) {
    const a = g[i], b = g[(i + 1) % g.length];
    let t: number;
    if (!isCurve(a, b)) {
      const d = sub(b, a), l2 = d.x * d.x + d.y * d.y;
      t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * d.x + (p.y - a.y) * d.y) / l2));
    } else {
      const c = controls(a, b);
      const dist = (s: number) => len(sub(cubicAt(c, s), p));
      // Coarse samples, then a ternary refinement around the best one.
      const n = 64;
      let k = 0;
      for (let j = 1; j <= n; j++) if (dist(j / n) < dist(k / n)) k = j;
      let lo = Math.max(0, (k - 1) / n), hi = Math.min(1, (k + 1) / n);
      for (let j = 0; j < 40; j++) {
        const m1 = lo + (hi - lo) / 3, m2 = hi - (hi - lo) / 3;
        if (dist(m1) < dist(m2)) hi = m2;
        else lo = m1;
      }
      t = (lo + hi) / 2;
    }
    const point = isCurve(a, b) ? cubicAt(controls(a, b), t) : lerp(a, b, t);
    const dist = len(sub(point, p));
    if (!best || dist < best.dist) best = { index: i, t, dist, point };
  }
  return best;
}

/**
 * A vertex inserted on segment `index` at `t`. A straight segment gets a
 * corner; a curve is split (de Casteljau) so the shape stays as it was —
 * the new vertex smooth, the ends' facing handles shortened.
 */
export function insertVertex(g: readonly Vertex[], closed: boolean, index: number, t: number): Vertex[] {
  if (index < 0 || index >= segmentCount(g, closed)) return [...g];
  const ia = index, ib = (index + 1) % g.length;
  const a = g[ia], b = g[ib];
  const out = [...g];
  if (!isCurve(a, b)) {
    const m = lerp(a, b, t);
    out.splice(ia + 1, 0, { x: m.x, y: m.y });
    return out;
  }
  const [p0, p1, p2, p3] = controls(a, b);
  const p01 = lerp(p0, p1, t), p12 = lerp(p1, p2, t), p23 = lerp(p2, p3, t);
  const p012 = lerp(p01, p12, t), p123 = lerp(p12, p23, t);
  const m = lerp(p012, p123, t);
  out[ia] = withHandles(a, a.hIn, sub(p01, p0));
  out[ib] = withHandles(out[ib], sub(p23, p3), out[ib].hOut);
  out.splice(ia + 1, 0, withHandles(m, sub(p012, m), sub(p123, m)));
  return out;
}

/** The path without vertex `index`; null when that would leave fewer than `min` (the kind's minimum) or the index is out of range. */
export function deleteVertex(g: readonly Vertex[], index: number, min: number): Vertex[] | null {
  if (index < 0 || index >= g.length || g.length <= min) return null;
  return g.filter((_, i) => i !== index);
}

/** Alt-drag on a vertex: `hOut` = the drag vector, `hIn` its negation; a zero vector retracts both. */
export function symmetricHandles(g: readonly Vertex[], index: number, vec: Pt): Vertex[] {
  return g.map((v, i) => (i === index ? withHandles(v, neg(vec), vec) : v));
}

/**
 * A smooth vertex (the default while drawing and inserting, F18;
 * docs/course-editor.md §6.4, §7): uniform
 * Catmull-Rom handles from its neighbours — `hOut = (next − prev) / 6`,
 * `hIn = −hOut`. A closed path of three or more vertices wraps (the first
 * vertex's prev is the last); a vertex without both neighbours (an open
 * path's ends) is a corner. Other vertices are untouched.
 */
export function smoothHandles(g: readonly Vertex[], index: number, closed: boolean): Vertex[] {
  const n = g.length;
  if (index < 0 || index >= n) return [...g];
  const wrap = closed && n >= 3;
  const prev = index > 0 ? g[index - 1] : wrap ? g[n - 1] : undefined;
  const next = index < n - 1 ? g[index + 1] : wrap ? g[0] : undefined;
  const hOut = prev && next ? { x: (next.x - prev.x) / 6, y: (next.y - prev.y) / 6 } : undefined;
  return g.map((v, i) => (i === index ? withHandles(v, hOut && neg(hOut), hOut) : v));
}

/** A vertex back to a corner (its handles dropped). */
export function retractHandles(g: readonly Vertex[], index: number): Vertex[] {
  return g.map((v, i) => (i === index ? withHandles(v, undefined, undefined) : v));
}

/**
 * Alt-click on a vertex (F18, docs/course-editor.md §7): one with a handle
 * becomes a corner (`retractHandles`), a corner smooth (`smoothHandles`,
 * `closed` wrapping the ends). Null when nothing would change — an open
 * path's end corner (it has no smooth form), an index out of range.
 */
export function toggleSmooth(g: readonly Vertex[], index: number, closed: boolean): Vertex[] | null {
  if (index < 0 || index >= g.length) return null;
  if (hasHandles(g[index])) return retractHandles(g, index);
  const out = smoothHandles(g, index, closed);
  return hasHandles(out[index]) ? out : null;
}

/**
 * A handle grip dragged to `vec` (its new offset from the vertex). Without
 * `alt` a mirrored pair stays mirrored and a smooth pair (opposite,
 * different lengths) stays smooth with the other's length kept; `alt`
 * breaks the pair, and a broken pair (or a lone handle) moves alone.
 */
export function dragGrip(g: readonly Vertex[], index: number, which: "in" | "out", vec: Pt, alt: boolean): Vertex[] {
  return g.map((v, i) => {
    if (i !== index) return v;
    const cur = which === "out" ? v.hOut : v.hIn;
    const other = which === "out" ? v.hIn : v.hOut;
    let next = other;
    if (!alt && cur && other) {
      const mirrored = len({ x: cur.x + other.x, y: cur.y + other.y }) < EPS * Math.max(1, len(cur));
      const cross = cur.x * other.y - cur.y * other.x;
      const smooth = Math.abs(cross) < 1e-6 * Math.max(1, len(cur) * len(other)) && cur.x * other.x + cur.y * other.y < 0;
      if (mirrored) next = neg(vec);
      else if (smooth && len(vec) > EPS) next = { x: (-vec.x / len(vec)) * len(other), y: (-vec.y / len(vec)) * len(other) };
    }
    return which === "out" ? withHandles(v, next, vec) : withHandles(v, vec, next);
  });
}

/**
 * The path through an affine map `f` (a page ↔ view transform): each vertex
 * mapped, each handle as `f(v + h) − f(v)` — exact for an affine map, so the
 * curve maps onto the curve.
 */
export function mapVertices(g: readonly Vertex[], f: (p: Pt) => Pt): Vertex[] {
  return g.map((v) => {
    const at = f(v);
    const handle = (h: Pt | undefined) => {
      if (!h) return undefined;
      const tip = f({ x: v.x + h.x, y: v.y + h.y });
      return { x: tip.x - at.x, y: tip.y - at.y };
    };
    return withHandles(at, handle(v.hIn), handle(v.hOut));
  });
}

/** Shift: the vector turned to the nearest multiple of 45°, its length kept. */
export function constrain45(v: Pt): Pt {
  const l = len(v);
  if (l < EPS) return v;
  const a = Math.round(Math.atan2(v.y, v.x) / (Math.PI / 4)) * (Math.PI / 4);
  return { x: l * Math.cos(a), y: l * Math.sin(a) };
}
