/**
 * The drape's footprint and layers (docs/map-rendering.md §5.6
 * "Footprint", "Drape layers"; research 10 §5 step 1): what part of the
 * ground a terrain camera sees, and the orthographic 2D views the map is
 * rendered with to cover it.
 *
 * - `groundFootprint(cam, box)`: the frustum's side planes clip the drawn
 *   mesh's box (its xy extent × its height range at the exaggeration);
 *   the xy hull of what is left is every plan point whose surface the
 *   camera can see, whatever the heights inside the box. Clipping the box
 *   rather than the z = 0 plane covers a hilltop seen beyond the flat
 *   ground and bounds the footprint at the horizon.
 * - `drapeLayers(cam, box, limits)`: the footprint's bounding rectangle in
 *   the camera's bearing frame, grown by `DRAPE_MARGIN`, as a `ViewRect`
 *   with `rotationDeg = bearingDeg`; its density is what the nearest
 *   footprint point needs (`focalPx / depth`, depth on the target's z
 *   plane: exactly the 2D `pxPerUm` at pitch 0), lowered to fit the
 *   limits. Where the cap leaves the far layer below `DRAPE_NEAR_RATIO`
 *   of what the screen needs, a near layer covers that part (decision 3).
 * - `drapeTiles(view, tile)`: sub-views partitioning a layer's texture,
 *   each drawn through the renderer's tile-sized MSAA target.
 *
 * Model space is the arenas' (origin-relative µm); the views are paper µm.
 */

import type { ViewRect } from "../buckets.js";
import { DEFAULT_FOV_Y_DEG, cameraFrame, type Box3, type TerrainCamera } from "./camera.js";
import type { Vec3 } from "./mat4.js";

/** Growth of a layer's rectangle per side, as a share of its extent: small moves stay covered. */
export const DRAPE_MARGIN = 0.05;
/** A near layer is added where the far layer's density is below this share of the screen's need. */
export const DRAPE_NEAR_RATIO = 0.7;
/** Texels per side of a drape layer (decision 5); lowered to `MAX_TEXTURE_SIZE` where smaller. */
export const DRAPE_MAX_SIDE = 4096;
/** Side of the MSAA target a layer is rendered through, tile by tile. */
export const DRAPE_TILE = 1024;
/** Bytes per drape texel: RGBA8 with its mip chain. */
export const DRAPE_TEXEL_BYTES = 4 * (4 / 3);

export type Pt = [number, number];

export interface DrapeLimits {
  /** Texels per side. */
  maxSide: number;
  /** Texels over all layers. */
  maxPixels: number;
}

export interface DrapeLayer {
  role: "near" | "far";
  /** Paper µm; `rotationDeg` = the camera's bearing. */
  view: ViewRect;
  /** Device px per µm the screen needs at the layer's nearest footprint point. */
  needPxPerUm: number;
}

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** Clips a convex polygon (3D) to `f(p) ≥ 0` (Sutherland–Hodgman). */
function clip3(poly: Vec3[], f: (p: Vec3) => number): Vec3[] {
  const out: Vec3[] = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const fa = f(a), fb = f(b);
    if (fa >= 0) out.push(a);
    if ((fa >= 0) !== (fb >= 0)) {
      const t = fa / (fa - fb);
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]);
    }
  }
  return out;
}

/** Clips a convex polygon (2D) to `f(p) ≥ 0`. */
function clip2(poly: Pt[], f: (p: Pt) => number): Pt[] {
  return clip3(poly.map(([x, y]) => [x, y, 0] as Vec3), (p) => f([p[0], p[1]])).map((p) => [p[0], p[1]]);
}

/** Convex hull, counter-clockwise (monotone chain); collinear points dropped. */
export function convexHull(points: readonly Pt[]): Pt[] {
  const p = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const cross = (o: Pt, a: Pt, b: Pt) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: Pt[] = [], upper: Pt[] = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop();
    lower.push(q);
  }
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop();
    upper.push(q);
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

/** The four side planes of the camera's frustum as `n · (p − eye) ≥ 0`, inside. */
function frustumPlanes(cam: TerrainCamera): { eye: Vec3; normals: Vec3[] } {
  const f = cameraFrame(cam);
  const tanY = Math.tan(((cam.fovYDeg ?? DEFAULT_FOV_Y_DEG) * Math.PI) / 360);
  const tanX = (tanY * cam.widthPx) / cam.heightPx;
  const n = (k: number, a: Vec3, s: number): Vec3 => [k * f.forward[0] + s * a[0], k * f.forward[1] + s * a[1], k * f.forward[2] + s * a[2]];
  return { eye: f.eye, normals: [n(tanX, f.right, -1), n(tanX, f.right, 1), n(tanY, f.up, -1), n(tanY, f.up, 1)] };
}

