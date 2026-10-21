/**
 * WebGL2 backend, CPU side: pass stream → GPU-ready vertex data. Pure
 * TypeScript over typed arrays (no GL calls), so it can run in a worker
 * and is unit-tested without a context.
 *
 * Everything here is a *backend* decision (docs/map-rendering.md §1):
 * flattening tolerance, how a stroke becomes triangles, how an even-odd
 * fill is expressed for the stencil buffer. Nothing here moves a dash or
 * a glyph — those positions arrive in the stream.
 *
 * Geometry conventions
 * - Coordinates stay in paper µm, y-up; the vertex shader projects.
 * - Fills are drawn with the stencil even-odd trick: a triangle fan from
 *   a fixed origin over every ring edge (`fan`), inverting the stencil,
 *   then a bounding quad (`cover`) painted where the stencil is set.
 *   No triangulation, exact even-odd, holes for free.
 * - Strokes are extruded here only *directionally*: each vertex carries
 *   the centre-line point and an offset vector of unit length (or the
 *   mitre vector); the shader multiplies by the half width, so the same
 *   buffer serves every zoom and the on-screen minimum width is a
 *   uniform.
 */

import earcut from "earcut";
import { render } from "@oxygen/shared";

type RenderPath = render.RenderPath;
type GlyphMesh = render.GlyphMesh;

export interface PrepareOptions {
  /** Flattening tolerance for Béziers, paper µm. */
  toleranceUm?: number;
  /** Fonts for text passes; a text pass without its font is skipped. */
  fonts?: render.FontMetrics[];
}

export interface FanGeometry {
  /** Triangles (x, y)×3 per triangle, in the fan's own units. */
  fan: Float32Array;
  /** Two triangles covering the bounds. */
  cover: Float32Array;
  /** The flattened rings the fan was built from (outer first, then holes); for triangulating batches. */
  rings: number[][];
}

export interface StrokeGeometry {
  /** Per vertex: x, y, ox, oy — point and offset direction (triangles). */
  verts: Float32Array;
  halfWidth: number;
}

export interface PreparedFill {
  kind: "fill";
  colour: number;
  geometry: FanGeometry;
}

export interface PreparedStroke {
  kind: "stroke";
  colour: number;
  geometry: StrokeGeometry;
}

export interface PreparedHatch {
  kind: "hatch";
  colour: number;
  geometry: FanGeometry;
  widthUm: number;
  spacingUm: number;
  offsetUm: number;
  angleDeg: number;
}

export interface PreparedInstanced {
  kind: "instanced";
  colour: number;
  /** x, y, cos, sin, scale per instance. */
  instances: Float32Array;
  /** Fill parts of the mesh, glyph-local units (stencil even-odd, instanced). */
  fill?: FanGeometry;
  /** Stroke parts of the mesh, glyph-local units; half widths in glyph units. */
  strokes: StrokeGeometry[];
  /** Pattern clip mode: instances are visible only inside this area. */
  clip?: FanGeometry;
}

export type Prepared = PreparedFill | PreparedStroke | PreparedHatch | PreparedInstanced;

export interface PreparedStream {
  items: Prepared[];
  /** Paper bounds of everything prepared, µm. */
  bounds: render.Bounds | undefined;
}

const DEFAULT_TOLERANCE_UM = 10;

