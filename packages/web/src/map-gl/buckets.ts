/**
 * WebGL2 backend, buckets (docs/map-rendering.md §5.2 "Arena and buckets";
 * research 04 §6.8, §6.11, §7).
 *
 * The document is cut into 50 mm paper cells. Every object goes, whole,
 * to the cell holding the centre of its symbolised bounds, or — when the
 * bounds exceed 2 × 2 cells — to the one **large-object bucket**. A cell
 * is prepared in two layers: `base` (fills and hatches, prepared for the
 * whole document at load and always resident) and `detail` (strokes,
 * glyphs, text, pattern clips — prepared on demand above the zoom gate,
 * evicted LRU past the memory budget). The large bucket is one `all`
 * part, prepared at load and always resident.
 *
 * A prepared part keeps its geometry per kind with a **range table**:
 * entries `(colour, group, object, start, count)` in colour-major order,
 * one per run of an object's indices (or instances). The renderer
 * concatenates the visible parts' ranges per (colour, kind) into one
 * index (or instance) buffer — the **visible set** — so a frame costs a
 * draw per (colour, kind) in view, not per bucket; hiding an object is
 * skipping its ranges.
 *
 * Pure TypeScript over typed arrays (the worker runs it); nothing here
 * touches GL.
 */

import { render } from "@oxygen/shared";
import { MITRE_LIMIT, strokeStrip, triangulateEvenOdd, type StripSink } from "./prepare.js";
import { INSTANCE_FLOATS, type AtlasMesh } from "./mesh-atlas.js";


// ---- constants (04 §6.11; the spec's table) ---------------------------------

/** Paper cell size, µm. */
export const CELL_UM = 50_000;
/** An object whose bounds exceed this many cells in x or y is a large object. */
export const LARGE_CELLS = 2;
/** Cells around the viewport that are drawn: an object assigned by its centre reaches at most one cell out. */
export const DRAW_MARGIN_CELLS = 1;
/** Cells around the viewport that are prepared ahead of a pan. */
export const PREFETCH_MARGIN_CELLS = 2;
/** The zoom gate: below it, a 0.14 mm line is under 0.15 device px even after the hairline floor. */
export const GATE_LINE_UM = 140;
export const GATE_PX = 0.15;
/** Resident GPU budgets, bytes (01: event maps, club maps). */
export const EVENT_BUDGET_BYTES = 30 * 1024 * 1024;
export const CLUB_BUDGET_BYTES = 150 * 1024 * 1024;

/** Per-vertex bytes of the arena layouts. */
export const FILL_VERTEX_BYTES = 8; // f32 x, y
export const STROKE_VERTEX_BYTES = 16; // f32 x, y; i16 ox, oy (normalised / MITRE_LIMIT); u16 half width (½ µm); u16 pad
export const HATCH_VERTEX_BYTES = 28; // f32 x, y, nx, ny, spacing, offset, halfWidth

/** True when ordinary buckets' detail (strokes, glyphs, text) is drawn at this zoom. */
export function aboveZoomGate(pxPerUm: number): boolean {
  return GATE_LINE_UM * pxPerUm >= GATE_PX;
}

// ---- grid and assignment ---------------------------------------------------

export interface Grid {
  cellUm: number;
  /** Column / row of the first cell; cells are aligned to multiples of `cellUm` from the paper origin. */
  minCol: number;
  minRow: number;
  cols: number;
  rows: number;
}

export interface Assignment {
  grid: Grid;
  /** Bucket id of the large-object bucket (= cols × rows). */
  largeId: number;
  /** Per object (stream `objectIdx`): bucket id, −1 for an object without passes. */
  objectBucket: Int32Array;
  /** Per object: minX, minY, maxX, maxY of its passes, µm. */
  objectBounds: Float64Array;
  /** Bucket id → pass indices in stream order. */
  bucketPasses: Map<number, number[]>;
}

export function cellId(grid: Grid, col: number, row: number): number {
  return (row - grid.minRow) * grid.cols + (col - grid.minCol);
}

/**
 * Paper bounds of one pass, µm, including what the backend adds: half the
 * stroke width (× the mitre limit, so joins are inside), glyph mesh
 * radius × instance scale, the text em box and halo.
 */
