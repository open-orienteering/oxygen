/**
 * The terrain mesh (docs/map-rendering.md §5.6 "Mesh and level of
 * detail"): the field's cell centres as a regular grid, cut into chunks of
 * `CHUNK` × `CHUNK` quads. Every chunk shares one vertex grid and one index
 * buffer per level; level l takes every 2^l-th vertex. A chunk's level
 * follows the eye's distance to its box, so a quad edge stays near
 * `lodPx` on screen; skirts hanging to the chunk's lowest height close
 * the cracks between neighbours of different levels.
 *
 * Model space (§5.6 "Units"): origin-relative paper µm, z up in the same µm,
 * `z = (h − zMin) · unitUm · exaggeration` for int16 height h.
 */

import { HEIGHT_NO_DATA, type HeightField } from "@oxygen/shared/src/terrain/field/read.js";
import { boxDistanceSq, type Box3, type CameraFrame } from "./camera.js";
import { transform } from "./mat4.js";

/** Quads per chunk side. */
export const CHUNK = 64;
/** Levels 0 … `LEVELS − 1`; the coarsest draws a chunk as one quad. */
export const LEVELS = 7;
/** Default screen size of a quad edge at a chunk's nearest point. */
export const DEFAULT_LOD_PX = 8;

export interface TerrainChunk {
  /** The chunk's first vertex, grid cells. */
  ix0: number;
  iy0: number;
  /** Lowest and highest filled height over the chunk's vertices, int16 units. */
  zMin: number;
  zMax: number;
}

export interface TerrainMesh {
  width: number;
  height: number;
  /** Model µm of cell (0, 0)'s centre. */
  x0Um: number;
  y0Um: number;
  cellUm: number;
  /** The paper µm the model space is relative to. */
  originUm: { x: number; y: number };
  /** The no-data cells filled from the nearest data cell (`meshHeights`). */
  heights: Int16Array;
  /** Lowest and highest filled height, int16 units; model z = 0 at `zMin`. */
  zMin: number;
  zMax: number;
  /** Model µm per height unit at exaggeration 1: `zScaleM · 1000 / groundMPerMm`. */
  unitUm: number;
  /** Metres at model z = 0: `zMin · zScaleM + zOffsetM`. */
  zBaseM: number;
  chunksX: number;
  chunksY: number;
  chunks: TerrainChunk[];
}

/** Model µm per height unit: metres → paper mm through the map scale, × 1000, × exaggeration. */
export function zUnitUm(header: HeightField["header"], exaggeration = 1): number {
  return ((header.zScaleM * 1000) / header.groundMPerMm) * exaggeration;
}

/**
 * The heights the mesh draws: a copy of the field with every no-data cell
 * at the height of its nearest data cell (breadth-first, four
 * neighbours, in scan order on ties); all `zMin` when nothing has data.
 */
export function meshHeights(field: HeightField): Int16Array {
  const { width: W, height: H } = field.header;
  const out = Int16Array.from(field.z);
  const queue = new Int32Array(W * H);
  let head = 0, tail = 0;
  for (let i = 0; i < W * H; i++) if (out[i] !== HEIGHT_NO_DATA) queue[tail++] = i;
  if (tail === 0) return out.fill(field.header.zMin);
  while (head < tail) {
    const i = queue[head++], cx = i % W, v = out[i];
    const visit = (j: number) => {
      if (out[j] === HEIGHT_NO_DATA) {
        out[j] = v;
        queue[tail++] = j;
      }
    };
    if (cx > 0) visit(i - 1);
    if (cx < W - 1) visit(i + 1);
    if (i >= W) visit(i - W);
    if (i < W * (H - 1)) visit(i + W);
  }
  return out;
}

