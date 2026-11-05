/**
 * Hit-testing on the symbolised shape (docs/map-rendering.md §5.5;
 * research 04 §7): which objects of a pass stream are under a paper
 * point. A shared-stage function, not a GPU feature — the editor and the
 * tests ask the same question of the same stream.
 *
 * - fills (and hatches): even-odd point in polygon;
 * - strokes: distance to the flattened centre line ≤ half the width;
 *   with `closedStrokeInterior` a closed stroke's inside counts too
 *   (a control circle is grabbed by its interior, not only its ring);
 * - glyphs: a disc of the mesh radius × instance scale per instance;
 * - text: a box per glyph, 0.65 em wide (the course layer's own estimate,
 *   course-layer.md §3.5), from 0.2 em below the baseline to 0.8 em above.
 *
 * All within `toleranceUm` (the caller's screen tolerance converted to
 * paper). Hits are ordered topmost first: backends draw the stream front
 * to back (§3.6), so a later pass is on top of an earlier one.
 */

import { flattenRings, pointInRings, type FlatRing } from "./geometry.js";
import type { Pass, PassStream } from "./pass-stream.js";
import { pathBounds } from "./path.js";

export interface HitOptions {
  /** Extra reach around every shape, paper µm. */
  toleranceUm: number;
  /** Only these objects (default: every object). */
  objects?: (objectIdx: number) => boolean;
  /** A closed stroke hits over its whole interior. */
  closedStrokeInterior?: boolean;
}

export interface Hit {
  objectIdx: number;
  /** Index of the topmost pass of the object that hit. */
  passIdx: number;
  /** From the point to the drawn shape, µm; 0 on or inside it. */
  distanceUm: number;
}

/** Flattening tolerance for hit geometry, µm (well under a screen pixel at editing zooms). */
export const HIT_FLATTEN_UM = 10;

const TEXT_ADVANCE_EM = 0.65;

function distToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function distToRings(rings: FlatRing[], closed: boolean, x: number, y: number): number {
  let best = Infinity;
  for (const r of rings) {
    const n = r.length / 2;
    if (n === 1) best = Math.min(best, Math.hypot(x - r[0], y - r[1]));
    for (let i = 0; i + 1 < n; i++) best = Math.min(best, distToSegment(x, y, r[2 * i], r[2 * i + 1], r[2 * i + 2], r[2 * i + 3]));
    if (closed && n > 2) best = Math.min(best, distToSegment(x, y, r[2 * n - 2], r[2 * n - 1], r[0], r[1]));
  }
  return best;
}

function glyphRadius(stream: PassStream, glyphId: number, cache: Map<number, number>): number {
  const known = cache.get(glyphId);
  if (known !== undefined) return known;
  let r = 0;
  for (const m of stream.glyphTable) {
    if (m.glyphId !== glyphId) continue;
    for (const f of m.fills) {
      const b = pathBounds(f);
      r = Math.max(r, Math.abs(b.minX), Math.abs(b.maxX), Math.abs(b.minY), Math.abs(b.maxY));
    }
    for (const s of m.strokes) {
      const b = pathBounds(s.path);
      r = Math.max(r, Math.max(Math.abs(b.minX), Math.abs(b.maxX), Math.abs(b.minY), Math.abs(b.maxY)) + s.widthUm / 2);
    }
  }
  cache.set(glyphId, r);
  return r;
}

/** Distance from (x, y) to what the pass draws (0 inside), µm; Infinity when it cannot reach. */
function passDistance(stream: PassStream, p: Pass, x: number, y: number, opts: HitOptions, radii: Map<number, number>): number {
  const reach = opts.toleranceUm;
  switch (p.kind) {
    case "fill":
    case "hatch": {
      const b = pathBounds(p.path);
      if (x < b.minX - reach || x > b.maxX + reach || y < b.minY - reach || y > b.maxY + reach) return Infinity;
      const rings = flattenRings({ ...p.path, closed: true }, HIT_FLATTEN_UM).filter((r) => r.length >= 6);
      if (pointInRings(rings, x, y)) return 0;
      return distToRings(rings, true, x, y);
    }
    case "stroke": {
      const half = p.widthUm / 2;
      const b = pathBounds(p.path);
      if (x < b.minX - half - reach || x > b.maxX + half + reach || y < b.minY - half - reach || y > b.maxY + half + reach) return Infinity;
      const rings = flattenRings(p.path, HIT_FLATTEN_UM).filter((r) => r.length >= 2);
      if (opts.closedStrokeInterior && p.path.closed && pointInRings(rings.filter((r) => r.length >= 6), x, y)) return 0;
      return Math.max(0, distToRings(rings, p.path.closed, x, y) - half);
    }
    case "glyph": {
      if (p.clip) return passDistance(stream, { kind: "fill", colour: p.colour, path: p.clip, rule: "evenodd" }, x, y, opts, radii);
      const r = glyphRadius(stream, p.glyphId, radii);
      let best = Infinity;
      for (let i = 0; i < p.instances.length; i += 5) {
        best = Math.min(best, Math.max(0, Math.hypot(x - p.instances[i], y - p.instances[i + 1]) - r * p.instances[i + 4]));
      }
      return best;
    }
    case "text": {
      const em = p.sizeUm + (p.haloWidthUm ?? 0);
      let best = Infinity;
      for (let i = 0; i < p.positions.length; i += 2) {
        const gx = p.positions[i], gy = p.positions[i + 1];
        const dx = Math.max(gx - x, 0, x - (gx + TEXT_ADVANCE_EM * em));
        const dy = Math.max(gy - 0.2 * em - y, 0, y - (gy + 0.8 * em));
        best = Math.min(best, Math.hypot(dx, dy));
      }
      return best;
    }
  }
}

/** The objects under (x, y) (paper µm), topmost first, one hit per object. */
export function hitTest(stream: PassStream, x: number, y: number, opts: HitOptions): Hit[] {
  const radii = new Map<number, number>();
  const seen = new Set<number>();
  const hits: Hit[] = [];
  for (let i = stream.passes.length - 1; i >= 0; i--) {
    const obj = stream.objectIdx[i];
    if (seen.has(obj) || (opts.objects && !opts.objects(obj))) continue;
    const d = passDistance(stream, stream.passes[i], x, y, opts, radii);
    if (d <= opts.toleranceUm) {
      seen.add(obj);
      hits.push({ objectIdx: obj, passIdx: i, distanceUm: d });
    }
  }
  return hits;
}