export function passBounds(pass: render.Pass, meshRadius: (glyphId: number, partIdx: number) => number): render.Bounds | undefined {
  switch (pass.kind) {
    case "fill":
    case "hatch":
      return pass.path.coords.length ? render.pathBounds(pass.path) : undefined;
    case "stroke": {
      if (!pass.path.coords.length) return undefined;
      const b = render.pathBounds(pass.path);
      const e = (pass.widthUm / 2) * MITRE_LIMIT;
      return { minX: b.minX - e, minY: b.minY - e, maxX: b.maxX + e, maxY: b.maxY + e };
    }
    case "glyph": {
      const r = meshRadius(pass.glyphId, pass.partIdx);
      let b: render.Bounds | undefined;
      for (let i = 0; i < pass.instances.length; i += 5) {
        const x = pass.instances[i], y = pass.instances[i + 1], rr = r * pass.instances[i + 4];
        b = union(b, x - rr, y - rr, x + rr, y + rr);
      }
      return b;
    }
    case "text": {
      const h = pass.haloWidthUm ?? 0;
      let b: render.Bounds | undefined;
      for (let i = 0; i < pass.positions.length; i += 2) {
        const x = pass.positions[i], y = pass.positions[i + 1];
        b = union(b, x - h, y - 0.25 * pass.sizeUm - h, x + pass.sizeUm + h, y + pass.sizeUm + h);
      }
      return b;
    }
  }
}

function union(b: render.Bounds | undefined, minX: number, minY: number, maxX: number, maxY: number): render.Bounds {
  if (!b) return { minX, minY, maxX, maxY };
  return { minX: Math.min(b.minX, minX), minY: Math.min(b.minY, minY), maxX: Math.max(b.maxX, maxX), maxY: Math.max(b.maxY, maxY) };
}

/** Assigns every object of a stream to a cell or to the large bucket. */
export function assignBuckets(
  stream: render.PassStream,
  meshRadius: (glyphId: number, partIdx: number) => number,
  opts: { cellUm?: number; largeCells?: number } = {},
): Assignment {
  const cellUm = opts.cellUm ?? CELL_UM;
  const largeUm = (opts.largeCells ?? LARGE_CELLS) * cellUm;
  let objects = 0;
  for (let i = 0; i < stream.objectIdx.length; i++) objects = Math.max(objects, stream.objectIdx[i] + 1);
  const ob = new Float64Array(objects * 4);
  for (let o = 0; o < objects; o++) {
    ob[4 * o] = Infinity; ob[4 * o + 1] = Infinity; ob[4 * o + 2] = -Infinity; ob[4 * o + 3] = -Infinity;
  }
  stream.passes.forEach((p, i) => {
    const b = passBounds(p, meshRadius);
    if (!b) return;
    const o = stream.objectIdx[i] * 4;
    if (b.minX < ob[o]) ob[o] = b.minX;
    if (b.minY < ob[o + 1]) ob[o + 1] = b.minY;
    if (b.maxX > ob[o + 2]) ob[o + 2] = b.maxX;
    if (b.maxY > ob[o + 3]) ob[o + 3] = b.maxY;
  });
  // Cell of each small object; the grid spans the small objects' cells.
  const col = new Int32Array(objects), row = new Int32Array(objects);
  const kind = new Int8Array(objects); // 0 none, 1 small, 2 large
  let minCol = Infinity, minRow = Infinity, maxCol = -Infinity, maxRow = -Infinity;
  for (let o = 0; o < objects; o++) {
    const [x0, y0, x1, y1] = [ob[4 * o], ob[4 * o + 1], ob[4 * o + 2], ob[4 * o + 3]];
    if (!(x1 >= x0)) continue;
    if (x1 - x0 > largeUm || y1 - y0 > largeUm) {
      kind[o] = 2;
      continue;
    }
    kind[o] = 1;
    col[o] = Math.floor((x0 + x1) / 2 / cellUm);
    row[o] = Math.floor((y0 + y1) / 2 / cellUm);
    if (col[o] < minCol) minCol = col[o];
    if (col[o] > maxCol) maxCol = col[o];
    if (row[o] < minRow) minRow = row[o];
    if (row[o] > maxRow) maxRow = row[o];
  }
  if (minCol === Infinity) { minCol = 0; maxCol = 0; minRow = 0; maxRow = 0; }
  const grid: Grid = { cellUm, minCol, minRow, cols: maxCol - minCol + 1, rows: maxRow - minRow + 1 };
  const largeId = grid.cols * grid.rows;
  const objectBucket = new Int32Array(objects).fill(-1);
  for (let o = 0; o < objects; o++) {
    if (kind[o] === 1) objectBucket[o] = cellId(grid, col[o], row[o]);
    else if (kind[o] === 2) objectBucket[o] = largeId;
  }
  const bucketPasses = new Map<number, number[]>();
  for (let i = 0; i < stream.passes.length; i++) {
    const bkt = objectBucket[stream.objectIdx[i]];
    if (bkt < 0) continue;
    let arr = bucketPasses.get(bkt);
    if (!arr) bucketPasses.set(bkt, (arr = []));
    arr.push(i);
  }
  return { grid, largeId, objectBucket, objectBounds: ob, bucketPasses };
}

/** The view a frame is drawn with (renderer.ts `View`, repeated so this file stays GL-free). */
export interface ViewRect {
  centreX: number;
  centreY: number;
  pxPerUm: number;
  widthPx: number;
  heightPx: number;
  /** Display rotation, degrees counter-clockwise (B4's north offset); default 0. */
  rotationDeg?: number;
}

