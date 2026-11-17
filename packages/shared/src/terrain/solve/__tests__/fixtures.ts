/**
 * Synthetic terrain for the solve tests (docs/map-terrain.md §3): the graph
 * fixture of `terrain/graph/__tests__/synthetic.ts` with helpers to find a
 * chain by the object that drew it.
 */

import type { MapDocument } from "../../../map-document/index.js";
import { buildContourGraph, type ContourGraph } from "../../graph/index.js";
import { S, line, mapped, ring, syntheticDoc, type Obj } from "../../graph/__tests__/synthetic.js";

export { S, line, mapped, ring, syntheticDoc, type Obj };

export interface Built {
  g: ContourGraph;
  d: MapDocument;
  /** Chain drawn by `objects[k]` (its first object). */
  chain: (k: number) => number;
}

export function build(objects: Obj[], area?: [number, number, number, number]): Built {
  const d = syntheticDoc(mapped(objects, area));
  const g = buildContourGraph(d);
  if (!g) throw new Error("no graph");
  // mapped() puts the area object first, so objects[k] is source k + 1
  const chain = (k: number) => {
    const i = g.chains.findIndex((c) => c.objects.some((o) => d.attrs.sourceIndex[o] === k + 1));
    if (i < 0) throw new Error(`no chain for object ${k}`);
    return i;
  };
  return { g, d, chain };
}

/** Rotation (0.1°) of a slope tick pointing along (dx, dy): the glyph's +y turned counter-clockwise. */
export const tickAngle = (dx: number, dy: number) => Math.round((Math.atan2(-dx, dy) * 1800) / Math.PI);

/** A slope tick at (x, y) pointing downhill along (dx, dy). */
export const tick = (x: number, y: number, dx: number, dy: number): Obj => ({ sym: S.tick, coords: [x, y], angleDeciDeg: tickAngle(dx, dy) });

/** An arc of a circle (centre, radius) from angle a0 to a1 (degrees, counter-clockwise), every ~1 mm. */
export function arc(cx: number, cy: number, r: number, a0: number, a1: number): number[] {
  const n = Math.max(8, Math.ceil(((Math.abs(a1 - a0) * Math.PI) / 180) * r));
  const out: number[] = [];
  for (let i = 0; i <= n; i++) {
    const a = ((a0 + ((a1 - a0) * i) / n) * Math.PI) / 180;
    out.push(+(cx + r * Math.cos(a)).toFixed(2), +(cy + r * Math.sin(a)).toFixed(2));
  }
  return out;
}

/** The region at (x, y). */
export function regionAt(g: ContourGraph, x: number, y: number): number {
  const r = g.raster;
  const cx = Math.floor((x - r.x0) / r.cellMm), cy = Math.floor((y - r.y0) / r.cellMm);
  return r.labels[cy * r.width + cx];
}
