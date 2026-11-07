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

/**
 * A prepared item under a filter mask (map-rendering §3.8): drawn only
 * outside every region; one stencil fan per region.
 */
export interface PreparedMask {
  mask?: FanGeometry[];
}

export type Prepared = (PreparedFill | PreparedStroke | PreparedHatch | PreparedInstanced) & PreparedMask;

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
    const f = opts.fonts?.find((x) => x.family === ref.family && !!x.bold === ref.bold && !!x.italic === ref.italic) ?? opts.fonts?.find((x) => x.family === ref.family);
    if (f) fonts.set(ref.fontId, f);
  });
  const meshGeomCache = new Map<string, { fill?: FanGeometry; strokes: StrokeGeometry[] }>();
  const textGeomCache = new Map<string, FanGeometry | StrokeGeometry>();
  const items: Prepared[] = [];
  const bounds = render.passStreamBounds(stream);

  const maskGeoms = new Map<number, FanGeometry[]>();
  stream.passes.forEach((pass, passIndex) => {
    const first = items.length;
    preparePass(pass);
    const m = stream.maskIdx?.[passIndex] ?? -1;
    if (m < 0) return;
    let geoms = maskGeoms.get(m);
    if (!geoms) {
      geoms = stream.masks![m].regions.map((r) => fanGeometry({ ...r, closed: true }, tol));
      maskGeoms.set(m, geoms);
    }
    for (let k = first; k < items.length; k++) items[k] = { ...items[k], mask: geoms };
  });
  return { items, bounds };

  function preparePass(pass: render.Pass): void {
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
      const key = `${font.family}${font.bold ? "/bold" : ""}/${g}/${ft}/halo${hw.toFixed(2)}`;
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
      const key = `${font.family}${font.bold ? "/bold" : ""}/${g}/${ft}/fill`;
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
 * would draw them.
 *
 * Rings that cross a *convex* ring are resolved first (P7): the white-out
 * outside is the window quad with the shape as its even-odd hole, and the
 * shape crosses the window whenever it reaches the frame. Two such rings
 * (every white-out outside) are triangulated exactly by convex clips of
 * earcut triangles (`convexPairTriangles`). With more rings, the crossing
 * ring is replaced by its parts inside the convex ring and outside it
 * (line clips cut into simple rings), which no longer cross, and
 * containment is probed at a boundary point on no other ring; the parts
 * inside touch the convex ring, which earcut may mishandle at fractional
 * coordinates — best effort, as no producer emits it. Two non-convex rings
 * that cross each other stay earcut's failure mode, drawn as earcut
 * decides (the reference raster is the oracle).
 *
 * Returns positions (x, y) and indices into them.
 */
export function triangulateEvenOdd(rings: number[][]): { positions: number[]; indices: number[] } {
  let rs = rings.filter((r) => r.length >= 6);
  const positions: number[] = [];
  const indices: number[] = [];
  if (!rs.length) return { positions, indices };
  if (rs.length === 2) {
    const pair = convexCrossingPair(rs[0], rs[1]);
    if (pair) return convexPairTriangles(pair[0], pair[1]);
  }
  const resolved = rs.length > 2 ? resolveConvexCrossings(rs) : null;
  if (resolved) rs = resolved;
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
    // Probe a point of ring i. Without crossings resolved, its first vertex: vertex-on-edge
    // cases between distinct rings are degenerate input and resolved arbitrarily. With them,
    // the pieces touch the convex ring by construction, so a boundary point on no other ring.
    const [x, y] = resolved ? freeBoundaryPoint(rs, bb, i) : [rs[i][0], rs[i][1]];
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

/** [convex ring, the other] when one of two rings is convex and they cross or touch (the bigger box clips when both are). */
function convexCrossingPair(a: number[], b: number[]): [number[], number[]] | null {
  const ba = ringBounds(a), bb = ringBounds(b);
  if (ba[2] < bb[0] || bb[2] < ba[0] || ba[3] < bb[1] || bb[3] < ba[1]) return null;
  const aConvex = isConvexRing(a), bConvex = isConvexRing(b);
  if (!aConvex && !bConvex) return null;
  const boxArea = (q: number[]) => (q[2] - q[0]) * (q[3] - q[1]);
  const [c, cb, s] = aConvex && (!bConvex || boxArea(ba) >= boxArea(bb)) ? [a, ba, b] : [b, bb, a];
  return ringCrossesConvex(s, c, cb) ? [c, s] : null;
}

/**
 * The even-odd region of a convex ring `c` and a simple ring `s` that
 * crosses it, as triangles (P7: the white-out outside's window and shape).
 * `c` outside `s` is a box round both with `s` as its hole — a hole that
 * touches nothing, earcut's safe case — each triangle clipped to `c`; `s`
 * outside `c` is `s`'s own triangles, each cut by `c`'s edges. Every clip
 * is convex against convex, so nothing is bridged or rounded into a
 * crossing; the pieces are disjoint and fanned.
 */
function convexPairTriangles(c: number[], s: number[]): { positions: number[]; indices: number[] } {
  const positions: number[] = [];
  const indices: number[] = [];
  const fan = (poly: number[]) => {
    const r = cleanRing(poly);
    if (!r) return;
    const base = positions.length / 2;
    for (const v of r) positions.push(v);
    for (let i = 1; i + 1 < r.length / 2; i++) indices.push(base, base + i, base + i + 1);
  };
  const m = c.length / 2;
  const left = render.ringArea(c) > 0 ? 1 : -1;
  const edge = (poly: number[], k: number, keep: number) => {
    const l = (k + 1) % m;
    return fallbackClip(poly, c[2 * k], c[2 * k + 1], c[2 * l] - c[2 * k], c[2 * l + 1] - c[2 * k + 1], keep);
  };
  const triangles = (flat: number[], holes?: number[]) => {
    const t = earcut(flat, holes, 2);
    const out: number[][] = [];
    for (let i = 0; i < t.length; i += 3) out.push([flat[2 * t[i]], flat[2 * t[i] + 1], flat[2 * t[i + 1]], flat[2 * t[i + 1] + 1], flat[2 * t[i + 2]], flat[2 * t[i + 2] + 1]]);
    return out;
  };
  const b = ringBounds([...c, ...s]);
  const pad = Math.max(b[2] - b[0], b[3] - b[1]) * 0.01 + 1;
  const box = [b[0] - pad, b[1] - pad, b[2] + pad, b[1] - pad, b[2] + pad, b[3] + pad, b[0] - pad, b[3] + pad];
  for (const t of triangles([...box, ...s], [4])) {
    let p = t;
    for (let k = 0; k < m && p.length >= 6; k++) p = edge(p, k, left);
    fan(p);
  }
  for (const t of triangles(s)) {
    let inner = t;
    for (let k = 0; k < m && inner.length >= 6; k++) {
      fan(edge(inner, k, -left));
      inner = edge(inner, k, left);
    }
  }
  return { positions, indices };
}

/**
 * Replaces each ring that crosses (or touches) a convex ring by its parts
 * inside that ring and its parts outside it — the same even-odd region,
 * no crossing (P7). Returns null when no pair crosses, so the common case
 * keeps the rings as given. A ring that clips is not itself clipped, and a
 * clipped ring clips nothing; a part inside that is the whole convex ring
 * cancels it (parity: a second such part brings it back).
 */
function resolveConvexCrossings(rs: number[][]): number[][] | null {
  const n = rs.length;
  const bb = rs.map(ringBounds);
  const convex: (boolean | undefined)[] = new Array(n);
  const isConvex = (i: number) => (convex[i] ??= isConvexRing(rs[i]));
  const CLIPPER = 1, CLIPPED = 2;
  const role = new Uint8Array(n);
  const pieces = new Map<number, number[][]>();
  const cancelled = new Set<number>();
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n && role[i] !== CLIPPED; j++) {
      if (role[j] === CLIPPED) continue;
      const a = bb[i], b = bb[j];
      if (a[2] < b[0] || b[2] < a[0] || a[3] < b[1] || b[3] < a[1]) continue;
      const iClips = role[j] === 0 && isConvex(i), jClips = role[i] === 0 && isConvex(j);
      if (!iClips && !jClips) continue;
      const boxArea = (q: number[]) => (q[2] - q[0]) * (q[3] - q[1]);
      const c = iClips && (!jClips || boxArea(a) >= boxArea(b)) ? i : j;
      const s = c === i ? j : i;
      if (!ringCrossesConvex(rs[s], rs[c], bb[c])) continue;
      role[c] = CLIPPER;
      role[s] = CLIPPED;
      const out: number[][] = [];
      const inside = clipRingToConvex(rs[s], rs[c]);
      if (inside.length === 1 && Math.abs(render.ringArea(inside[0])) >= Math.abs(render.ringArea(rs[c])) * (1 - 1e-9) - 1) {
        if (cancelled.has(c)) cancelled.delete(c);
        else cancelled.add(c);
      } else out.push(...inside);
      out.push(...outsideConvexPieces(rs[s], rs[c]));
      pieces.set(s, out);
    }
  }
  if (!pieces.size) return null;
  const result: number[][] = [];
  for (let i = 0; i < n; i++) {
    if (cancelled.has(i)) continue;
    const p = pieces.get(i);
    if (p) result.push(...p);
    else result.push(rs[i]);
  }
  return result;
}