/** The view that shows `bounds` whole in a canvas, filling `fill` of the tighter dimension. */
export function fitView(bounds: render.Bounds | undefined, widthPx: number, heightPx: number, fill = 0.95): ViewRect {
  const b = bounds ?? { minX: 0, minY: 0, maxX: 1000, maxY: 1000 };
  const pxPerUm = Math.min(widthPx / Math.max(1, b.maxX - b.minX), heightPx / Math.max(1, b.maxY - b.minY)) * fill;
  return { centreX: (b.minX + b.maxX) / 2, centreY: (b.minY + b.maxY) / 2, pxPerUm, widthPx, heightPx };
}

/** Paper bounds the viewport covers (the bounding box of the rotated canvas). */
export function viewBounds(view: ViewRect): render.Bounds {
  let hx = view.widthPx / 2 / view.pxPerUm, hy = view.heightPx / 2 / view.pxPerUm;
  if (view.rotationDeg) {
    const a = (view.rotationDeg * Math.PI) / 180;
    const c = Math.abs(Math.cos(a)), s = Math.abs(Math.sin(a));
    [hx, hy] = [c * hx + s * hy, s * hx + c * hy];
  }
  return { minX: view.centreX - hx, minY: view.centreY - hy, maxX: view.centreX + hx, maxY: view.centreY + hy };
}

/** Cell ids meeting the viewport, grown by `margin` cells, clamped to the grid; nearest the centre first. */
export function visibleCells(view: ViewRect, grid: Grid, margin: number): number[] {
  const b = viewBounds(view);
  const c0 = Math.max(grid.minCol, Math.floor(b.minX / grid.cellUm) - margin);
  const c1 = Math.min(grid.minCol + grid.cols - 1, Math.floor(b.maxX / grid.cellUm) + margin);
  const r0 = Math.max(grid.minRow, Math.floor(b.minY / grid.cellUm) - margin);
  const r1 = Math.min(grid.minRow + grid.rows - 1, Math.floor(b.maxY / grid.cellUm) + margin);
  const out: { id: number; d: number }[] = [];
  const cc = view.centreX / grid.cellUm - 0.5, cr = view.centreY / grid.cellUm - 0.5;
  for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) out.push({ id: cellId(grid, c, r), d: (c - cc) ** 2 + (r - cr) ** 2 });
  out.sort((a, b) => a.d - b.d || a.id - b.id);
  return out.map((x) => x.id);
}

// ---- prepared parts ----------------------------------------------------------

/** Colour-major per-object ranges of one part's indices (or instances). */
export interface RangeTable {
  colour: Uint16Array;
  /** Size class for instance kinds, 0 otherwise. */
  group: Uint16Array;
  object: Uint32Array;
  start: Uint32Array;
  count: Uint32Array;
}

export interface IndexedPart {
  /** Packed vertices in the kind's arena layout, positions relative to the document origin. */
  verts: ArrayBuffer;
  vertexCount: number;
  /** Triangle indices, part-local (0 = the part's first vertex). */
  indices: Uint32Array;
  ranges: RangeTable;
}

export interface InstancePart {
  /** INSTANCE_FLOATS per instance; x, y relative to the document origin. */
  instances: Float32Array;
  /** `group` is the size class (glyph) or the text-atlas page (text); start / count in instances. */
  ranges: RangeTable;
}

/** A pattern-clipped glyph pass: its instances are drawn only inside its area (stencil). */
export interface ClipItem {
  colour: number;
  object: number;
  cls: number;
  /** Footprint: area bounds ∪ instance extents (minX, minY, maxX, maxY), origin-relative. */
  bounds: number[];
  /** Clip area triangles, x, y relative to the origin. */
  positions: Float32Array;
  indices: Uint32Array;
  instances: Float32Array;
}

export type PartLayer = "base" | "detail" | "all";

export interface PreparedPart {
  bucket: number;
  layer: PartLayer;
  fill?: IndexedPart;
  hatch?: IndexedPart;
  stroke?: IndexedPart;
  glyph?: InstancePart;
  text?: InstancePart;
  clips: ClipItem[];
  /**
   * Arena bytes this part occupies on the GPU once uploaded (its fill, hatch and stroke vertices).
   * Instances, indices and clip geometry reach the GPU only through the visible-set buffers, which
   * the renderer counts.
   */
  gpuBytes: number;
  /** Preparation time, ms. */
  ms: number;
}

/** A text pass resolved against the text atlas (docs/map-rendering.md §5.2 "Text atlas"). */
export interface TextPassGlyphs {
  /** Per glyph: glyph-table entry, −1 when the loaded pages do not hold it. */
  entries: Int32Array;
  /** Per glyph: index of the page holding it. */
  pages: Uint8Array;
  /** Halo half width in em, clamped to the field (0 on a fill pass). */
  haloEm: number;
}

