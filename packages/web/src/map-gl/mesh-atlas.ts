/**
 * WebGL2 backend, mesh atlas: every glyph part a document draws, as one
 * triangle list in one float texture. (Text is drawn from the MSDF text
 * atlas, `text-atlas.ts`.)
 *
 * WebGL2 instancing draws one vertex range for all instances of a draw,
 * so one draw per distinct mesh was S1's draw-call problem (Sprint: 115
 * meshes in one colour run, 325 draws). Here an instance carries its
 * mesh's `base` and `count` and the vertex shader pulls vertex
 * `gl_VertexID` of that mesh from the texture; a draw covers every
 * instance of one colour whose mesh fits its **size class** (vertex count
 * rounded up to a power of two), and vertices past `count` collapse to
 * nothing. So glyphs of one colour cost one draw per size class in view
 * (docs/map-rendering.md §5.2 "Arena and buckets").
 *
 * Mesh geometry is glyph-local (glyph µm), as a
 * plain triangle list: fills triangulated even-odd (no stencil parity —
 * overlapping instances of one pass no longer XOR), strokes as indexed
 * strips expanded to triangles. Per vertex two RGBA32F texels:
 * `(x, y, ox, oy)` and `(hw, 0, 0, 0)`; fill vertices have zero offset
 * and width, so one program draws both.
 *
 * Pure TypeScript; the renderer uploads `data` as a texture.
 */

import { render } from "@oxygen/shared";
import { extrudeStrip, StripGeometry, triangulateEvenOdd } from "./prepare.js";

/** Texels per row of the atlas texture (two per vertex). */
export const ATLAS_WIDTH = 2048;
/** Floats per atlas vertex (two RGBA texels). */
export const ATLAS_VERTEX_FLOATS = 8;
/** Floats per atlas instance: x, y, cos, sin, scale, base, count, radius. */
export const INSTANCE_FLOATS = 8;

export interface AtlasMesh {
  /** First vertex in the atlas. */
  base: number;
  count: number;
  /** Size class: the draw that carries this mesh pulls `2^cls` vertices per instance. */
  cls: number;
  /** Largest distance of the geometry from the mesh origin, mesh units (for the < 2 px skip). */
  radius: number;
}

export interface MeshAtlas {
  /** ATLAS_VERTEX_FLOATS per vertex, padded to whole texture rows. */
  data: Float32Array;
  vertexCount: number;
  meshes: AtlasMesh[];
}

/** Smallest power-of-two exponent with `2^cls >= count`. */
export function sizeClass(count: number): number {
  return count <= 1 ? 0 : Math.ceil(Math.log2(count));
}

export class MeshAtlasBuilder {
  private readonly verts: number[] = [];
  private readonly meshes: AtlasMesh[] = [];
  private readonly byKey = new Map<string, number>();

  /** Mesh index for a glyph part, flattened at `tol` glyph µm. */
  glyph(mesh: render.GlyphMesh, tol: number): number {
    const key = `g/${mesh.glyphId}/${mesh.partIdx}`;
    const hit = this.byKey.get(key);
    if (hit !== undefined) return hit;
    const tri: number[] = [];
    for (const f of mesh.fills) pushFill(render.flattenRings(f, tol), tri);
    for (const s of mesh.strokes) {
      const strip = new StripGeometry();
      const cap = s.cap === "pointed" ? "butt" : s.cap;
      for (const pts of render.flattenRings(s.path, tol)) extrudeStrip(pts, s.path.closed, cap, s.join, s.widthUm / 2, strip);
      pushStrip(strip, s.widthUm / 2, tri);
    }
    return this.add(key, tri);
  }

  private add(key: string, tri: number[]): number {
    const count = tri.length / ATLAS_VERTEX_FLOATS;
    let radius = 0;
    for (let i = 0; i < tri.length; i += ATLAS_VERTEX_FLOATS) {
      const hw = tri[i + 4];
      radius = Math.max(radius, Math.abs(tri[i]) + hw, Math.abs(tri[i + 1]) + hw);
    }
    const idx = this.meshes.length;
    this.meshes.push({ base: this.verts.length / ATLAS_VERTEX_FLOATS, count, cls: sizeClass(count), radius });
    for (const v of tri) this.verts.push(v);
    this.byKey.set(key, idx);
    return idx;
  }

  build(): MeshAtlas {
    const vertexCount = this.verts.length / ATLAS_VERTEX_FLOATS;
    const rows = Math.max(1, Math.ceil((vertexCount * 2) / ATLAS_WIDTH));
    const data = new Float32Array(rows * ATLAS_WIDTH * 4);
    data.set(this.verts);
    return { data, vertexCount, meshes: this.meshes };
  }
}

function pushFill(rings: number[][], out: number[]): void {
  const { positions, indices } = triangulateEvenOdd(rings);
  for (const i of indices) out.push(positions[2 * i], positions[2 * i + 1], 0, 0, 0, 0, 0, 0);
}

function pushStrip(strip: StripGeometry, hw: number, out: number[]): void {
  const v = strip.verts;
  for (const i of strip.indices) out.push(v[4 * i], v[4 * i + 1], v[4 * i + 2], v[4 * i + 3], hw, 0, 0, 0);
}
