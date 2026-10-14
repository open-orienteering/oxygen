/**
 * Area pattern grids (03 §6.9 item 4): instance positions for a pattern
 * symbol over an area, and the inclusion decision per clip mode.
 *
 * The grid is anchored at the paper origin (OCAD convention) rotated by
 * the pattern angle, so adjacent areas with the same symbol and angle
 * share one grid and hatch/dot continuously. Shifted rows move every odd
 * row by half a cell.
 */

import type { RenderPath } from "./pass-stream.js";
import { pathBounds } from "./path.js";
import { type FlatRing, flattenRings, pointInRings, ringsCrossQuad } from "./geometry.js";
import type { PatternSpec } from "./symbol.js";

export interface PatternInstance {
  x: number;
  y: number;
  angleDeg: number;
}

export interface PatternGridOptions {
  /** Object rotation (OCAD `ang`), degrees; applied when `rotate` allows. */
  objectAngleDeg?: number;
  /** Glyph extent in glyph-local µm (ink included) for the inclusion tests. */
  extent: { minX: number; minY: number; maxX: number; maxY: number };
  /** Flattening tolerance for the inclusion polygon, µm. */
  toleranceUm?: number;
}

export function patternAngle(spec: PatternSpec, objectAngleDeg = 0): number {
  switch (spec.rotate) {
    case "never":
      return spec.angleDeg;
    case "always":
    case "manual":
      return spec.angleDeg + objectAngleDeg;
  }
}

/**
 * Returns the instances to draw for one area and whether the pass needs a
 * clip path (`clip` mode).
 */
export function patternInstances(
  area: RenderPath,
  spec: PatternSpec,
  opts: PatternGridOptions,
): { instances: PatternInstance[]; clip: boolean } {
  const angle = patternAngle(spec, opts.objectAngleDeg);
  const rad = (angle * Math.PI) / 180;
  const c = Math.cos(rad), s = Math.sin(rad);
  const rings: FlatRing[] = flattenRings(area, opts.toleranceUm ?? 5);
  const b = pathBounds(area);
  const ex = opts.extent;
  const pad = Math.max(Math.abs(ex.minX), Math.abs(ex.maxX), Math.abs(ex.minY), Math.abs(ex.maxY));

  // Bounds of the area in grid space (rotate by −angle), padded by the glyph radius.
  const toGrid = (x: number, y: number): [number, number] => [x * c + y * s, -x * s + y * c];
  const corners = [toGrid(b.minX, b.minY), toGrid(b.maxX, b.minY), toGrid(b.minX, b.maxY), toGrid(b.maxX, b.maxY)];
  const gMinX = Math.min(...corners.map((p) => p[0])) - pad;
  const gMaxX = Math.max(...corners.map((p) => p[0])) + pad;
  const gMinY = Math.min(...corners.map((p) => p[1])) - pad;
  const gMaxY = Math.max(...corners.map((p) => p[1])) + pad;

  const W = spec.cellWidthUm, H = spec.cellHeightUm;
  const j0 = Math.floor((gMinY - spec.offsetYUm) / H), j1 = Math.ceil((gMaxY - spec.offsetYUm) / H);
  const instances: PatternInstance[] = [];
  const quad = (x: number, y: number): number[] => {
    const pts: number[] = [];
    for (const [gx, gy] of [[ex.minX, ex.minY], [ex.maxX, ex.minY], [ex.maxX, ex.maxY], [ex.minX, ex.maxY]]) {
      pts.push(x + gx * c - gy * s, y + gx * s + gy * c);
    }
    return pts;
  };
  const include = (x: number, y: number): boolean => {
    switch (spec.clip) {
      case "centreInside":
        return pointInRings(rings, x, y);
      case "completelyInside": {
        const q = quad(x, y);
        for (let k = 0; k < 4; k++) if (!pointInRings(rings, q[2 * k], q[2 * k + 1])) return false;
        return !ringsCrossQuad(rings, q);
      }
      case "partiallyInside": {
        if (pointInRings(rings, x, y)) return true;
        const q = quad(x, y);
        for (let k = 0; k < 4; k++) if (pointInRings(rings, q[2 * k], q[2 * k + 1])) return true;
        return ringsCrossQuad(rings, q);
      }
      case "clip": {
        // Anything whose ink can reach the area is drawn and clipped by the backend.
        if (pointInRings(rings, x, y)) return true;
        const q = quad(x, y);
        for (let k = 0; k < 4; k++) if (pointInRings(rings, q[2 * k], q[2 * k + 1])) return true;
        return ringsCrossQuad(rings, q);
      }
    }
  };

  for (let j = j0; j <= j1; j++) {
    const gy = spec.offsetYUm + j * H;
    const shift = spec.shiftedRows && ((j % 2) + 2) % 2 === 1 ? W / 2 : 0;
    const i0 = Math.floor((gMinX - spec.offsetXUm - shift) / W), i1 = Math.ceil((gMaxX - spec.offsetXUm - shift) / W);
    for (let i = i0; i <= i1; i++) {
      const gx = spec.offsetXUm + shift + i * W;
      const x = gx * c - gy * s, y = gx * s + gy * c;
      if (include(x, y)) instances.push({ x, y, angleDeg: angle });
    }
  }
  return { instances, clip: spec.clip === "clip" };
}