export interface PrepareContext {
  /** Flattening tolerance, µm. */
  toleranceUm: number;
  /** Document origin: every arena position is stored relative to it. */
  originX: number;
  originY: number;
  meshes: AtlasMesh[];
  /** `${glyphId}/${partIdx}` → atlas mesh index. */
  glyphMesh: Map<string, number>;
  /** Text pass index → per-glyph text-atlas entry (−1: not in the loaded pages) and page, and the halo half width in em (0: fill). */
  textGlyph: Map<number, TextPassGlyphs>;
}

const BASE_KINDS = new Set<render.PassKind>(["fill", "hatch"]);

/** Growable float32 / uint32 arrays: preparation appends without `number[]` boxing or a copy at the end. */
class GrowF32 {
  a = new Float32Array(1024);
  n = 0;
  reserve(k: number): void {
    if (this.n + k <= this.a.length) return;
    const b = new Float32Array(Math.max(this.a.length * 2, this.n + k));
    b.set(this.a.subarray(0, this.n));
    this.a = b;
  }
  view(): Float32Array {
    return this.a.slice(0, this.n);
  }
}

class GrowU32 {
  a = new Uint32Array(1024);
  n = 0;
  reserve(k: number): void {
    if (this.n + k <= this.a.length) return;
    const b = new Uint32Array(Math.max(this.a.length * 2, this.n + k));
    b.set(this.a.subarray(0, this.n));
    this.a = b;
  }
  view(): Uint32Array {
    return this.a.slice(0, this.n);
  }
}

/** Writes strip vertices straight into the stroke arena layout (`STROKE_VERTEX_BYTES`), origin-relative. */
class StrokeWriter implements StripSink {
  private buf = new ArrayBuffer(STROKE_VERTEX_BYTES * 1024);
  private f32 = new Float32Array(this.buf);
  private i16 = new Int16Array(this.buf);
  private u16 = new Uint16Array(this.buf);
  n = 0;
  readonly indices = new GrowU32();
  /** Half width of the pass being written, ½ µm. */
  hw2 = 0;
  private readonly ox: number;
  private readonly oy: number;
  constructor(ox: number, oy: number) {
    this.ox = ox;
    this.oy = oy;
  }
  vertex(x: number, y: number, ox: number, oy: number): number {
    if ((this.n + 1) * STROKE_VERTEX_BYTES > this.buf.byteLength) {
      const b = new ArrayBuffer(this.buf.byteLength * 2);
      new Uint8Array(b).set(new Uint8Array(this.buf));
      this.buf = b;
      this.f32 = new Float32Array(b);
      this.i16 = new Int16Array(b);
      this.u16 = new Uint16Array(b);
    }
    const i = this.n;
    this.f32[4 * i] = x - this.ox;
    this.f32[4 * i + 1] = y - this.oy;
    this.i16[8 * i + 4] = Math.round((ox / MITRE_LIMIT) * 32767);
    this.i16[8 * i + 5] = Math.round((oy / MITRE_LIMIT) * 32767);
    this.u16[8 * i + 6] = this.hw2;
    this.u16[8 * i + 7] = 0;
    return this.n++;
  }
  triangle(a: number, b: number, c: number): void {
    const ix = this.indices;
    ix.reserve(3);
    ix.a[ix.n++] = a;
    ix.a[ix.n++] = b;
    ix.a[ix.n++] = c;
  }
  vertices(): ArrayBuffer {
    return this.buf.slice(0, this.n * STROKE_VERTEX_BYTES);
  }
}

class RangeBuilder {
  colour: number[] = [];
  group: number[] = [];
  object: number[] = [];
  start: number[] = [];
  count: number[] = [];

  add(colour: number, group: number, object: number, start: number, count: number): void {
    if (count === 0) return;
    const n = this.colour.length - 1;
    if (n >= 0 && this.colour[n] === colour && this.group[n] === group && this.object[n] === object && this.start[n] + this.count[n] === start) {
      this.count[n] += count;
      return;
    }
    this.colour.push(colour); this.group.push(group); this.object.push(object); this.start.push(start); this.count.push(count);
  }

  build(): RangeTable {
    return {
      colour: Uint16Array.from(this.colour), group: Uint16Array.from(this.group), object: Uint32Array.from(this.object),
      start: Uint32Array.from(this.start), count: Uint32Array.from(this.count),
    };
  }
}

/**
 * Prepares one layer of one bucket. `passes` are stream indices in stream
 * order (so colour-major); `layer` picks the kinds: `base` fills and
 * hatches, `detail` the rest, `all` both (the large bucket).
 */