/**
 * Does an edge of ring `s` cross or touch an edge of the convex ring `c`
 * (bounds `cb`)? One pass over `s` against `c`'s bounds first, so a large
 * ring round a small convex hole costs O(|s|), not O(|s| · |c|).
 */
function ringCrossesConvex(s: number[], c: number[], cb: [number, number, number, number]): boolean {
  const n = s.length / 2, m = c.length / 2;
  for (let e = 0, f = n - 1; e < n; f = e++) {
    const ax = s[2 * f], ay = s[2 * f + 1], bx = s[2 * e], by = s[2 * e + 1];
    if (Math.max(ax, bx) < cb[0] || Math.min(ax, bx) > cb[2] || Math.max(ay, by) < cb[1] || Math.min(ay, by) > cb[3]) continue;
    for (let k = 0, l = m - 1; k < m; l = k++) {
      if (segmentsMeet(ax, ay, bx, by, c[2 * l], c[2 * l + 1], c[2 * k], c[2 * k + 1])) return true;
    }
  }
  return false;
}

/** Whether segments ab and cd intersect or touch (collinear overlap included). */
function segmentsMeet(ax: number, ay: number, bx: number, by: number, cx: number, cy: number, dx: number, dy: number): boolean {
  const o = (px: number, py: number, qx: number, qy: number, rx: number, ry: number) => Math.sign((qx - px) * (ry - py) - (qy - py) * (rx - px));
  const on = (px: number, py: number, qx: number, qy: number, rx: number, ry: number) =>
    Math.min(px, qx) <= rx && rx <= Math.max(px, qx) && Math.min(py, qy) <= ry && ry <= Math.max(py, qy);
  const o1 = o(ax, ay, bx, by, cx, cy), o2 = o(ax, ay, bx, by, dx, dy), o3 = o(cx, cy, dx, dy, ax, ay), o4 = o(cx, cy, dx, dy, bx, by);
  if (o1 !== o2 && o3 !== o4) return true;
  return (o1 === 0 && on(ax, ay, bx, by, cx, cy)) || (o2 === 0 && on(ax, ay, bx, by, dx, dy))
    || (o3 === 0 && on(cx, cy, dx, dy, ax, ay)) || (o4 === 0 && on(cx, cy, dx, dy, bx, by));
}

