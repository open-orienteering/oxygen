/**
 * WebGL2 backend, batching: `PreparedStream` → draw batches.
 *
 * The stream is colour-major, and within one colour everything is opaque
 * and of the same colour, so merging items of the same kind inside a
 * colour run cannot change the picture. One draw per (colour run, kind,
 * glyph mesh) replaces one draw per pass: ~2 000–100 000 passes become a
 * few hundred draws (04 §6.8's "visible-set per (colour, kind)" without
 * the visible-set part — the spike draws the whole document).
 *
 *   fill      one batch per colour run — rings triangulated with earcut
 *             into one position buffer + one index buffer (no stencil:
 *             the stencil parity trick cannot merge overlapping fills)
 *   stroke    one batch per colour run — the half width moves from a
 *             uniform into a per-vertex attribute so widths can mix
 *   instanced one batch per (colour run, mesh geometry) — instance arrays
 *             concatenated; clipped (pattern-clip) items stay alone
 *   hatch     one batch per pass (its own stencil area and stripe params)
 *
 * Pure TypeScript; the renderer uploads the arrays as they are.
 */

import earcut from "earcut";
import type { FanGeometry, Prepared, PreparedHatch, PreparedStream, StrokeGeometry } from "./prepare.js";

export interface FillBatch {
  kind: "fill";
  colour: number;
  /** x, y per vertex. */
  positions: Float32Array;
  indices: Uint32Array;
  /** Source passes merged into this batch. */
  passes: number;
}

export interface StrokeBatch {
  kind: "stroke";
  colour: number;
  /** x, y, ox, oy, halfWidth per vertex. */
  verts: Float32Array;
  passes: number;
}

export interface InstancedBatch {
  kind: "instanced";
  colour: number;
  instances: Float32Array;
  fill?: FanGeometry;
  strokes: StrokeGeometry[];
  clip?: FanGeometry;
  passes: number;
}

export interface HatchBatch {
  kind: "hatch";
  colour: number;
  item: PreparedHatch;
  passes: number;
}

export type Batch = FillBatch | StrokeBatch | InstancedBatch | HatchBatch;

export interface BatchStats {
  batches: number;
  passes: number;
  fillTriangles: number;
  strokeTriangles: number;
  instances: number;
  /** Bytes the renderer will upload. */
  bytes: number;
}

export function buildBatches(prepared: PreparedStream): { batches: Batch[]; stats: BatchStats } {
  const batches: Batch[] = [];
  let run: Prepared[] = [];
  let runColour = -1;
  const flush = () => {
    if (run.length) batches.push(...batchColourRun(run, runColour));
    run = [];
  };
  for (const item of prepared.items) {
    if (item.colour !== runColour) {
      flush();
      runColour = item.colour;
    }
    run.push(item);
  }
  flush();

  const stats: BatchStats = { batches: batches.length, passes: prepared.items.length, fillTriangles: 0, strokeTriangles: 0, instances: 0, bytes: 0 };
  for (const b of batches) {
    switch (b.kind) {
      case "fill":
        stats.fillTriangles += b.indices.length / 3;
        stats.bytes += b.positions.byteLength + b.indices.byteLength;
        break;
      case "stroke":
        stats.strokeTriangles += b.verts.length / 15;
        stats.bytes += b.verts.byteLength;
        break;
      case "instanced":
        stats.instances += b.instances.length / 5;
        stats.bytes += b.instances.byteLength;
        break;
      case "hatch":
        stats.bytes += b.item.geometry.fan.byteLength + b.item.geometry.cover.byteLength;
        break;
    }
  }
  // Mesh geometry shared by instanced batches, counted once.
  const seen = new Set<object>();
  for (const b of batches) {
    if (b.kind !== "instanced") continue;
    for (const g of [b.fill, ...b.strokes, b.clip]) {
      if (!g || seen.has(g)) continue;
      seen.add(g);
      stats.bytes += "fan" in g ? g.fan.byteLength + g.cover.byteLength : g.verts.byteLength;
    }
  }
  return { batches, stats };
}