export function prepareBucketPart(stream: render.PassStream, bucket: number, passes: number[], layer: PartLayer, ctx: PrepareContext): PreparedPart {
  const t0 = performance.now();
  const tol = ctx.toleranceUm;
  const ox = ctx.originX, oy = ctx.originY;
  const fillPos = new GrowF32(), fillIdx = new GrowU32(), fillR = new RangeBuilder();
  const hatchVert = new GrowF32(), hatchIdx = new GrowU32(), hatchR = new RangeBuilder();
  const stroke = new StrokeWriter(ox, oy), strokeR = new RangeBuilder();
  const inst = { glyph: new Map<string, { colour: number; cls: number; data: number[]; objects: { object: number; count: number }[] }>(), text: new Map<string, { colour: number; cls: number; data: number[]; objects: { object: number; count: number }[] }>() };
  const clips: ClipItem[] = [];

  const addInstances = (kind: "glyph" | "text", colour: number, cls: number, object: number, data: number[]) => {
    if (!data.length) return;
    const key = `${colour}/${cls}`;
    let g = inst[kind].get(key);
    if (!g) inst[kind].set(key, (g = { colour, cls, data: [], objects: [] }));
    for (const v of data) g.data.push(v);
    g.objects.push({ object, count: data.length / INSTANCE_FLOATS });
  };

  for (const pi of passes) {
    const pass = stream.passes[pi];
    if (layer === "base" && !BASE_KINDS.has(pass.kind)) continue;
    if (layer === "detail" && BASE_KINDS.has(pass.kind)) continue;
    const object = stream.objectIdx[pi];
    switch (pass.kind) {
      case "fill": {
        const { positions, indices } = triangulateEvenOdd(render.flattenRings(pass.path, tol));
        const base = fillPos.n / 2;
        fillPos.reserve(positions.length);
        for (let i = 0; i < positions.length; i += 2) { fillPos.a[fillPos.n++] = positions[i] - ox; fillPos.a[fillPos.n++] = positions[i + 1] - oy; }
        const start = fillIdx.n;
        fillIdx.reserve(indices.length);
        for (let i = 0; i < indices.length; i++) fillIdx.a[fillIdx.n++] = indices[i] + base;
        fillR.add(pass.colour, 0, object, start, indices.length);
        break;
      }
      case "hatch": {
        const { positions, indices } = triangulateEvenOdd(render.flattenRings(pass.path, tol));
        const a = (pass.angleDeg * Math.PI) / 180;
        const nx = -Math.sin(a), ny = Math.cos(a);
        // Positions are origin-relative, so the stripe offset moves by the origin's projection (in f64).
        const off = pass.offsetUm - (ox * nx + oy * ny);
        const base = hatchVert.n / 7;
        hatchVert.reserve((positions.length / 2) * 7);
        for (let i = 0; i < positions.length; i += 2) {
          const h = hatchVert.a;
          let k = hatchVert.n;
          h[k++] = positions[i] - ox; h[k++] = positions[i + 1] - oy; h[k++] = nx; h[k++] = ny; h[k++] = pass.spacingUm; h[k++] = off; h[k++] = pass.widthUm / 2;
          hatchVert.n = k;
        }
        const start = hatchIdx.n;
        hatchIdx.reserve(indices.length);
        for (let i = 0; i < indices.length; i++) hatchIdx.a[hatchIdx.n++] = indices[i] + base;
        hatchR.add(pass.colour, 0, object, start, indices.length);
        break;
      }
      case "stroke": {
        stroke.hw2 = Math.min(65535, Math.round(pass.widthUm));
        const start = stroke.indices.n;
        strokeStrip(pass, tol, stroke);
        strokeR.add(pass.colour, 0, object, start, stroke.indices.n - start);
        break;
      }
      case "glyph": {
        const mi = ctx.glyphMesh.get(`${pass.glyphId}/${pass.partIdx}`);
        if (mi === undefined) break;
        const m = ctx.meshes[mi];
        const data: number[] = [];
        for (let i = 0; i < pass.instances.length; i += 5) {
          data.push(pass.instances[i] - ox, pass.instances[i + 1] - oy, pass.instances[i + 2], pass.instances[i + 3], pass.instances[i + 4], m.base, m.count, m.radius);
        }
        if (pass.clip) {
          const { positions, indices } = triangulateEvenOdd(render.flattenRings(pass.clip, tol));
          const pos = new Float32Array(positions.length);
          for (let i = 0; i < positions.length; i += 2) { pos[i] = positions[i] - ox; pos[i + 1] = positions[i + 1] - oy; }
          const bounds = [Infinity, Infinity, -Infinity, -Infinity];
          const grow = (x0: number, y0: number, x1: number, y1: number) => {
            bounds[0] = Math.min(bounds[0], x0); bounds[1] = Math.min(bounds[1], y0);
            bounds[2] = Math.max(bounds[2], x1); bounds[3] = Math.max(bounds[3], y1);
          };
          for (let i = 0; i < pos.length; i += 2) grow(pos[i], pos[i + 1], pos[i], pos[i + 1]);
          for (let i = 0; i < data.length; i += INSTANCE_FLOATS) {
            const rr = m.radius * data[i + 4];
            grow(data[i] - rr, data[i + 1] - rr, data[i] + rr, data[i + 1] + rr);
          }
          clips.push({ colour: pass.colour, object, cls: m.cls, bounds, positions: pos, indices: Uint32Array.from(indices), instances: Float32Array.from(data) });
        } else {
          addInstances("glyph", pass.colour, m.cls, object, data);
        }
        break;
      }
      case "text": {
        const t = ctx.textGlyph.get(pi);
        if (!t) break;
        // One quad instance per glyph: x, y, cos, sin, em size, atlas entry, halo (em), 0;
        // grouped by atlas page (one texture per draw).
        const byPage = new Map<number, number[]>();
        for (let g = 0; g < pass.glyphs.length; g++) {
          const entry = t.entries[g];
          if (entry < 0) continue;
          let arr = byPage.get(t.pages[g]);
          if (!arr) byPage.set(t.pages[g], (arr = []));
          const a = pass.angles ? (pass.angles[g] * Math.PI) / 180 : 0; // §3.5 `angles`, degrees CCW
          arr.push(pass.positions[2 * g] - ox, pass.positions[2 * g + 1] - oy, Math.cos(a), Math.sin(a), pass.sizeUm, entry, t.haloEm, 0);
        }
        for (const [page, data] of byPage) addInstances("text", pass.colour, page, object, data);
        break;
      }
    }
  }

  const part: PreparedPart = { bucket, layer, clips, gpuBytes: 0, ms: 0 };
  if (fillIdx.n) {
    part.fill = { verts: fillPos.view().buffer as ArrayBuffer, vertexCount: fillPos.n / 2, indices: fillIdx.view(), ranges: fillR.build() };
  }
  if (hatchIdx.n) {
    part.hatch = { verts: hatchVert.view().buffer as ArrayBuffer, vertexCount: hatchVert.n / 7, indices: hatchIdx.view(), ranges: hatchR.build() };
  }
  if (stroke.indices.n) {
    part.stroke = { verts: stroke.vertices(), vertexCount: stroke.n, indices: stroke.indices.view(), ranges: strokeR.build() };
  }
  for (const kind of ["glyph", "text"] as const) {
    const groups = [...inst[kind].values()].sort((a, b) => a.colour - b.colour || a.cls - b.cls);
    if (!groups.length) continue;
    const total = groups.reduce((n, g) => n + g.data.length, 0);
    const instances = new Float32Array(total);
    const rb = new RangeBuilder();
    let o = 0;
    for (const g of groups) {
      instances.set(g.data, o);
      let at = o / INSTANCE_FLOATS;
      for (const { object, count } of g.objects) {
        rb.add(g.colour, g.cls, object, at, count);
        at += count;
      }
      o += g.data.length;
    }
    part[kind] = { instances, ranges: rb.build() };
  }
  part.gpuBytes =
    (part.fill?.vertexCount ?? 0) * FILL_VERTEX_BYTES +
    (part.hatch?.vertexCount ?? 0) * HATCH_VERTEX_BYTES +
    (part.stroke?.vertexCount ?? 0) * STROKE_VERTEX_BYTES;
  part.ms = performance.now() - t0;
  return part;
}

