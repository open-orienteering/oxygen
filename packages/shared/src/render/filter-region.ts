/**
 * Filter regions (docs/map-rendering.md §4.11; research 04 §7, 08 §4.5):
 * a closed polygon that removes chosen map symbols inside it, either by
 * cutting their passes at the boundary (`clip`) or by dropping whole
 * objects that meet it (`hide`). Pure functions over a pass stream, so the
 * symbolisation stage and the WebGL2 worker run the same code on the same
 * input and print gets the screen's result by construction.
 */

import { type FilterMask, type Pass, type PassStream, type RenderPath } from "./pass-stream.js";
import { type Bounds, pathBounds, unionBounds } from "./path.js";
import { type FlatRing, flattenRings, pointInRings, polylinesCrossRings } from "./geometry.js";

/**
 * Which passes a region selects: every pass, the passes of the listed
 * symbol indices, or the passes in the listed colour-stack indices.
 */
export type FilterSelect = "all" | number[] | { colours: number[] };

export interface FilterRegion {
  /** Closed polygon, paper µm, y-up; holes are rings starting at a `hole` point. */
  path: RenderPath;
  /** `clip`: the selected passes are cut away inside the region. `hide`: selected objects meeting it are dropped whole. */
  mode: "clip" | "hide";
  symbols: FilterSelect;
  /**
   * Complement of `symbols`: the region acts on every symbol *except* the
   * selected ones — "map simplification: show only these symbols inside"
   * (08 §4.5). Never flips the side: a region always removes inside.
   */
  invert?: boolean;
}

export interface FilterWarning {
  region: number;
  code: "FILTER_EMPTY_REGION";
  message: string;
}

export interface FilterOptions {
  /** Objects with an index ≥ this are never filtered (the course layer drawn over the map). Default: none excluded. */
  objectLimit?: number;
  /**
   * Fast predicate for a region being dragged (04 §7): `hide` tests the
   * objects' symbolised bounds against the region instead of their
   * geometry. The exact predicate runs on release.
   */
  fast?: boolean;
  /** Symbolised bounds per object (`objectBounds(stream)`), when the caller keeps them; computed otherwise. */
  objectBounds?: ReadonlyMap<number, Bounds>;
}

export interface FilterResult {
  /** Objects a `hide` region drops, ascending. */
  hidden: number[];
  /** Per pass of the input stream → index into `masks`, −1 = unmasked; undefined when no pass is masked. */
  maskIdx: Int32Array | undefined;
  masks: FilterMask[];
  warnings: FilterWarning[];
}

/** Flattening tolerance of region and object geometry for the predicates, µm. */
export const REGION_FLATTEN_UM = 10;

interface PreparedRegion {
  index: number;
  region: FilterRegion;
  rings: FlatRing[];
  bounds: Bounds;
}

/** True when `region` selects a pass of symbol `symbolIdx` in colour `colour` (after `invert`). */
export function selectsPass(region: FilterRegion, symbolIdx: number, colour: number): boolean {
  const s = region.symbols;
  const hit = s === "all" ? true : Array.isArray(s) ? s.includes(symbolIdx) : s.colours.includes(colour);
  return region.invert ? !hit : hit;
}

/** The region's rings, flattened at `REGION_FLATTEN_UM`. */
export function regionRings(path: RenderPath): FlatRing[] {
  return flattenRings({ ...path, closed: true }, REGION_FLATTEN_UM).filter((r) => r.length >= 6);
}

const meet = (a: Bounds, b: Bounds) => a.minX <= b.maxX && b.minX <= a.maxX && a.minY <= b.maxY && b.minY <= a.maxY;

/** Glyph-local radius of each glyph id (fills and strokes of every part), µm at scale 1. */
function glyphRadii(stream: PassStream): Map<number, number> {
  const out = new Map<number, number>();
  for (const m of stream.glyphTable) {
    let r = out.get(m.glyphId) ?? 0;
    for (const f of m.fills) {
      const b = pathBounds(f);
      r = Math.max(r, Math.abs(b.minX), Math.abs(b.maxX), Math.abs(b.minY), Math.abs(b.maxY));
    }
    for (const s of m.strokes) {
      const b = pathBounds(s.path);
      r = Math.max(r, Math.max(Math.abs(b.minX), Math.abs(b.maxX), Math.abs(b.minY), Math.abs(b.maxY)) + s.widthUm / 2);
    }
    out.set(m.glyphId, r);
  }
  return out;
}