/** Batches of one colour run, emitted in the stream's kind order. */
function batchColourRun(items: Prepared[], colour: number): Batch[] {
  const out: Batch[] = [];
  const fills: FanGeometry[] = [];
  const strokes: StrokeGeometry[] = [];
  const hatches: PreparedHatch[] = [];
  const instanced = new Map<string, InstancedBatch & { parts: Float32Array[] }>();
  const meshIds = new Map<object, number>();
  const idOf = (o: object | undefined) => {
    if (!o) return "-";
    let id = meshIds.get(o);
    if (id === undefined) {
      id = meshIds.size;
      meshIds.set(o, id);
    }
    return String(id);
  };
  let clipped = 0;
  for (const it of items) {
    switch (it.kind) {
      case "fill":
        fills.push(it.geometry);
        break;
      case "stroke":
        strokes.push(it.geometry);
        break;
      case "hatch":
        hatches.push(it);
        break;
      case "instanced": {
        if (it.clip) {
          // Own stencil area: cannot share a draw.
          instanced.set(`clip${clipped++}`, { kind: "instanced", colour, instances: it.instances, fill: it.fill, strokes: it.strokes, clip: it.clip, passes: 1, parts: [] });
          break;
        }
        const key = `${idOf(it.fill)}/${it.strokes.map(idOf).join(",")}`;
        let b = instanced.get(key);
        if (!b) {
          b = { kind: "instanced", colour, instances: new Float32Array(0), fill: it.fill, strokes: it.strokes, passes: 0, parts: [] };
          instanced.set(key, b);
        }
        b.parts.push(it.instances);
        b.passes++;
        break;
      }
    }
  }
  if (fills.length) out.push(triangulateFills(fills, colour));
  for (const h of hatches) out.push({ kind: "hatch", colour, item: h, passes: 1 });
  if (strokes.length) out.push(mergeStrokes(strokes, colour));
  for (const b of instanced.values()) {
    if (b.parts.length) {
      const total = b.parts.reduce((n, p) => n + p.length, 0);
      const merged = new Float32Array(total);
      let o = 0;
      for (const p of b.parts) {
        merged.set(p, o);
        o += p.length;
      }
      b.instances = merged;
    }
    const { parts: _parts, ...rest } = b;
    void _parts;
    out.push(rest);
  }
  return out;
}

export function triangulateFills(fills: FanGeometry[], colour: number): FillBatch {
  let vertexCount = 0;
  for (const f of fills) for (const r of f.rings) vertexCount += r.length / 2;
  const positions = new Float32Array(vertexCount * 2);
  const indexParts: number[][] = [];
  let base = 0;
  let indexCount = 0;
  for (const f of fills) {
    if (!f.rings.length) continue;
    const flat: number[] = [];
    const holes: number[] = [];
    for (let i = 0; i < f.rings.length; i++) {
      if (i > 0) holes.push(flat.length / 2);
      for (const v of f.rings[i]) flat.push(v);
    }
    const tri = earcut(flat, holes.length ? holes : undefined, 2);
    positions.set(flat, base * 2);
    for (let i = 0; i < tri.length; i++) tri[i] += base;
    indexParts.push(tri);
    indexCount += tri.length;
    base += flat.length / 2;
  }
  const indices = new Uint32Array(indexCount);
  let o = 0;
  for (const p of indexParts) {
    indices.set(p, o);
    o += p.length;
  }
  return { kind: "fill", colour, positions, indices, passes: fills.length };
}

export function mergeStrokes(strokes: StrokeGeometry[], colour: number): StrokeBatch {
  let n = 0;
  for (const s of strokes) n += s.verts.length / 4;
  const verts = new Float32Array(n * 5);
  let o = 0;
  for (const s of strokes) {
    const v = s.verts;
    for (let i = 0; i < v.length; i += 4) {
      verts[o++] = v[i];
      verts[o++] = v[i + 1];
      verts[o++] = v[i + 2];
      verts[o++] = v[i + 3];
      verts[o++] = s.halfWidth;
    }
  }
  return { kind: "stroke", colour, verts, passes: strokes.length };
}