/**
 * The plan footprint of what the camera sees of `box`: a convex polygon,
 * counter-clockwise, model µm; empty when the frustum misses the box.
 */
export function groundFootprint(cam: TerrainCamera, box: Box3): Pt[] {
  const { eye, normals } = frustumPlanes(cam);
  const X = [box.minX, box.maxX], Y = [box.minY, box.maxY], Z = [box.minZ, box.maxZ];
  const c = (i: number, j: number, k: number): Vec3 => [X[i], Y[j], Z[k]];
  const faces: Vec3[][] = [
    [c(0, 0, 0), c(1, 0, 0), c(1, 1, 0), c(0, 1, 0)],
    [c(0, 0, 1), c(1, 0, 1), c(1, 1, 1), c(0, 1, 1)],
    [c(0, 0, 0), c(1, 0, 0), c(1, 0, 1), c(0, 0, 1)],
    [c(0, 1, 0), c(1, 1, 0), c(1, 1, 1), c(0, 1, 1)],
    [c(0, 0, 0), c(0, 1, 0), c(0, 1, 1), c(0, 0, 1)],
    [c(1, 0, 0), c(1, 1, 0), c(1, 1, 1), c(1, 0, 1)],
  ];
  const pts: Pt[] = [];
  for (let face of faces) {
    for (const n of normals) {
      face = clip3(face, (p) => dot(n, [p[0] - eye[0], p[1] - eye[1], p[2] - eye[2]]));
      if (!face.length) break;
    }
    for (const p of face) pts.push([p[0], p[1]]);
  }
  // The side planes meet only at the eye: inside the box it is a vertex of what is left.
  if (eye[0] >= box.minX && eye[0] <= box.maxX && eye[1] >= box.minY && eye[1] <= box.maxY && eye[2] >= box.minZ && eye[2] <= box.maxZ) pts.push([eye[0], eye[1]]);
  const hull = convexHull(pts);
  return hull.length >= 3 ? hull : [];
}