/** All typed-array buffers of a part, for `postMessage` transfer. */
export function partTransferables(p: PreparedPart): ArrayBuffer[] {
  const out: ArrayBuffer[] = [];
  const t = (r: RangeTable) => out.push(r.colour.buffer as ArrayBuffer, r.group.buffer as ArrayBuffer, r.object.buffer as ArrayBuffer, r.start.buffer as ArrayBuffer, r.count.buffer as ArrayBuffer);
  for (const k of [p.fill, p.hatch, p.stroke]) {
    if (!k) continue;
    out.push(k.verts, k.indices.buffer as ArrayBuffer);
    t(k.ranges);
  }
  for (const k of [p.glyph, p.text]) {
    if (!k) continue;
    out.push(k.instances.buffer as ArrayBuffer);
    t(k.ranges);
  }
  for (const c of p.clips) out.push(c.positions.buffer as ArrayBuffer, c.indices.buffer as ArrayBuffer, c.instances.buffer as ArrayBuffer);
  return out;
}

// ---- visible set -------------------------------------------------------------

/** A resident part and where its vertices sit in the arenas (vertex offsets per indexed kind). */
export interface ResidentPart {
  part: PreparedPart;
  base: { fill: number; hatch: number; stroke: number };
}

export interface IndexDraw {
  colour: number;
  /** First index in the visible-set buffer. */
  offset: number;
  count: number;
}

export interface InstanceDraw {
  colour: number;
  /** Size class (glyph) or text-atlas page (text). */
  cls: number;
  first: number;
  count: number;
}