export function prepareStream(stream: render.PassStream, opts: PrepareOptions = {}): PreparedStream {
  const tol = opts.toleranceUm ?? DEFAULT_TOLERANCE_UM;
  const meshes = new Map<string, GlyphMesh>();
  for (const m of stream.glyphTable) meshes.set(`${m.glyphId}/${m.partIdx}`, m);
  const fonts = new Map<number, render.FontMetrics>();
  stream.fontTable.forEach((ref) => {
    const f = opts.fonts?.find((x) => x.family === ref.family);
    if (f) fonts.set(ref.fontId, f);
  });
  const meshGeomCache = new Map<string, { fill?: FanGeometry; strokes: StrokeGeometry[] }>();
  const textGeomCache = new Map<string, FanGeometry | StrokeGeometry>();
  const items: Prepared[] = [];
  const bounds = render.passStreamBounds(stream);

  for (const pass of stream.passes) {
    switch (pass.kind) {
      case "fill":
        items.push({ kind: "fill", colour: pass.colour, geometry: fanGeometry(pass.path, tol) });
        break;
      case "stroke":
        items.push({ kind: "stroke", colour: pass.colour, geometry: strokeGeometry(pass, tol) });
        break;
      case "hatch":
        items.push({
          kind: "hatch",
          colour: pass.colour,
          geometry: fanGeometry(pass.path, tol),
          widthUm: pass.widthUm,
          spacingUm: pass.spacingUm,
          offsetUm: pass.offsetUm,
          angleDeg: pass.angleDeg,
        });
        break;
      case "glyph": {
        const key = `${pass.glyphId}/${pass.partIdx}`;
        const mesh = meshes.get(key);
        if (!mesh) break;
        let geom = meshGeomCache.get(key);
        if (!geom) {
          geom = meshGeometry(mesh, tol);
          meshGeomCache.set(key, geom);
        }
        items.push({
          kind: "instanced",
          colour: pass.colour,
          instances: pass.instances,
          ...(geom.fill ? { fill: geom.fill } : {}),
          strokes: geom.strokes,
          ...(pass.clip ? { clip: fanGeometry(pass.clip, tol) } : {}),
        });
        break;
      }
      case "text":
        items.push(...textItems(pass, fonts.get(pass.fontId), tol, textGeomCache));
        break;
    }
  }
  return { items, bounds };
}

// ---- fills ---------------------------------------------------------------

/** Stencil-fan geometry for an even-odd fill of a (multi-ring) path. */
export function fanGeometry(path: RenderPath, tol: number): FanGeometry {
  const rings = render.flattenRings(path, tol);
  return fanFromRings(rings);
}

