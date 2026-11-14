/**
 * Ray ↔ terrain (docs/map-rendering.md §5.6 "Pick"): the first point where
 * a model-space ray meets the level-0 surface — the triangles the mesh
 * draws at full detail, no-data cells at their filled heights. A CPU march,
 * so it runs in tests and the viewer's gestures (H7) and lines (H8)
 * without reading the depth buffer.
 */

import { HEIGHT_NO_DATA, fieldCell, type HeightField } from "@oxygen/shared/src/terrain/field/read.js";
import type { Ray } from "./camera.js";
import type { TerrainMesh } from "./mesh.js";

export interface TerrainHit {
  /** Paper mm. */
  x: number;
  y: number;
  /** Model µm of the hit (x, y relative to the mesh's origin). */
  model: [number, number, number];
  /** Metres, from the drawn surface (exaggeration removed). */
  heightM: number;
  /** False on a filled no-data cell (the sheet's margin, outside the mapped area). */
  data: boolean;
  /** Distance along the ray, model µm. */
  t: number;
}

/**
 * Model z of the level-0 surface at model (x, y), or null outside the
 * outer cell centres. Each quad (a, b, c, d) counter-clockwise from its
 * lower-left is the triangles (a, b, c) and (a, c, d), as `chunkGeometry`
 * draws it.
 */
export function surfaceZ(mesh: TerrainMesh, x: number, y: number, exaggeration: number): number | null {
  const W = mesh.width, H = mesh.height;
  if (W < 2 || H < 2) return null;
  const gx = (x - mesh.x0Um) / mesh.cellUm, gy = (y - mesh.y0Um) / mesh.cellUm;
  if (!(gx >= 0 && gy >= 0 && gx <= W - 1 && gy <= H - 1)) return null;
  const ix = Math.min(Math.floor(gx), W - 2), iy = Math.min(Math.floor(gy), H - 2);
  const fx = gx - ix, fy = gy - iy, h = mesh.heights, i = iy * W + ix;
  const za = h[i], zb = h[i + 1], zc = h[i + W + 1], zd = h[i + W];
  const z = fx >= fy ? za + fx * (zb - za) + fy * (zc - zb) : za + fy * (zd - za) + fx * (zc - zd);
  return (z - mesh.zMin) * mesh.unitUm * exaggeration;
}

/** The first hit of the ray on the surface, or null. */
export function pickTerrain(mesh: TerrainMesh, field: HeightField, ray: Ray, exaggeration: number): TerrainHit | null {
  const W = mesh.width, H = mesh.height;
  if (W < 2 || H < 2) return null;
  const [ox, oy, oz] = ray.origin, [dx, dy, dz] = ray.dir;
  const zTop = (mesh.zMax - mesh.zMin) * mesh.unitUm * exaggeration;
  // slab clip to the surface's box
  let t0 = 0, t1 = Infinity;
  const slab = (o: number, d: number, lo: number, hi: number) => {
    if (Math.abs(d) < 1e-15) return o >= lo && o <= hi;
    let a = (lo - o) / d, b = (hi - o) / d;
    if (a > b) [a, b] = [b, a];
    t0 = Math.max(t0, a);
    t1 = Math.min(t1, b);
    return t0 <= t1;
  };
  const slack = mesh.cellUm * 1e-6;
  if (
    !slab(ox, dx, mesh.x0Um, mesh.x0Um + (W - 1) * mesh.cellUm) ||
    !slab(oy, dy, mesh.y0Um, mesh.y0Um + (H - 1) * mesh.cellUm) ||
    !slab(oz, dz, -slack, zTop + slack)
  )
    return null;
  const above = (t: number) => {
    const s = surfaceZ(mesh, ox + dx * t, oy + dy * t, exaggeration);
    return s === null ? null : oz + dz * t - s;
  };
  // half a cell in plan per step; one step when the ray is vertical
  const dxy = Math.hypot(dx, dy);
  const step = dxy > 1e-12 ? mesh.cellUm / 2 / dxy : t1 - t0;
  let prev = t0;
  const g = above(t0);
  let hitT: number | null = null;
  if (g !== null && g <= 0) hitT = t0;
  for (let t = t0; hitT === null && t < t1; ) {
    const next = Math.min(t + step, t1);
    const gn = above(next);
    if (gn !== null && gn <= 0) {
      let lo = prev, hi = next;
      for (let k = 0; k < 60; k++) {
        const mid = (lo + hi) / 2, gm = above(mid);
        if (gm !== null && gm <= 0) hi = mid;
        else lo = mid;
      }
      hitT = hi;
    }
    prev = next;
    t = next;
    if (next === t1) break;
  }
  if (hitT === null) return null;
  const mx = ox + dx * hitT, my = oy + dy * hitT, mz = surfaceZ(mesh, mx, my, exaggeration) ?? oz + dz * hitT;
  const x = (mx + mesh.originUm.x) / 1000, y = (my + mesh.originUm.y) / 1000;
  const cell = fieldCell(field, { x, y });
  return {
    x,
    y,
    model: [mx, my, mz],
    heightM: (mz / (mesh.unitUm * exaggeration)) * field.header.zScaleM + mesh.zBaseM,
    data: cell >= 0 && field.z[cell] !== HEIGHT_NO_DATA,
    t: hitT,
  };
}