/** The mesh of a field in the model space relative to `originUm` (paper µm). */
export function buildTerrainMesh(field: HeightField, originUm: { x: number; y: number } = { x: 0, y: 0 }): TerrainMesh {
  const h = field.header, W = h.width, H = h.height;
  const heights = meshHeights(field);
  let zMin = 32767, zMax = -32767;
  for (const v of heights) {
    if (v < zMin) zMin = v;
    if (v > zMax) zMax = v;
  }
  const chunksX = W >= 2 && H >= 2 ? Math.ceil((W - 1) / CHUNK) : 0;
  const chunksY = W >= 2 && H >= 2 ? Math.ceil((H - 1) / CHUNK) : 0;
  const chunks: TerrainChunk[] = [];
  for (let cy = 0; cy < chunksY; cy++)
    for (let cx = 0; cx < chunksX; cx++) {
      const ix0 = cx * CHUNK, iy0 = cy * CHUNK;
      let lo = 32767, hi = -32767;
      for (let y = iy0; y <= Math.min(iy0 + CHUNK, H - 1); y++)
        for (let x = ix0; x <= Math.min(ix0 + CHUNK, W - 1); x++) {
          const v = heights[y * W + x];
          if (v < lo) lo = v;
          if (v > hi) hi = v;
        }
      chunks.push({ ix0, iy0, zMin: lo, zMax: hi });
    }
  return {
    width: W,
    height: H,
    x0Um: (h.x0 + h.cellMm / 2) * 1000 - originUm.x,
    y0Um: (h.y0 + h.cellMm / 2) * 1000 - originUm.y,
    cellUm: h.cellMm * 1000,
    originUm,
    heights,
    zMin,
    zMax,
    unitUm: zUnitUm(h, 1),
    zBaseM: zMin * h.zScaleM + h.zOffsetM,
    chunksX,
    chunksY,
    chunks,
  };
}

/** A chunk's box in model µm at an exaggeration. */
export function chunkBox(mesh: TerrainMesh, c: TerrainChunk, exaggeration: number): Box3 {
  const u = mesh.unitUm * exaggeration;
  return {
    minX: mesh.x0Um + c.ix0 * mesh.cellUm,
    maxX: mesh.x0Um + Math.min(c.ix0 + CHUNK, mesh.width - 1) * mesh.cellUm,
    minY: mesh.y0Um + c.iy0 * mesh.cellUm,
    maxY: mesh.y0Um + Math.min(c.iy0 + CHUNK, mesh.height - 1) * mesh.cellUm,
    minZ: (c.zMin - mesh.zMin) * u,
    maxZ: (c.zMax - mesh.zMin) * u,
  };
}

/** The whole mesh's box in model µm. */
export function meshBox(mesh: TerrainMesh, exaggeration: number): Box3 {
  return {
    minX: mesh.x0Um,
    maxX: mesh.x0Um + Math.max(mesh.width - 1, 0) * mesh.cellUm,
    minY: mesh.y0Um,
    maxY: mesh.y0Um + Math.max(mesh.height - 1, 0) * mesh.cellUm,
    minZ: 0,
    maxZ: (mesh.zMax - mesh.zMin) * mesh.unitUm * exaggeration,
  };
}

// ---------------------------------------------------------------------------
// Shared chunk geometry

export interface ChunkGeometry {
  /** Three bytes per vertex: i, j (0 … CHUNK) and 1 for a skirt vertex. */
  vertices: Uint8Array;
  /** Every level's indices back to back. */
  indices: Uint16Array;
  /** Per level: first index and count. */
  levels: { first: number; count: number }[];
}

const SIDE = CHUNK + 1;
/** The border positions in counter-clockwise order from (0, 0). */
function borderRing(): [number, number][] {
  const ring: [number, number][] = [];
  for (let i = 0; i < CHUNK; i++) ring.push([i, 0]);
  for (let j = 0; j < CHUNK; j++) ring.push([CHUNK, j]);
  for (let i = CHUNK; i > 0; i--) ring.push([i, CHUNK]);
  for (let j = CHUNK; j > 0; j--) ring.push([0, j]);
  return ring;
}

let geometry: ChunkGeometry | undefined;

/** The vertex grid and per-level index buffers every chunk draws with. */
export function chunkGeometry(): ChunkGeometry {
  if (geometry) return geometry;
  const ring = borderRing();
  const vertices = new Uint8Array((SIDE * SIDE + ring.length) * 3);
  for (let j = 0; j < SIDE; j++)
    for (let i = 0; i < SIDE; i++) vertices.set([i, j, 0], (j * SIDE + i) * 3);
  const skirtOf = new Map<number, number>();
  ring.forEach(([i, j], k) => {
    const v = SIDE * SIDE + k;
    vertices.set([i, j, 1], v * 3);
    skirtOf.set(j * SIDE + i, v);
  });
  const v = (i: number, j: number) => j * SIDE + i;
  const all: number[] = [];
  const levels: ChunkGeometry["levels"] = [];
  for (let l = 0; l < LEVELS; l++) {
    const s = 1 << l, n = CHUNK / s, first = all.length;
    for (let qj = 0; qj < n; qj++)
      for (let qi = 0; qi < n; qi++) {
        const a = v(qi * s, qj * s), b = v((qi + 1) * s, qj * s), c = v((qi + 1) * s, (qj + 1) * s), d = v(qi * s, (qj + 1) * s);
        all.push(a, b, c, a, c, d);
      }
    // skirts: the ring at stride s
    for (let k = 0; k < ring.length; k += s) {
      const [i0, j0] = ring[k], [i1, j1] = ring[(k + s) % ring.length];
      const p0 = v(i0, j0), p1 = v(i1, j1), q0 = skirtOf.get(p0)!, q1 = skirtOf.get(p1)!;
      all.push(p0, q0, q1, p0, q1, p1);
    }
    levels.push({ first, count: all.length - first });
  }
  geometry = { vertices, indices: Uint16Array.from(all), levels };
  return geometry;
}