/** The camera's bearing frame: u along screen-right, v along screen-up at pitch 0, as `viewMatrix` turns. */
function bearingFrame(bearingDeg: number) {
  const a = (bearingDeg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  return {
    toUv: ([x, y]: Pt): Pt => [c * x - s * y, s * x + c * y],
    toXy: ([u, v]: Pt): Pt => [c * u + s * v, -s * u + c * v],
  };
}

interface UvRect {
  u0: number;
  u1: number;
  v0: number;
  v1: number;
}

/** A layer's view: the rectangle at the highest density ≤ `need` its texel limits allow. */
function layerView(r: UvRect, need: number, maxSide: number, maxPixels: number, bearingDeg: number, originUm: { x: number; y: number }, screen: { w: number; h: number }): ViewRect {
  const ew = Math.max(r.u1 - r.u0, 1), eh = Math.max(r.v1 - r.v0, 1);
  let rho = Math.min(need, (maxSide - 2) / ew, (maxSide - 2) / eh, Math.sqrt(Math.max(maxPixels, 1) / ((ew + 2 / need) * (eh + 2 / need))));
  // Sides of the screen's parity: at pitch 0 the texel centres then fall on the pixel centres.
  const side = (e: number, s: number) => {
    const n = Math.max(1, Math.ceil(e * rho));
    return (n - s) % 2 ? n + 1 : n;
  };
  let w = side(ew, screen.w), h = side(eh, screen.h);
  while (w * h > maxPixels && rho > 0) {
    rho *= 0.99;
    w = side(ew, screen.w);
    h = side(eh, screen.h);
  }
  const [cx, cy] = bearingFrame(bearingDeg).toXy([(r.u0 + r.u1) / 2, (r.v0 + r.v1) / 2]);
  return { centreX: cx + originUm.x, centreY: cy + originUm.y, pxPerUm: rho, widthPx: w, heightPx: h, rotationDeg: bearingDeg };
}

/**
 * The drape layers for a camera over the mesh's `box` (model µm, relative to
 * `originUm`), in priority order — the near layer first when there is one.
 * Empty when the camera sees none of the box.
 */
export function drapeLayers(cam: TerrainCamera, box: Box3, originUm: { x: number; y: number }, limits: DrapeLimits): DrapeLayer[] {
  const poly = groundFootprint(cam, box);
  if (!poly.length) return [];
  const f = cameraFrame(cam);
  const zt = cam.target.z;
  const depth = ([x, y]: Pt) => (x - f.eye[0]) * f.forward[0] + (y - f.eye[1]) * f.forward[1] + (zt - f.eye[2]) * f.forward[2];
  const floor = cam.distanceUm * 1e-3;
  const need = f.focalPx / Math.max(Math.min(...poly.map(depth)), floor);
  const frame = bearingFrame(cam.bearingDeg);
  const boxUv = [[box.minX, box.minY], [box.maxX, box.minY], [box.maxX, box.maxY], [box.minX, box.maxY]].map((p) => frame.toUv(p as Pt));
  const rectOf = (pts: Pt[]): UvRect => {
    const uv = pts.map(frame.toUv);
    const u0 = Math.min(...uv.map((p) => p[0])), u1 = Math.max(...uv.map((p) => p[0]));
    const v0 = Math.min(...uv.map((p) => p[1])), v1 = Math.max(...uv.map((p) => p[1]));
    const du = (u1 - u0) * DRAPE_MARGIN, dv = (v1 - v0) * DRAPE_MARGIN;
    return {
      u0: Math.max(u0 - du, Math.min(...boxUv.map((p) => p[0]))),
      u1: Math.min(u1 + du, Math.max(...boxUv.map((p) => p[0]))),
      v0: Math.max(v0 - dv, Math.min(...boxUv.map((p) => p[1]))),
      v1: Math.min(v1 + dv, Math.max(...boxUv.map((p) => p[1]))),
    };
  };
  const all = rectOf(poly);
  const make = (r: UvRect, pixels: number) => layerView(r, need, limits.maxSide, pixels, cam.bearingDeg, originUm, { w: cam.widthPx, h: cam.heightPx });
  const one = make(all, limits.maxPixels);
  if (one.pxPerUm >= DRAPE_NEAR_RATIO * need) return [{ role: "far", view: one, needPxPerUm: need }];
  // The cap bites: far takes half the texels, near the rest over the ground far is too coarse for.
  const far = make(all, limits.maxPixels / 2);
  const nearDepth = (DRAPE_NEAR_RATIO * f.focalPx) / far.pxPerUm;
  const nearPoly = clip2(poly, (p) => nearDepth - depth(p));
  if (nearPoly.length < 3) return [{ role: "far", view: one, needPxPerUm: need }];
  const near = make(rectOf(nearPoly), limits.maxPixels - far.widthPx * far.heightPx);
  // Two layers only pay when the near one is denser than one layer over everything (not at pitch 0).
  if (!(near.pxPerUm > one.pxPerUm * 1.05)) return [{ role: "far", view: one, needPxPerUm: need }];
  return [
    { role: "near", view: near, needPxPerUm: need },
    { role: "far", view: far, needPxPerUm: need },
  ];
}

export interface DrapeTile {
  /** The tile's lower-left texel in the layer's texture (GL rows: 0 at the bottom). */
  x: number;
  y: number;
  /** The tile's view: the layer's density and rotation, `widthPx × heightPx` texels. */
  view: ViewRect;
}

/** Sub-views partitioning a layer's `widthPx × heightPx` texels into tiles of at most `tile` per side. */
export function drapeTiles(view: ViewRect, tile = DRAPE_TILE): DrapeTile[] {
  const frame = bearingFrame(view.rotationDeg ?? 0);
  const out: DrapeTile[] = [];
  for (let y = 0; y < view.heightPx; y += tile)
    for (let x = 0; x < view.widthPx; x += tile) {
      const w = Math.min(tile, view.widthPx - x), h = Math.min(tile, view.heightPx - y);
      const du = (x + w / 2 - view.widthPx / 2) / view.pxPerUm, dv = (y + h / 2 - view.heightPx / 2) / view.pxPerUm;
      const [dx, dy] = frame.toXy([du, dv]);
      out.push({ x, y, view: { ...view, centreX: view.centreX + dx, centreY: view.centreY + dy, widthPx: w, heightPx: h } });
    }
  return out;
}

/** Texels of a set of layers' views. */
export const drapeTexels = (views: readonly ViewRect[]): number => views.reduce((n, v) => n + v.widthPx * v.heightPx, 0);