/** Whether a flat ring is convex and simple (turns one way, once round); collinear vertices are allowed. */
export function isConvexRing(r: number[]): boolean {
  const n = r.length / 2;
  if (n < 3) return false;
  let sign = 0;
  let turn = 0;
  for (let i = 0; i < n; i++) {
    const a = (i + n - 1) % n, c = (i + 1) % n;
    const ux = r[2 * i] - r[2 * a], uy = r[2 * i + 1] - r[2 * a + 1];
    const vx = r[2 * c] - r[2 * i], vy = r[2 * c + 1] - r[2 * i + 1];
    const cross = ux * vy - uy * vx;
    const dot = ux * vx + uy * vy;
    if (Math.abs(cross) > 1e-9 * (Math.abs(ux * vy) + Math.abs(uy * vx))) {
      const sg = cross > 0 ? 1 : -1;
      if (sign && sg !== sign) return false;
      sign = sg;
    } else if (dot < 0) return false; // a spike back along the edge
    turn += Math.atan2(cross, dot);
  }
  return sign !== 0 && Math.abs(Math.abs(turn) - 2 * Math.PI) < 1e-6;
}

/**
 * The part of the simple ring `poly` on one side of the line a→b (`keep`
 * +1 left, −1 right, the line itself kept), as separate simple rings.
 * Plain Sutherland–Hodgman joins the pieces of a non-convex ring with
 * zero-width bridges along the line, which rounding turns into crossings
 * earcut drops; here the ring is cut into chains between its crossings,
 * and each chain's exit is joined to the entry next to it along the line
 * (crossings alternate along the line for a simple ring).
 */
