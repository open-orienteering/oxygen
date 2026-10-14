/**
 * Materialises IR glyphs into `GlyphMesh` entries (one per colour part)
 * and hands out glyph ids. Rings and discs become Bézier circles so a
 * glyph is only ever fills and strokes downstream.
 */

import { type GlyphMesh, type RenderPath, type StrokeCap, type StrokeJoin, makePath } from "./pass-stream.js";
import { pathBounds } from "./path.js";
import type { Glyph, GlyphPart } from "./symbol.js";

const KAPPA = 0.5522847498307936;

/** Closed circle as four cubic segments, counter-clockwise from +x. */
export function circlePath(cx: number, cy: number, r: number): RenderPath {
  const k = KAPPA * r;
  const coords = [
    cx + r, cy,
    cx + r, cy + k, cx + k, cy + r, cx, cy + r,
    cx - k, cy + r, cx - r, cy + k, cx - r, cy,
    cx - r, cy - k, cx - k, cy - r, cx, cy - r,
    cx + k, cy - r, cx + r, cy - k, cx + r, cy,
  ];
  const flags = [0, 1, 2, 0, 1, 2, 0, 1, 2, 0, 1, 2, 0];
  return makePath(coords.map(Math.round), flags, true);
}

export function mapCap(c: GlyphPart["cap"] | undefined): StrokeCap {
  return c === undefined || c === "flat" ? "butt" : c;
}
export function mapJoin(j: GlyphPart["join"] | undefined): StrokeJoin {
  return j ?? "miter";
}

export function glyphPartMesh(part: GlyphPart, glyphId: number, partIdx: number): GlyphMesh {
  const mesh: GlyphMesh = { glyphId, partIdx, fills: [], strokes: [] };
  const cx = part.cx ?? 0, cy = part.cy ?? 0;
  switch (part.kind) {
    case "fill":
      if (part.geometry) mesh.fills.push(makePath(part.geometry.coords, part.geometry.flags, true));
      break;
    case "stroke":
      if (part.geometry) {
        mesh.strokes.push({
          path: makePath(part.geometry.coords, part.geometry.flags, part.geometry.closed ?? false),
          widthUm: part.widthUm ?? 0,
          cap: mapCap(part.cap),
          join: mapJoin(part.join),
        });
      }
      break;
    case "disc":
      mesh.fills.push(circlePath(cx, cy, (part.diameterUm ?? 0) / 2));
      break;
    case "ring": {
      const w = part.widthUm ?? 0;
      // OCAD ring diameter is the outer diameter; the stroke runs along the mid-line.
      const r = Math.max(0, (part.diameterUm ?? 0) / 2 - w / 2);
      mesh.strokes.push({ path: circlePath(cx, cy, r), widthUm: w, cap: "butt", join: "round" });
      break;
    }
  }
  return mesh;
}

/** Radius of the smallest origin-centred circle containing the mesh (ink included). */
export function meshRadius(mesh: GlyphMesh): number {
  let r = 0;
  const grow = (p: RenderPath, pad: number) => {
    const b = pathBounds(p);
    r = Math.max(r, Math.hypot(Math.max(Math.abs(b.minX), Math.abs(b.maxX)), Math.max(Math.abs(b.minY), Math.abs(b.maxY))) + pad);
  };
  for (const f of mesh.fills) grow(f, 0);
  for (const s of mesh.strokes) grow(s.path, s.widthUm / 2);
  return r;
}

/** Axis-aligned extent of a glyph (all parts), glyph-local µm, ink included. */
export function glyphExtent(meshes: GlyphMesh[]): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const grow = (p: RenderPath, pad: number) => {
    const b = pathBounds(p);
    minX = Math.min(minX, b.minX - pad);
    minY = Math.min(minY, b.minY - pad);
    maxX = Math.max(maxX, b.maxX + pad);
    maxY = Math.max(maxY, b.maxY + pad);
  };
  for (const m of meshes) {
    for (const f of m.fills) grow(f, 0);
    for (const s of m.strokes) grow(s.path, s.widthUm / 2);
  }
  if (minX === Infinity) return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  return { minX, minY, maxX, maxY };
}

export interface RegisteredGlyph {
  glyphId: number;
  meshes: GlyphMesh[];
  /** Colour per part, parallel to `meshes`. */
  colours: number[];
  radius: number;
  extent: ReturnType<typeof glyphExtent>;
}

/** Assigns ids and builds meshes; the same `Glyph` object registers once. */
export class GlyphRegistry {
  private readonly byGlyph = new Map<Glyph, RegisteredGlyph>();
  readonly table: GlyphMesh[] = [];
  private nextId = 0;

  register(glyph: Glyph): RegisteredGlyph {
    const hit = this.byGlyph.get(glyph);
    if (hit) return hit;
    const glyphId = this.nextId++;
    const meshes = glyph.parts.map((p, i) => glyphPartMesh(p, glyphId, i));
    const reg: RegisteredGlyph = {
      glyphId,
      meshes,
      colours: glyph.parts.map((p) => p.colour),
      radius: Math.max(0, ...meshes.map(meshRadius)),
      extent: glyphExtent(meshes),
    };
    this.table.push(...meshes);
    this.byGlyph.set(glyph, reg);
    return reg;
  }
}