export interface ClipGroup {
  colour: number;
  /** Largest size class of the members' meshes. */
  cls: number;
  /** Clip-area triangles: first index and index count in `clips.indices`. */
  offset: number;
  count: number;
  /** Instances: first and count in `clips.instances`. */
  first: number;
  instances: number;
  members: number;
}

export interface VisibleSet {
  fill: { indices: Uint32Array; draws: IndexDraw[] };
  hatch: { indices: Uint32Array; draws: IndexDraw[] };
  stroke: { indices: Uint32Array; draws: IndexDraw[] };
  glyph: { instances: Float32Array; draws: InstanceDraw[] };
  text: { instances: Float32Array; draws: InstanceDraw[] };
  /**
   * Pattern-clipped glyph passes in view, merged per colour into groups
   * whose footprints do not overlap, so no instance can fall inside
   * another member's area and one stencil mark / draw / clear serves the
   * group. Arrays are concatenated across groups; group indices are
   * global into `positions`.
   */
  clips: { positions: Float32Array; indices: Uint32Array; instances: Float32Array; groups: ClipGroup[] };
  /** Colours with anything to draw, ascending. */
  colours: number[];
}

/**
 * Concatenates the ranges of the given parts per (colour, kind) into
 * visible-set buffers, skipping `hidden` objects. Index values are
 * rebased onto each part's arena vertex offset.
 */
export function buildVisibleSet(parts: ResidentPart[], hidden?: ReadonlySet<number>): VisibleSet {
  const hide = hidden && hidden.size ? hidden : undefined;
  const indexed = (kind: "fill" | "hatch" | "stroke") => {
    // Spans: (colour, part, entry lo..hi) in colour order, parts in the given order within a colour.
    const spans: { colour: number; p: ResidentPart; lo: number; hi: number }[] = [];
    let total = 0;
    for (const p of parts) {
      const k = p.part[kind];
      if (!k) continue;
      const r = k.ranges;
      let lo = 0;
      while (lo < r.colour.length) {
        let hi = lo + 1;
        while (hi < r.colour.length && r.colour[hi] === r.colour[lo]) hi++;
        spans.push({ colour: r.colour[lo], p, lo, hi });
        total += r.start[hi - 1] + r.count[hi - 1] - r.start[lo];
        lo = hi;
      }
    }
    spans.sort((a, b) => a.colour - b.colour);
    const indices = new Uint32Array(total);
    const draws: IndexDraw[] = [];
    let o = 0;
    for (const s of spans) {
      const k = s.p.part[kind]!;
      const r = k.ranges;
      const add = s.p.base[kind];
      const before = o;
      if (!hide) {
        const a = r.start[s.lo], b = r.start[s.hi - 1] + r.count[s.hi - 1];
        for (let i = a; i < b; i++) indices[o++] = k.indices[i] + add;
      } else {
        for (let e = s.lo; e < s.hi; e++) {
          if (hide.has(r.object[e])) continue;
          const a = r.start[e], b = a + r.count[e];
          for (let i = a; i < b; i++) indices[o++] = k.indices[i] + add;
        }
      }
      if (o === before) continue;
      const last = draws[draws.length - 1];
      if (last && last.colour === s.colour) last.count += o - before;
      else draws.push({ colour: s.colour, offset: before, count: o - before });
    }
    return { indices: o === total ? indices : indices.slice(0, o), draws };
  };
  const instanced = (kind: "glyph" | "text") => {
    const spans: { colour: number; cls: number; p: ResidentPart; lo: number; hi: number }[] = [];
    let total = 0;
    for (const p of parts) {
      const k = p.part[kind];
      if (!k) continue;
      const r = k.ranges;
      let lo = 0;
      while (lo < r.colour.length) {
        let hi = lo + 1;
        while (hi < r.colour.length && r.colour[hi] === r.colour[lo] && r.group[hi] === r.group[lo]) hi++;
        spans.push({ colour: r.colour[lo], cls: r.group[lo], p, lo, hi });
        total += r.start[hi - 1] + r.count[hi - 1] - r.start[lo];
        lo = hi;
      }
    }
    spans.sort((a, b) => a.colour - b.colour || a.cls - b.cls);
    const instances = new Float32Array(total * INSTANCE_FLOATS);
    const draws: InstanceDraw[] = [];
    let o = 0; // instances written
    for (const s of spans) {
      const k = s.p.part[kind]!;
      const r = k.ranges;
      const before = o;
      for (let e = s.lo; e < s.hi; e++) {
        if (hide?.has(r.object[e])) continue;
        const a = r.start[e] * INSTANCE_FLOATS, n = r.count[e];
        instances.set(k.instances.subarray(a, a + n * INSTANCE_FLOATS), o * INSTANCE_FLOATS);
        o += n;
      }
      if (o === before) continue;
      const last = draws[draws.length - 1];
      if (last && last.colour === s.colour && last.cls === s.cls) last.count += o - before;
      else draws.push({ colour: s.colour, cls: s.cls, first: before, count: o - before });
    }
    return { instances: o === total ? instances : instances.slice(0, o * INSTANCE_FLOATS), draws };
  };
  const vs: VisibleSet = {
    fill: indexed("fill"), hatch: indexed("hatch"), stroke: indexed("stroke"),
    glyph: instanced("glyph"), text: instanced("text"), clips: groupClips(parts, hide), colours: [],
  };
  const cs = new Set<number>();
  for (const k of [vs.fill, vs.hatch, vs.stroke, vs.glyph, vs.text]) for (const d of k.draws) cs.add(d.colour);
  for (const g of vs.clips.groups) cs.add(g.colour);
  vs.colours = [...cs].sort((a, b) => a - b);
  return vs;
}