/** What a pass draws, as bounds: control-point bounds grown by half a stroke width; glyphs by their mesh radius. */
function passBounds(p: Pass, radii: Map<number, number>): Bounds | undefined {
  switch (p.kind) {
    case "fill":
    case "hatch":
      return pathBounds(p.path);
    case "stroke": {
      const b = pathBounds(p.path), h = p.widthUm / 2;
      return { minX: b.minX - h, minY: b.minY - h, maxX: b.maxX + h, maxY: b.maxY + h };
    }
    case "glyph": {
      const r = radii.get(p.glyphId) ?? 0;
      let b: Bounds | undefined;
      for (let i = 0; i < p.instances.length; i += 5) {
        const x = p.instances[i], y = p.instances[i + 1], rr = r * p.instances[i + 4];
        b = unionBounds(b, { minX: x - rr, minY: y - rr, maxX: x + rr, maxY: y + rr });
      }
      return b;
    }
    case "text": {
      let b: Bounds | undefined;
      for (let i = 0; i < p.positions.length; i += 2) {
        const x = p.positions[i], y = p.positions[i + 1], s = p.sizeUm + (p.haloWidthUm ?? 0);
        b = unionBounds(b, { minX: x - s, minY: y - s, maxX: x + s, maxY: y + s });
      }
      return b;
    }
  }
}

/** Symbolised bounds of every object in the stream (the union of its passes'). */
export function objectBounds(stream: PassStream): Map<number, Bounds> {
  const radii = glyphRadii(stream);
  const out = new Map<number, Bounds>();
  stream.passes.forEach((p, i) => {
    const b = passBounds(p, radii);
    if (b) out.set(stream.objectIdx[i], unionBounds(out.get(stream.objectIdx[i]), b));
  });
  return out;
}

/** The fast predicate: do the bounds meet the region (a corner inside, a region vertex inside, or an edge crossing)? */
export function boundsMeetRegion(b: Bounds, rings: FlatRing[], regionBounds?: Bounds): boolean {
  if (regionBounds && !meet(b, regionBounds)) return false;
  const box = [b.minX, b.minY, b.maxX, b.minY, b.maxX, b.maxY, b.minX, b.maxY];
  for (let k = 0; k < 8; k += 2) if (pointInRings(rings, box[k], box[k + 1])) return true;
  for (const r of rings) {
    for (let k = 0; k < r.length; k += 2) {
      if (r[k] >= b.minX && r[k] <= b.maxX && r[k + 1] >= b.minY && r[k + 1] <= b.maxY) return true;
    }
  }
  return polylinesCrossRings([box], true, rings);
}

/**
 * The exact predicate for one pass: does what it draws meet the region?
 * Paths are flattened at `REGION_FLATTEN_UM`: a vertex inside, an edge
 * crossing, or (areas only) a region vertex inside the area. Glyph
 * instances and text glyphs count by their origin; a pattern-clipped glyph
 * pass is its area.
 */
export function passMeetsRegion(p: Pass, rings: FlatRing[]): boolean {
  const pathMeets = (path: RenderPath, area: boolean) => {
    const own = flattenRings(area ? { ...path, closed: true } : path, REGION_FLATTEN_UM).filter((r) => r.length >= 2);
    for (const r of own) for (let k = 0; k < r.length; k += 2) if (pointInRings(rings, r[k], r[k + 1])) return true;
    if (area) {
      const shape = own.filter((r) => r.length >= 6);
      for (const r of rings) for (let k = 0; k < r.length; k += 2) if (pointInRings(shape, r[k], r[k + 1])) return true;
    }
    return polylinesCrossRings(own, area || path.closed, rings);
  };
  switch (p.kind) {
    case "fill":
    case "hatch":
      return pathMeets(p.path, true);
    case "stroke":
      return pathMeets(p.path, false);
    case "glyph":
      if (p.clip) return pathMeets(p.clip, true);
      for (let i = 0; i < p.instances.length; i += 5) if (pointInRings(rings, p.instances[i], p.instances[i + 1])) return true;
      return false;
    case "text":
      for (let i = 0; i < p.positions.length; i += 2) if (pointInRings(rings, p.positions[i], p.positions[i + 1])) return true;
      return false;
  }
}

/**
 * Evaluates `regions` over a symbolised stream: the objects `hide`
 * regions drop and the masks `clip` regions put on the remaining passes.
 * A clip region masks a selected pass when the pass's object bounds meet
 * the region's bounds, so a mask is a function of (object, colour) and a
 * range-based backend can apply it per range-table entry.
 */