function clipHalfPlane(poly: number[], ax: number, ay: number, bx: number, by: number, keep: number): number[][] {
  const n = poly.length / 2;
  if (n < 3) return [];
  const ex = bx - ax, ey = by - ay;
  const side = new Float64Array(n);
  let start = -1, anyIn = false;
  for (let k = 0; k < n; k++) {
    side[k] = keep * (ex * (poly[2 * k + 1] - ay) - ey * (poly[2 * k] - ax));
    if (side[k] < 0) { if (start < 0) start = k; } else anyIn = true;
  }
  if (start < 0) return [poly];
  if (!anyIn) return [];
  type Cross = { u: number; chain: number; entry: boolean };
  const chains: number[][] = [];
  const crosses: Cross[] = [];
  let cur: number[] | null = null;
  for (let step = 1; step <= n; step++) {
    const k = (start + step) % n, p = (start + step - 1) % n;
    const sp = side[p], sk = side[k];
    if ((sp >= 0) !== (sk >= 0)) {
      const t = sp / (sp - sk);
      const x = poly[2 * p] + t * (poly[2 * k] - poly[2 * p]), y = poly[2 * p + 1] + t * (poly[2 * k + 1] - poly[2 * p + 1]);
      const u = (x - ax) * ex + (y - ay) * ey;
      if (sk >= 0) {
        cur = [x, y];
        chains.push(cur);
        crosses.push({ u, chain: chains.length - 1, entry: true });
      } else if (cur) {
        cur.push(x, y);
        crosses.push({ u, chain: chains.length - 1, entry: false });
        cur = null;
      }
    }
    if (sk >= 0 && cur) cur.push(poly[2 * k], poly[2 * k + 1]);
  }
  // Ties (a vertex touching the line from outside): a chain's own entry and exit side by side, entry first.
  const order = crosses.map((_, i) => i).sort((i, j) => crosses[i].u - crosses[j].u || crosses[i].chain - crosses[j].chain || (crosses[i].entry ? -1 : 1));
  const rank = new Int32Array(crosses.length);
  order.forEach((ci, r) => { rank[ci] = r; });
  const exitOf = new Int32Array(chains.length);
  crosses.forEach((c, i) => { if (!c.entry) exitOf[c.chain] = i; });
  const done = new Uint8Array(chains.length);
  const out: number[][] = [];
  for (let c0 = 0; c0 < chains.length; c0++) {
    if (done[c0]) continue;
    const ring: number[] = [];
    let c = c0;
    for (let guard = 0; guard <= chains.length; guard++) {
      done[c] = 1;
      for (const v of chains[c]) ring.push(v);
      const next = crosses[order[rank[exitOf[c]] ^ 1]];
      if (!next || !next.entry) return [poly.length ? fallbackClip(poly, ax, ay, ex, ey, keep) : []].filter((r) => r.length >= 6);
      c = next.chain;
      if (c === c0) break;
    }
    out.push(ring);
  }
  return out;
}

/** Plain Sutherland–Hodgman (one ring, bridges and all): only for crossings that do not pair up (degenerate input). */
function fallbackClip(poly: number[], ax: number, ay: number, ex: number, ey: number, keep: number): number[] {
  const out: number[] = [];
  const n = poly.length / 2;
  const side = (k: number) => keep * (ex * (poly[2 * k + 1] - ay) - ey * (poly[2 * k] - ax));
  let pk = n - 1, ps = side(pk);
  for (let k = 0; k < n; k++) {
    const s = side(k);
    if ((s >= 0) !== (ps >= 0)) {
      const t = ps / (ps - s);
      out.push(poly[2 * pk] + t * (poly[2 * k] - poly[2 * pk]), poly[2 * pk + 1] + t * (poly[2 * k + 1] - poly[2 * pk + 1]));
    }
    if (s >= 0) out.push(poly[2 * k], poly[2 * k + 1]);
    pk = k;
    ps = s;
  }
  return out;
}

