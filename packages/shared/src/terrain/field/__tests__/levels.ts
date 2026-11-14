import { buildContourGraph, cellIndex, type ContourGraph } from "../../graph/index.js";
import { mapped, syntheticDoc, type Obj } from "../../graph/__tests__/synthetic.js";
import type { FieldLevels } from "../index.js";

export function graphOf(objects: Obj[], area?: [number, number, number, number], mapScale = 15000): ContourGraph {
  const g = buildContourGraph(syntheticDoc(mapped(objects, area), mapScale));
  if (!g) throw new Error("no graph");
  return g;
}

export const regionAt = (g: ContourGraph, x: number, y: number): number => {
  const r = g.raster.labels[cellIndex(g.raster, x, y)];
  if (!(r > 0)) throw new Error(`no region at ${x}, ${y}`);
  return r;
};

/**
 * Hand-written levels standing in for the solve (§3): the region at each
 * point gets its level, every other region 0; each chain's side follows
 * from the levels of its first pair (0 when they are equal).
 */
export function levelsAt(g: ContourGraph, points: [x: number, y: number, level: number][]): FieldLevels {
  const NR = g.raster.regionCount + 1, NC = g.chains.length;
  const regionLevel = new Int32Array(NR);
  for (const [x, y, l] of points) regionLevel[regionAt(g, x, y)] = l;
  const side = new Int8Array(NC);
  g.pairs.forEach((ps, c) => {
    const p = ps[0];
    if (p) side[c] = Math.sign(regionLevel[p.left] - regionLevel[p.right]);
  });
  return { regionLevel, regionWeak: new Uint8Array(NR), side, flagged: new Uint8Array(NC), conflict: new Float32Array(NC) };
}
