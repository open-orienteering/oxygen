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
        items.push(...textItems(pass, fonts.get(pass.fontId), tol));
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
  if (triCount === 0) return { fan: new Float32Array(0), cover: new Float32Array(0) };
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
  return { fan, cover };
}

// ---- strokes -------------------------------------------------------------

const ROUND_STEPS_PER_PI = 8;
const MITRE_LIMIT = 4;

/** Polylines (x,y pairs) a stroke pass draws: the whole path per ring, or one per slice. */
export function strokePolylines(pass: render.StrokePass, tol: number): { pts: number[]; closed: boolean }[] {
  if (!pass.slices) {
    return render.flattenRings(pass.path, tol).map((pts) => ({ pts, closed: pass.path.closed }));
  }
  return pass.slices
    .map((sl) => ({ pts: render.flattenSegments(render.sliceSegments(pass.path, sl), tol), closed: false }))
    .filter((p) => p.pts.length >= 4);
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
function textItems(pass: render.TextPass, font: render.FontMetrics | undefined, tol: number): PreparedInstanced[] {
  if (!font || !font.outline) return [];
  const k = pass.sizeUm / font.unitsPerEm;
  const byGlyph = new Map<number, number[]>();
  for (let i = 0; i < pass.glyphs.length; i++) {
    const g = pass.glyphs[i];
    const arr = byGlyph.get(g) ?? [];
    arr.push(pass.positions[2 * i], pass.positions[2 * i + 1], 1, 0, k);
    byGlyph.set(g, arr);
  }
  const items: PreparedInstanced[] = [];
  const ft = Math.max(1, tol / k / 2); // tolerance in font units
  for (const [g, inst] of byGlyph) {
    const outline = font.outline(g);
    if (!outline) continue;
    const rings = render.flattenRings(outline, ft);
    if (pass.haloWidthUm) {
      const out: number[] = [];
      for (const r of rings) extrudePolyline(r, true, "round", "round", out);
      items.push({ kind: "instanced", colour: pass.colour, instances: Float32Array.from(inst), strokes: [{ verts: Float32Array.from(out), halfWidth: pass.haloWidthUm / k }] });
    } else {
      items.push({ kind: "instanced", colour: pass.colour, instances: Float32Array.from(inst), fill: fanFromRings(rings), strokes: [] });
    }
  }
  return items;
}