export function filterStream(stream: PassStream, regions: readonly FilterRegion[], opts: FilterOptions = {}): FilterResult {
  const limit = opts.objectLimit ?? Infinity;
  const warnings: FilterWarning[] = [];
  const prepared: PreparedRegion[] = [];
  regions.forEach((region, index) => {
    const rings = regionRings(region.path);
    if (!rings.length) {
      warnings.push({ region: index, code: "FILTER_EMPTY_REGION", message: `filter region ${index} has fewer than three points` });
      return;
    }
    const bounds = pathBounds(region.path);
    prepared.push({ index, region, rings, bounds });
  });
  const n = stream.passes.length;
  if (!prepared.length) return { hidden: [], maskIdx: undefined, masks: [], warnings };
  const bounds = opts.objectBounds ?? objectBounds(stream);

  // Passes per object (only filterable objects whose bounds meet some region).
  const touched = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const o = stream.objectIdx[i];
    if (o >= limit) continue;
    const b = bounds.get(o);
    if (!b || !prepared.some((r) => meet(b, r.bounds))) continue;
    let list = touched.get(o);
    if (!list) touched.set(o, (list = []));
    list.push(i);
  }

  const hidden = new Set<number>();
  for (const r of prepared) {
    if (r.region.mode !== "hide") continue;
    for (const [o, passes] of touched) {
      if (hidden.has(o)) continue;
      if (!passes.some((i) => selectsPass(r.region, stream.symbolIdx[i], stream.passes[i].colour))) continue;
      const b = bounds.get(o)!;
      if (!meet(b, r.bounds)) continue;
      const hit = opts.fast ? boundsMeetRegion(b, r.rings) : passes.some((i) => passMeetsRegion(stream.passes[i], r.rings));
      if (hit) hidden.add(o);
    }
  }

  const clips = prepared.filter((r) => r.region.mode === "clip");
  const masks: FilterMask[] = [];
  const maskOf = new Map<string, number>();
  let maskIdx: Int32Array | undefined;
  if (clips.length) {
    const idx = new Int32Array(n).fill(-1);
    for (const [o, passes] of touched) {
      if (hidden.has(o)) continue;
      const b = bounds.get(o)!;
      for (const i of passes) {
        const by = clips.filter((r) => meet(b, r.bounds) && selectsPass(r.region, stream.symbolIdx[i], stream.passes[i].colour));
        if (!by.length) continue;
        const key = by.map((r) => r.index).join(",");
        let m = maskOf.get(key);
        if (m === undefined) {
          m = masks.length;
          maskOf.set(key, m);
          masks.push({ regions: by.map((r) => r.region.path) });
        }
        idx[i] = m;
      }
    }
    if (masks.length) maskIdx = idx;
  }
  // Masks numbered in stream order, so equal inputs give equal streams.
  if (maskIdx) {
    const order = new Map<number, number>();
    for (const m of maskIdx) if (m >= 0 && !order.has(m)) order.set(m, order.size);
    const renumbered = masks.slice();
    for (const [from, to] of order) renumbered[to] = masks[from];
    for (let i = 0; i < n; i++) if (maskIdx[i] >= 0) maskIdx[i] = order.get(maskIdx[i])!;
    masks.splice(0, masks.length, ...renumbered);
  }
  return { hidden: [...hidden].sort((a, b) => a - b), maskIdx, masks, warnings };
}

/** `filterStream` applied: hidden objects' passes removed, masks attached. */
export function applyFilterRegions(
  stream: PassStream,
  regions: readonly FilterRegion[],
  opts: FilterOptions = {},
): { stream: PassStream; hidden: number[]; warnings: FilterWarning[] } {
  const r = filterStream(stream, regions, opts);
  if (!r.hidden.length && !r.maskIdx) return { stream, hidden: r.hidden, warnings: r.warnings };
  const hide = new Set(r.hidden);
  const keep: number[] = [];
  for (let i = 0; i < stream.passes.length; i++) if (!hide.has(stream.objectIdx[i])) keep.push(i);
  const out: PassStream = {
    ...stream,
    objectIdx: Uint32Array.from(keep, (i) => stream.objectIdx[i]),
    symbolIdx: Uint32Array.from(keep, (i) => stream.symbolIdx[i]),
    passes: keep.map((i) => stream.passes[i]),
  };
  delete out.masks;
  delete out.maskIdx;
  if (r.maskIdx) {
    const maskIdx = Int32Array.from(keep, (i) => r.maskIdx![i]);
    if (maskIdx.some((m) => m >= 0)) {
      out.maskIdx = maskIdx;
      out.masks = r.masks;
    }
  }
  return { stream: out, hidden: r.hidden, warnings: r.warnings };
}