/** Triangles a chunk draws at a level, skirts included. */
export const levelTriangles = (level: number): number => {
  const n = CHUNK >> level;
  return 2 * n * n + 2 * 4 * n;
};

// ---------------------------------------------------------------------------
// Selection

/**
 * The level for a chunk whose nearest point is `distanceUm` from the eye:
 * the coarsest whose quad edge, `2^l · cellUm · focalPx / distance`, is at
 * most `lodPx` — level 0 at the eye; independent of bearing.
 */
export function chunkLevel(distanceUm: number, cellUm: number, focalPx: number, lodPx = DEFAULT_LOD_PX): number {
  if (!(distanceUm > 0)) return 0;
  const l = Math.floor(Math.log2((lodPx * distanceUm) / (focalPx * cellUm)));
  return Math.min(Math.max(l, 0), LEVELS - 1);
}

/** False when the box lies wholly outside one clip plane of m. */
export function boxInFrustum(m: ArrayLike<number>, b: Box3): boolean {
  let out = 0b111111;
  for (const x of [b.minX, b.maxX])
    for (const y of [b.minY, b.maxY])
      for (const z of [b.minZ, b.maxZ]) {
        const [cx, cy, cz, w] = transform(m, x, y, z);
        let o = 0;
        if (cx < -w) o |= 1;
        if (cx > w) o |= 2;
        if (cy < -w) o |= 4;
        if (cy > w) o |= 8;
        if (cz < -w) o |= 16;
        if (cz > w) o |= 32;
        out &= o;
        if (out === 0) return true;
      }
  return out === 0;
}

export interface ChunkSelection {
  /** Per level: (ix0, iy0, skirt height) per drawn chunk. */
  instances: Float32Array[];
  stats: { chunks: number; culled: number; triangles: number; perLevel: number[] };
}

export interface SelectOptions {
  exaggeration: number;
  lodPx?: number;
  /** Draw every chunk at this level (the dev page's `lod=`). */
  level?: number;
}

/** The chunks in view and their levels for one frame. */
export function selectChunks(mesh: TerrainMesh, frame: Pick<CameraFrame, "eye" | "focalPx" | "matrix">, opts: SelectOptions): ChunkSelection {
  const per: number[][] = Array.from({ length: LEVELS }, () => []);
  let culled = 0;
  for (const c of mesh.chunks) {
    const box = chunkBox(mesh, c, opts.exaggeration);
    if (!boxInFrustum(frame.matrix, box)) {
      culled++;
      continue;
    }
    const level = opts.level ?? chunkLevel(Math.sqrt(boxDistanceSq(box, frame.eye)), mesh.cellUm, frame.focalPx, opts.lodPx);
    per[Math.min(Math.max(level, 0), LEVELS - 1)].push(c.ix0, c.iy0, c.zMin);
  }
  const perLevel = per.map((a) => a.length / 3);
  return {
    instances: per.map((a) => Float32Array.from(a)),
    stats: { chunks: mesh.chunks.length - culled, culled, triangles: perLevel.reduce((s, n, l) => s + n * levelTriangles(l), 0), perLevel },
  };
}

/**
 * Model position of chunk vertex (i, j) at a level as the vertex shader
 * computes it: grid cell clamped to the field, the skirt at the chunk's
 * `zMin`. For tests and the pick.
 */
export function chunkVertex(mesh: TerrainMesh, c: TerrainChunk, i: number, j: number, skirt: boolean, exaggeration: number): [number, number, number] {
  const gx = Math.min(c.ix0 + i, mesh.width - 1), gy = Math.min(c.iy0 + j, mesh.height - 1);
  const h = skirt ? c.zMin : mesh.heights[gy * mesh.width + gx];
  return [mesh.x0Um + gx * mesh.cellUm, mesh.y0Um + gy * mesh.cellUm, (h - mesh.zMin) * mesh.unitUm * exaggeration];
}