/** Clips every ring of `rings` to one side of edge e→f of `c`. */
const clipAll = (rings: number[][], c: number[], e: number, f: number, keep: number) =>
  rings.flatMap((r) => clipHalfPlane(r, c[2 * e], c[2 * e + 1], c[2 * f], c[2 * f + 1], keep));

/** The parts of `poly` inside the convex ring `c`, as simple rings. */
function clipRingToConvex(poly: number[], c: number[]): number[][] {
  const m = c.length / 2;
  const left = render.ringArea(c) > 0 ? 1 : -1;
  let out = [poly];
  for (let e = 0; e < m && out.length; e++) out = clipAll(out, c, e, (e + 1) % m, left);
  return out.map(cleanRing).filter((r): r is number[] => r !== null);
}

/** The parts of `poly` outside the convex ring `c`: for edge k, beyond k and inside every edge before it — disjoint, covering all. */
function outsideConvexPieces(poly: number[], c: number[]): number[][] {
  const m = c.length / 2;
  const left = render.ringArea(c) > 0 ? 1 : -1;
  const out: number[][] = [];
  let inner = [poly]; // poly inside edges 0 … k−1
  for (let k = 0; k < m && inner.length; k++) {
    const l = (k + 1) % m;
    for (const piece of clipAll(inner, c, k, l, -left)) {
      const r = cleanRing(piece);
      if (r) out.push(r);
    }
    inner = clipAll(inner, c, k, l, left);
  }
  return out;
}

/** Drops repeated points; null when fewer than three remain or the ring has no area (< 1 µm²). */
function cleanRing(r: number[]): number[] | null {
  const out: number[] = [];
  for (let i = 0; i < r.length; i += 2) {
    const n = out.length;
    if (n && Math.abs(out[n - 2] - r[i]) < 1e-6 && Math.abs(out[n - 1] - r[i + 1]) < 1e-6) continue;
    out.push(r[i], r[i + 1]);
  }
  while (out.length >= 4 && Math.abs(out[0] - out[out.length - 2]) < 1e-6 && Math.abs(out[1] - out[out.length - 1]) < 1e-6) out.length -= 2;
  if (out.length < 6 || Math.abs(render.ringArea(out)) < 1) return null;
  return out;
}

/** A point on ring i's boundary that lies on no other ring's boundary (its first vertex when there is none). */
function freeBoundaryPoint(rs: number[][], bb: [number, number, number, number][], i: number): [number, number] {
  const r = rs[i];
  const n = r.length / 2;
  const EPS = 0.01; // µm
  const onOther = (x: number, y: number) => {
    for (let j = 0; j < rs.length; j++) {
      if (j === i) continue;
      const b = bb[j];
      if (x < b[0] - EPS || x > b[2] + EPS || y < b[1] - EPS || y > b[3] + EPS) continue;
      const q = rs[j];
      const m = q.length / 2;
      for (let k = 0, l = m - 1; k < m; l = k++) {
        const ax = q[2 * l], ay = q[2 * l + 1], ex = q[2 * k] - ax, ey = q[2 * k + 1] - ay;
        const len2 = ex * ex + ey * ey;
        const t = len2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * ex + (y - ay) * ey) / len2)) : 0;
        const dx = ax + t * ex - x, dy = ay + t * ey - y;
        if (dx * dx + dy * dy < EPS * EPS) return true;
      }
    }
    return false;
  };
  for (const t of [0.5, 0.25, 0.75, 0.125, 0.375, 0.625, 0.875, 0]) {
    for (let e = 0; e < n; e++) {
      const f = (e + 1) % n;
      const x = r[2 * e] + t * (r[2 * f] - r[2 * e]), y = r[2 * e + 1] + t * (r[2 * f + 1] - r[2 * e + 1]);
      if (!onOther(x, y)) return [x, y];
    }
  }
  return [r[0], r[1]];
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