export function fanFromRings(rings: number[][]): FanGeometry {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  let triCount = 0;
  for (const r of rings) {
    const n = r.length / 2;
    if (n < 2) continue;
    triCount += n;
    for (let i = 0; i < r.length; i += 2) {
      const x = r[i], y = r[i + 1];
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (triCount === 0) return { fan: new Float32Array(0), cover: new Float32Array(0), rings: [] };
  // Fan origin outside the geometry keeps every triangle well-formed and
  // makes the parity argument obvious: a point is inside iff an odd number
  // of (origin, vi, vi+1) triangles cover it.
  const ox = minX - 1, oy = minY - 1;
  const fan = new Float32Array(triCount * 6);
  let k = 0;
  for (const r of rings) {
    const n = r.length / 2;
    if (n < 2) continue;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      fan[k++] = ox; fan[k++] = oy;
      fan[k++] = r[2 * i]; fan[k++] = r[2 * i + 1];
      fan[k++] = r[2 * j]; fan[k++] = r[2 * j + 1];
    }
  }
  const cover = Float32Array.from([minX, minY, maxX, minY, maxX, maxY, minX, minY, maxX, maxY, minX, maxY]);
  return { fan, cover, rings };
}

// ---- strokes -------------------------------------------------------------

export const ROUND_STEPS_PER_PI = 8;
export const MITRE_LIMIT = 4;

/** Polylines (x,y pairs) a stroke pass draws: the whole path per ring, or one per slice. */
export function strokePolylines(pass: render.StrokePass, tol: number): { pts: number[]; closed: boolean }[] {
  if (!pass.slices) {
    return render.flattenRings(pass.path, tol).map((pts) => ({ pts, closed: pass.path.closed }));
  }
  // `render.sliceSegments` walks the path once per slice; a dashed line has many, so the segments
  // are built once here and each slice is cut from them with the same `segmentSub` (§3.2).
  const segs = render.pathSegments(pass.path);
  return pass.slices
    .map((sl) => ({ pts: render.flattenSegments(sliceOf(segs, sl), tol), closed: false }))
    .filter((p) => p.pts.length >= 4);
}

/** `render.sliceSegments` over already-built segments. */
function sliceOf(segs: render.Segment[], slice: render.Slice): render.Segment[] {
  if (slice.seg0 > slice.seg1 || (slice.seg0 === slice.seg1 && slice.t0 >= slice.t1)) return [];
  const out: render.Segment[] = [];
  for (let i = slice.seg0; i <= slice.seg1 && i < segs.length; i++) {
    const t0 = i === slice.seg0 ? slice.t0 : 0;
    const t1 = i === slice.seg1 ? slice.t1 : 1;
    if (t1 <= t0) continue;
    out.push(t0 === 0 && t1 === 1 ? segs[i] : render.segmentSub(segs[i], t0, t1));
  }
  return out;
}

export function strokeGeometry(pass: render.StrokePass, tol: number): StrokeGeometry {
  const out: number[] = [];
  for (const { pts, closed } of strokePolylines(pass, tol)) {
    extrudePolyline(pts, closed, pass.cap === "pointed" ? "butt" : pass.cap, pass.join, out);
  }
  return { verts: Float32Array.from(out), halfWidth: pass.widthUm / 2 };
}

function push(out: number[], x: number, y: number, ox: number, oy: number): void {
  out.push(x, y, ox, oy);
}

/**
 * Emits triangles for a polyline: one quad per segment, a join wedge per
 * interior vertex, caps at open ends. Offsets are unit (or mitre) vectors;
 * the shader scales them by the half width.
 */
export function extrudePolyline(
  pts: number[],
  closed: boolean,
  cap: render.StrokeCap,
  join: render.StrokeJoin,
  out: number[],
): void {
  // Drop consecutive duplicates.
  const p: number[] = [];
  for (let i = 0; i < pts.length; i += 2) {
    if (p.length && p[p.length - 2] === pts[i] && p[p.length - 1] === pts[i + 1]) continue;
    p.push(pts[i], pts[i + 1]);
  }
  if (closed && p.length >= 4 && p[0] === p[p.length - 2] && p[1] === p[p.length - 1]) p.length -= 2;
  const n = p.length / 2;
  if (n < 2) {
    if (n === 1 && cap === "round") roundDot(p[0], p[1], out);
    return;
  }
  const segCount = closed ? n : n - 1;
  const px = (i: number) => p[2 * ((i + n) % n)];
  const py = (i: number) => p[2 * ((i + n) % n) + 1];
  const dir = (i: number): [number, number] => {
    const dx = px(i + 1) - px(i), dy = py(i + 1) - py(i);
    const l = Math.hypot(dx, dy) || 1;
    return [dx / l, dy / l];
  };
  for (let i = 0; i < segCount; i++) {
    const [tx, ty] = dir(i);
    const nx = -ty, ny = tx;
    const ax = px(i), ay = py(i), bx = px(i + 1), by = py(i + 1);
    // Square caps extend the end quads by half a width along the tangent.
    const extA = !closed && i === 0 && cap === "square" ? 1 : 0;
    const extB = !closed && i === segCount - 1 && cap === "square" ? 1 : 0;
    const a1x = nx - extA * tx, a1y = ny - extA * ty, a2x = -nx - extA * tx, a2y = -ny - extA * ty;
    const b1x = nx + extB * tx, b1y = ny + extB * ty, b2x = -nx + extB * tx, b2y = -ny + extB * ty;
    push(out, ax, ay, a1x, a1y); push(out, bx, by, b1x, b1y); push(out, ax, ay, a2x, a2y);
    push(out, ax, ay, a2x, a2y); push(out, bx, by, b1x, b1y); push(out, bx, by, b2x, b2y);
  }
  // Joins.
  const joinStart = closed ? 0 : 1;
  const joinEnd = closed ? n : n - 1;
  for (let i = joinStart; i < joinEnd; i++) {
    const [t0x, t0y] = dir(i - 1);
    const [t1x, t1y] = dir(i);
    const cross = t0x * t1y - t0y * t1x;
    const dot = t0x * t1x + t0y * t1y;
    if (Math.abs(cross) < 1e-9 && dot > 0) continue; // straight
    const x = px(i), y = py(i);
    // Outer side is opposite to the turn direction.
    const s = cross > 0 ? -1 : 1;
    const n0x = -t0y * s, n0y = t0x * s;
    const n1x = -t1y * s, n1y = t1x * s;
    if (join === "round") {
      roundWedge(x, y, n0x, n0y, n1x, n1y, out);
    } else if (join === "miter") {
      const mx = n0x + n1x, my = n0y + n1y;
      const ml = Math.hypot(mx, my);
      const cosHalf = ml / 2;
      const mitre = cosHalf > 0 ? 1 / cosHalf : Infinity;
      if (mitre <= MITRE_LIMIT) {
        const ux = (mx / ml) * mitre, uy = (my / ml) * mitre;
        push(out, x, y, 0, 0); push(out, x, y, n0x, n0y); push(out, x, y, ux, uy);
        push(out, x, y, 0, 0); push(out, x, y, ux, uy); push(out, x, y, n1x, n1y);
      } else {
        push(out, x, y, 0, 0); push(out, x, y, n0x, n0y); push(out, x, y, n1x, n1y);
      }
    } else {
      push(out, x, y, 0, 0); push(out, x, y, n0x, n0y); push(out, x, y, n1x, n1y);
    }
  }
  // Round caps: a half circle from the left normal through −t (start) / from the right normal through +t (end).
  if (!closed && cap === "round") {
    const [t0x, t0y] = dir(0);
    roundArc(px(0), py(0), Math.atan2(t0x, -t0y), Math.PI, out);
    const [t1x, t1y] = dir(n - 2);
    roundArc(px(n - 1), py(n - 1), Math.atan2(-t1x, t1y), Math.PI, out);
  }
}

/** Join wedge: unit offsets swept the short way from n0 to n1. */
function roundWedge(x: number, y: number, n0x: number, n0y: number, n1x: number, n1y: number, out: number[]): void {
  const a0 = Math.atan2(n0y, n0x);
  let d = Math.atan2(n1y, n1x) - a0;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  roundArc(x, y, a0, d, out);
}

/** Fan of unit offsets from angle a0 sweeping `sweep` radians. */
function roundArc(x: number, y: number, a0: number, sweep: number, out: number[]): void {
  const steps = Math.max(1, Math.ceil((Math.abs(sweep) / Math.PI) * ROUND_STEPS_PER_PI));
  for (let k = 0; k < steps; k++) {
    const b0 = a0 + (sweep * k) / steps;
    const b1 = a0 + (sweep * (k + 1)) / steps;
    push(out, x, y, 0, 0);
    push(out, x, y, Math.cos(b0), Math.sin(b0));
    push(out, x, y, Math.cos(b1), Math.sin(b1));
  }
}

function roundDot(x: number, y: number, out: number[]): void {
  roundArc(x, y, 0, 2 * Math.PI, out);
}

// ---- glyph meshes and text ------------------------------------------------

function meshGeometry(mesh: GlyphMesh, tol: number): { fill?: FanGeometry; strokes: StrokeGeometry[] } {
  // Glyph-local geometry is small; flatten finer so instanced scale-ups stay smooth.
  const gt = Math.max(0.5, tol / 4);
  const rings = mesh.fills.flatMap((f) => render.flattenRings(f, gt));
  const fill = rings.length ? fanFromRings(rings) : undefined;
  const strokes = mesh.strokes.map((s) => {
    const out: number[] = [];
    for (const pts of render.flattenRings(s.path, gt)) extrudePolyline(pts, s.path.closed, s.cap, s.join, out);
    return { verts: Float32Array.from(out), halfWidth: s.widthUm / 2 };
  });
  return { ...(fill ? { fill } : {}), strokes };
}

/**
 * A text pass becomes one instanced item per distinct glyph id, geometry
 * in font units scaled by `sizeUm / unitsPerEm` through the instance
 * scale. A halo pass strokes the outlines instead of filling them.
 */
function textItems(
  pass: render.TextPass,
  font: render.FontMetrics | undefined,
  tol: number,
  cache: Map<string, FanGeometry | StrokeGeometry>,
): PreparedInstanced[] {
  if (!font || !font.outline) return [];
  const k = pass.sizeUm / font.unitsPerEm;
  const byGlyph = new Map<number, number[]>();
  for (let i = 0; i < pass.glyphs.length; i++) {
    const g = pass.glyphs[i];
    const arr = byGlyph.get(g) ?? [];
    // Per-glyph rotation about the glyph's origin (§3.5 `angles`, degrees CCW).
    const a = pass.angles ? (pass.angles[i] * Math.PI) / 180 : 0;
    arr.push(pass.positions[2 * i], pass.positions[2 * i + 1], Math.cos(a), Math.sin(a), k);
    byGlyph.set(g, arr);
  }
  const items: PreparedInstanced[] = [];
  // Geometry is cached per (font, glyph, size class, halo) so the same
  // letter in many passes shares one buffer and batches into one draw.
  const ft = Math.max(1, Math.round(tol / k / 2)); // tolerance in font units
  for (const [g, inst] of byGlyph) {
    if (pass.haloWidthUm) {
      const hw = pass.haloWidthUm / k;
      const key = `${font.family}/${g}/${ft}/halo${hw.toFixed(2)}`;
      let geom = cache.get(key) as StrokeGeometry | undefined;
      if (!geom) {
        const outline = font.outline(g);
        if (!outline) continue;
        const out: number[] = [];
        for (const r of render.flattenRings(outline, ft)) extrudePolyline(r, true, "round", "round", out);
        geom = { verts: Float32Array.from(out), halfWidth: hw };
        cache.set(key, geom);
      }
      items.push({ kind: "instanced", colour: pass.colour, instances: Float32Array.from(inst), strokes: [geom] });
    } else {
      const key = `${font.family}/${g}/${ft}/fill`;
      let geom = cache.get(key) as FanGeometry | undefined;
      if (!geom) {
        const outline = font.outline(g);
        if (!outline) continue;
        geom = fanFromRings(render.flattenRings(outline, ft));
        cache.set(key, geom);
      }
      items.push({ kind: "instanced", colour: pass.colour, instances: Float32Array.from(inst), fill: geom, strokes: [] });
    }
  }
  return items;
}

// ---- indexed strips (arena path) ------------------------------------------

/** Where `extrudeStrip` writes: vertices (centre-line point + offset direction) and triangles. */
export interface StripSink {
  /** Adds a vertex and returns its index. */
  vertex(x: number, y: number, ox: number, oy: number): number;
  triangle(a: number, b: number, c: number): void;
}

/**
 * Indexed stroke geometry in plain arrays: per vertex `x, y, ox, oy`
 * (centre-line point and offset direction, the shader multiplies by the
 * half width) plus a triangle index list. A polyline point whose join is
 * (to within `JOIN_SHARE_TOLERANCE` of the half width) a mitre shares one
 * vertex pair between its two segments — two vertices per point, the
 * strip of S1 §4.1. Real corners get separate pairs and a join wedge;
 * caps are extra vertices at the ends. The arena path writes through its
 * own `StripSink` straight into packed buffers.
 */
export class StripGeometry implements StripSink {
  verts: number[] = [];
  indices: number[] = [];
  vertex(x: number, y: number, ox: number, oy: number): number {
    this.verts.push(x, y, ox, oy);
    return this.verts.length / 4 - 1;
  }
  triangle(a: number, b: number, c: number): void {
    this.indices.push(a, b, c);
  }
}

/** Scratch arrays reused across `extrudeStrip` calls (dashes make many small calls). */
const scratch = { p: new Float64Array(256), tx: new Float64Array(128), ty: new Float64Array(128), len: new Float64Array(128), pairs: new Int32Array(512) };
function ensureScratch(points: number): void {
  if (scratch.p.length < 2 * points) {
    const n = 2 * points * 2;
    scratch.p = new Float64Array(n);
    scratch.tx = new Float64Array(n / 2);
    scratch.ty = new Float64Array(n / 2);
    scratch.len = new Float64Array(n / 2);
    scratch.pairs = new Int32Array(2 * n);
  }
}

/**
 * How far the shared-pair mitre may stray from the exact join, as a
 * fraction of the half width: 1 % — 0.7 µm on a 0.14 mm contour, 10 µm
 * (OCAD's own resolution) on a 2 mm line.
 */
export const JOIN_SHARE_TOLERANCE = 0.01;

/**
 * Appends one polyline to `out` as an indexed strip. `halfWidth` (same
 * units as `pts`) only decides where a vertex pair may be shared (the
 * inner mitre must not run past either neighbouring segment); the
 * geometry itself is width-independent.
 */
export function extrudeStrip(
  pts: ArrayLike<number>,
  closed: boolean,
  cap: render.StrokeCap,
  join: render.StrokeJoin,
  halfWidth: number,
  out: StripSink,
): void {
  ensureScratch(pts.length / 2 + 1);
  const p = scratch.p;
  let np = 0;
  for (let i = 0; i < pts.length; i += 2) {
    if (np && p[np - 2] === pts[i] && p[np - 1] === pts[i + 1]) continue;
    p[np++] = pts[i];
    p[np++] = pts[i + 1];
  }
  if (closed && np >= 4 && p[0] === p[np - 2] && p[1] === p[np - 1]) np -= 2;
  const n = np / 2;
  const fan = (x: number, y: number, a0: number, sweep: number, from: number | undefined, to: number | undefined) => {
    const steps = Math.max(1, Math.ceil((Math.abs(sweep) / Math.PI) * ROUND_STEPS_PER_PI));
    const c = out.vertex(x, y, 0, 0);
    let prev = from ?? out.vertex(x, y, Math.cos(a0), Math.sin(a0));
    for (let k = 1; k <= steps; k++) {
      const b = a0 + (sweep * k) / steps;
      const cur = k === steps && to !== undefined ? to : out.vertex(x, y, Math.cos(b), Math.sin(b));
      out.triangle(c, prev, cur);
      prev = cur;
    }
  };
  if (n < 2) {
    if (n === 1 && cap === "round") fan(p[0], p[1], 0, 2 * Math.PI, undefined, undefined);
    return;
  }
  if (closed && n < 3) closed = false;
  const segCount = closed ? n : n - 1;
  const px = (i: number) => p[2 * (i < n ? i : i - n)];
  const py = (i: number) => p[2 * (i < n ? i : i - n) + 1];
  const { tx, ty, len } = scratch;
  for (let i = 0; i < segCount; i++) {
    const dx = px(i + 1) - px(i), dy = py(i + 1) - py(i);
    const l = Math.hypot(dx, dy) || 1;
    tx[i] = dx / l; ty[i] = dy / l; len[i] = l;
  }
  // Vertex pair (left, right) a segment uses at its start and at its end.
  const pairs = scratch.pairs;
  const startL = pairs.subarray(0, segCount), startR = pairs.subarray(segCount, 2 * segCount);
  const endL = pairs.subarray(2 * segCount, 3 * segCount), endR = pairs.subarray(3 * segCount, 4 * segCount);
  const firstJoin = closed ? 0 : 1;
  const lastJoin = closed ? n - 1 : n - 2;
  for (let i = firstJoin; i <= lastJoin; i++) {
    const s0 = (i - 1 + segCount) % segCount, s1 = i % segCount;
    const x = px(i), y = py(i);
    const cross = tx[s0] * ty[s1] - ty[s0] * tx[s1];
    const dot = tx[s0] * tx[s1] + ty[s0] * ty[s1];
    // Left normals of the two segments and their (unnormalised) mitre.
    const n0x = -ty[s0], n0y = tx[s0], n1x = -ty[s1], n1y = tx[s1];
    const mx = n0x + n1x, my = n0y + n1y;
    const ml = Math.hypot(mx, my);
    const cosHalf = ml / 2; // cos of half the turn angle
    const mitre = cosHalf > 1e-9 ? 1 / cosHalf : Infinity;
    let share: boolean;
    if (Math.abs(cross) < 1e-12 && dot > 0) share = true;
    else if (join === "miter") share = mitre <= MITRE_LIMIT;
    else if (join === "round") share = mitre - 1 <= JOIN_SHARE_TOLERANCE;
    else share = mitre - cosHalf <= JOIN_SHARE_TOLERANCE;
    // The inner mitre point must stay on both neighbouring segments.
    const reach = halfWidth * Math.sqrt(Math.max(0, mitre * mitre - 1));
    if (share && reach > Math.min(len[s0], len[s1])) share = false;
    if (share) {
      const ux = ml > 1e-12 ? (mx / ml) * mitre : n0x, uy = ml > 1e-12 ? (my / ml) * mitre : n0y;
      const l = out.vertex(x, y, ux, uy), r = out.vertex(x, y, -ux, -uy);
      endL[s0] = l; endR[s0] = r; startL[s1] = l; startR[s1] = r;
      continue;
    }
    const aL = out.vertex(x, y, n0x, n0y), aR = out.vertex(x, y, -n0x, -n0y);
    const bL = out.vertex(x, y, n1x, n1y), bR = out.vertex(x, y, -n1x, -n1y);
    endL[s0] = aL; endR[s0] = aR; startL[s1] = bL; startR[s1] = bR;
    // Outer side is opposite to the turn: right for a left turn.
    const leftTurn = cross > 0;
    const o0 = leftTurn ? aR : aL, o1 = leftTurn ? bR : bL;
    const s = leftTurn ? -1 : 1;
    if (join === "round") {
      const a0 = Math.atan2(n0y * s, n0x * s);
      let d = Math.atan2(n1y * s, n1x * s) - a0;
      while (d > Math.PI) d -= 2 * Math.PI;
      while (d < -Math.PI) d += 2 * Math.PI;
      fan(x, y, a0, d, o0, o1);
    } else {
      const c = out.vertex(x, y, 0, 0);
      if (join === "miter" && mitre <= MITRE_LIMIT) {
        const m = out.vertex(x, y, (s * mx / ml) * mitre, (s * my / ml) * mitre);
        out.triangle(c, o0, m);
        out.triangle(c, m, o1);
      } else {
        out.triangle(c, o0, o1);
      }
    }
  }
  if (!closed) {
    // End pairs, square caps pushed out by one half width along the tangent.
    const sq = cap === "square" ? 1 : 0;
    const t0x = tx[0], t0y = ty[0], t1x = tx[segCount - 1], t1y = ty[segCount - 1];
    startL[0] = out.vertex(px(0), py(0), -t0y - sq * t0x, t0x - sq * t0y);
    startR[0] = out.vertex(px(0), py(0), t0y - sq * t0x, -t0x - sq * t0y);
    endL[segCount - 1] = out.vertex(px(n - 1), py(n - 1), -t1y + sq * t1x, t1x + sq * t1y);
    endR[segCount - 1] = out.vertex(px(n - 1), py(n - 1), t1y + sq * t1x, -t1x + sq * t1y);
    if (cap === "round") {
      // Half circles from the left normal through −t (start) and from the right normal through +t (end).
      fan(px(0), py(0), Math.atan2(t0x, -t0y), Math.PI, startL[0], startR[0]);
      fan(px(n - 1), py(n - 1), Math.atan2(-t1x, t1y), Math.PI, endR[segCount - 1], endL[segCount - 1]);
    }
  }
  for (let i = 0; i < segCount; i++) {
    out.triangle(startL[i], endL[i], startR[i]);
    out.triangle(startR[i], endL[i], endR[i]);
  }
}

/** A stroke pass as one indexed strip set (every ring, or every slice, with the pass's cap). */
export function strokeStrip(pass: render.StrokePass, tol: number, out: StripSink = new StripGeometry()): StripSink {
  const cap = pass.cap === "pointed" ? "butt" : pass.cap;
  for (const { pts, closed } of strokePolylines(pass, tol)) extrudeStrip(pts, closed, cap, pass.join, pass.widthUm / 2, out);
  return out;
}

// ---- even-odd triangulation (arena path) ----------------------------------

/**
 * Triangulates flattened rings under the even-odd rule (§3.1) with
 * earcut: rings are grouped by containment depth — a ring inside an even
 * number of others is an outer boundary, one inside an odd number is a
 * hole of its innermost container. So a "hole" ring that lies outside
 * every other ring is filled, and a font outline's separate contours
 * (the dot of an i) are separate polygons, as the stencil parity path
 * would draw them. Rings that cross each other are earcut's failure mode
 * and drawn as earcut decides (the reference raster is the oracle).
 *
 * Returns positions (x, y) and indices into them.
 */
export function triangulateEvenOdd(rings: number[][]): { positions: number[]; indices: number[] } {
  const rs = rings.filter((r) => r.length >= 6);
  const positions: number[] = [];
  const indices: number[] = [];
  if (!rs.length) return { positions, indices };
  if (rs.length === 1) {
    const tri = earcut(rs[0], undefined, 2);
    for (const v of rs[0]) positions.push(v);
    for (const t of tri) indices.push(t);
    return { positions, indices };
  }
  const bb = rs.map(ringBounds);
  // parent[i]: innermost ring containing ring i; depth[i]: how many contain it.
  const depth = new Int32Array(rs.length);
  const parent = new Int32Array(rs.length).fill(-1);
  for (let i = 0; i < rs.length; i++) {
    // Probe a point of ring i that is a vertex, nudged along nothing: vertex-on-edge cases
    // between distinct rings are degenerate input and resolved arbitrarily.
    const x = rs[i][0], y = rs[i][1];
    let bestArea = Infinity;
    for (let j = 0; j < rs.length; j++) {
      if (j === i) continue;
      const b = bb[j];
      if (x < b[0] || x > b[2] || y < b[1] || y > b[3]) continue;
      if (!pointInRing(rs[j], x, y)) continue;
      depth[i]++;
      const area = (b[2] - b[0]) * (b[3] - b[1]);
      if (area < bestArea) { bestArea = area; parent[i] = j; }
    }
  }
  const holesOf = new Map<number, number[]>();
  for (let i = 0; i < rs.length; i++) {
    if (depth[i] % 2 === 1 && parent[i] >= 0) {
      // Attach to the innermost even-depth container.
      let p = parent[i];
      while (p >= 0 && depth[p] % 2 === 1) p = parent[p];
      if (p < 0) continue;
      const arr = holesOf.get(p) ?? [];
      arr.push(i);
      holesOf.set(p, arr);
    }
  }
  for (let i = 0; i < rs.length; i++) {
    if (depth[i] % 2 === 1) continue;
    const flat: number[] = [...rs[i]];
    const holes: number[] = [];
    for (const h of holesOf.get(i) ?? []) {
      holes.push(flat.length / 2);
      for (const v of rs[h]) flat.push(v);
    }
    const base = positions.length / 2;
    const tri = earcut(flat, holes.length ? holes : undefined, 2);
    for (const v of flat) positions.push(v);
    for (const t of tri) indices.push(t + base);
  }
  return { positions, indices };
}

function ringBounds(r: number[]): [number, number, number, number] {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < r.length; i += 2) {
    if (r[i] < minX) minX = r[i];
    if (r[i] > maxX) maxX = r[i];
    if (r[i + 1] < minY) minY = r[i + 1];
    if (r[i + 1] > maxY) maxY = r[i + 1];
  }
  return [minX, minY, maxX, maxY];
}

/** Crossing-number point-in-ring test. */
export function pointInRing(r: number[], x: number, y: number): boolean {
  let inside = false;
  const n = r.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = r[2 * i], yi = r[2 * i + 1], xj = r[2 * j], yj = r[2 * j + 1];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