/** Greedy grouping of clip items per colour: an item joins the first group none of whose footprints it meets. */
function groupClips(parts: ResidentPart[], hide: ReadonlySet<number> | undefined): VisibleSet["clips"] {
  const items: ClipItem[] = [];
  for (const p of parts) for (const item of p.part.clips) if (!hide?.has(item.object)) items.push(item);
  items.sort((a, b) => a.colour - b.colour);
  const meets = (a: number[], b: number[]) => a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];
  const grouped: { colour: number; members: ClipItem[] }[] = [];
  let colourStart = 0;
  for (const item of items) {
    if (grouped.length && grouped[grouped.length - 1].colour !== item.colour) colourStart = grouped.length;
    let g = grouped.slice(colourStart).find((x) => x.colour === item.colour && x.members.every((m) => !meets(m.bounds, item.bounds)));
    if (!g) grouped.push((g = { colour: item.colour, members: [] }));
    g.members.push(item);
  }
  let nPos = 0, nIdx = 0, nInst = 0;
  for (const it of items) { nPos += it.positions.length; nIdx += it.indices.length; nInst += it.instances.length; }
  const positions = new Float32Array(nPos), indices = new Uint32Array(nIdx), instances = new Float32Array(nInst);
  const groups: ClipGroup[] = [];
  let po = 0, io = 0, so = 0;
  for (const g of grouped) {
    const group: ClipGroup = { colour: g.colour, cls: 0, offset: io, count: 0, first: so / INSTANCE_FLOATS, instances: 0, members: g.members.length };
    for (const m of g.members) {
      const base = po / 2;
      positions.set(m.positions, po);
      po += m.positions.length;
      for (let i = 0; i < m.indices.length; i++) indices[io + i] = m.indices[i] + base;
      io += m.indices.length;
      instances.set(m.instances, so);
      so += m.instances.length;
      group.cls = Math.max(group.cls, m.cls);
    }
    group.count = io - group.offset;
    group.instances = so / INSTANCE_FLOATS - group.first;
    groups.push(group);
  }
  return { positions, indices, instances, groups };
}

// ---- residency -----------------------------------------------------------------

/**
 * LRU bookkeeping for evictable parts (ordinary buckets' detail). The
 * base layer and the large bucket are not entered: they are always
 * resident and only count against the budget.
 */
export class BucketLru {
  private readonly entries = new Map<number, { bytes: number; used: number }>();
  private tick = 0;
  /** Bytes of the always-resident layers (base, large bucket, atlas). */
  fixedBytes = 0;
  budgetBytes: number;

  constructor(budgetBytes: number) {
    this.budgetBytes = budgetBytes;
  }

  get evictableBytes(): number {
    let n = 0;
    for (const e of this.entries.values()) n += e.bytes;
    return n;
  }

  get totalBytes(): number {
    return this.fixedBytes + this.evictableBytes;
  }

  has(id: number): boolean {
    return this.entries.has(id);
  }

  add(id: number, bytes: number): void {
    this.entries.set(id, { bytes, used: ++this.tick });
  }

  remove(id: number): void {
    this.entries.delete(id);
  }

  /** Marks parts as used now (the drawn set; equal stamps break ties by id). */
  touch(ids: Iterable<number>): void {
    const t = ++this.tick;
    for (const id of ids) {
      const e = this.entries.get(id);
      if (e) e.used = t;
    }
  }

  /**
   * Ids to evict, least recently used first, until the total is within
   * the budget. `protect` (the drawn set) is never evicted; if the
   * protected set alone exceeds the budget the result leaves the total
   * over it and `over` says so.
   */
  evictions(protect: ReadonlySet<number>): { evict: number[]; over: boolean } {
    let total = this.totalBytes;
    if (total <= this.budgetBytes) return { evict: [], over: false };
    const order = [...this.entries.entries()].filter(([id]) => !protect.has(id)).sort((a, b) => a[1].used - b[1].used || a[0] - b[0]);
    const evict: number[] = [];
    for (const [id, e] of order) {
      if (total <= this.budgetBytes) break;
      evict.push(id);
      total -= e.bytes;
    }
    return { evict, over: total > this.budgetBytes };
  }
}
