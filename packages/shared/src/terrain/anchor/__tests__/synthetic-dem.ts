/**
 * Synthetic DEMs and chains for the anchor tests (docs/map-terrain.md §6).
 * Paper mm in, metres out; `g` is ground metres per paper mm.
 */

import type { DemSampler } from "../types.js";

/** A cone: `top` metres at (cx, cy), falling `slope` metres per ground metre. */
export const cone = (cx: number, cy: number, top: number, slope: number, g: number): DemSampler => (x, y) => top - slope * Math.hypot(x - cx, y - cy) * g;

/** A pit: `bottom` at (cx, cy), rising `slope` per ground metre. */
export const pit = (cx: number, cy: number, bottom: number, slope: number, g: number): DemSampler => (x, y) => bottom + slope * Math.hypot(x - cx, y - cy) * g;

/** A plane rising `slope` metres per ground metre along +x. */
export const planeX = (slope: number, g: number, base = 0): DemSampler => (x) => base + slope * x * g;

/** A closed ring, counter-clockwise, as a flat coordinate list (no repeated first point). */
export function ring(cx: number, cy: number, r: number, n = 96): Float64Array {
  const p = new Float64Array(n * 2);
  for (let i = 0; i < n; i++) {
    const a = (2 * Math.PI * i) / n;
    p[i * 2] = cx + r * Math.cos(a);
    p[i * 2 + 1] = cy + r * Math.sin(a);
  }
  return p;
}

/** A straight polyline from (x1, y1) to (x2, y2). */
export const line = (x1: number, y1: number, x2: number, y2: number): Float64Array => new Float64Array([x1, y1, x2, y2]);

/** A deterministic pseudo-random sequence in [0, 1) (mulberry32). */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
