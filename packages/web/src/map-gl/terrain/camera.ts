/**
 * The terrain's perspective orbit camera (docs/map-rendering.md §5.6
 * "Camera"; research 10 §5 step 2, §6 point 1): a target point, a distance,
 * a bearing and a pitch → one column-major model → clip `mat4`, composed in
 * float64. Model space is the arenas' (§5.2 "Projection"): origin-relative
 * paper µm, y up, and z up in the same µm (§5.6 "Units").
 *
 * At pitch 0 the camera looks straight down and, at
 * `distanceUm = focalPx / pxPerUm`, draws the target's z plane exactly as
 * the 2D `viewMatrix` with `rotationDeg = bearingDeg` does — the 2D ↔ 3D
 * hand-over.
 */

import { cameraBasis, multiply, perspective, transform, type Mat4, type Vec3 } from "./mat4.js";

export const DEFAULT_FOV_Y_DEG = 35;
export const MAX_PITCH_DEG = 85;

export interface TerrainCamera {
  /** The orbit centre, model µm. */
  target: { x: number; y: number; z: number };
  /** Eye to target, model µm. */
  distanceUm: number;
  /** Turns the view as `View.rotationDeg` does: counter-clockwise on screen. */
  bearingDeg: number;
  /** 0 = straight down (the 2D view), clamped to [0, `MAX_PITCH_DEG`]. */
  pitchDeg: number;
  /** Vertical field of view (default `DEFAULT_FOV_Y_DEG`). */
  fovYDeg?: number;
  widthPx: number;
  heightPx: number;
}

/** An axis-aligned box in model µm. */
export interface Box3 {
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
}

export interface CameraFrame {
  eye: Vec3;
  /** Unit right, up and forward of the camera, model space. */
  right: Vec3;
  up: Vec3;
  forward: Vec3;
  focalPx: number;
  near: number;
  far: number;
  /** Model → clip, float64. */
  matrix: Mat4;
}

const RAD = Math.PI / 180;
const clampPitch = (p: number) => Math.min(Math.max(p, 0), MAX_PITCH_DEG);

/** Pixels per unit of tan(angle) off the axis: `(heightPx / 2) / tan(fovY / 2)`. */
export function focalPx(cam: Pick<TerrainCamera, "heightPx" | "fovYDeg">): number {
  return cam.heightPx / 2 / Math.tan(((cam.fovYDeg ?? DEFAULT_FOV_Y_DEG) * RAD) / 2);
}

/** The distance at which the target's plane is drawn at `pxPerUm` (the 2D view's scale) at pitch 0. */
export function distanceForPxPerUm(cam: Pick<TerrainCamera, "heightPx" | "fovYDeg">, pxPerUm: number): number {
  return focalPx(cam) / pxPerUm;
}

/**
 * The camera's eye, basis, clip planes and matrix. Near and far are the
 * smallest and largest depth along the view direction over `bounds` (the
 * drawn field) when given — not Euclidean distance, which would put an
 * off-axis point in front of the near plane — near at `NEAR_HEADROOM` of the
 * smallest, and ≥ far / 10⁴ for a
 * 24-bit depth buffer; otherwise they are 1 % and 100× the distance.
 */
/**
 * Near is this share of the box's smallest depth: lines are drawn above the surface (raised by
 * their screen half width, then biased towards the eye — §5.6 "Lines", H8), up to a few per cent of
 * the distance nearer than the box's top, and must stay in front of the near plane.
 */
export const NEAR_HEADROOM = 0.8;

export function cameraFrame(cam: TerrainCamera, bounds?: Box3): CameraFrame {
  const b = cam.bearingDeg * RAD, p = clampPitch(cam.pitchDeg) * RAD;
  // Screen-up on the ground at pitch 0: (0, 1) turned by −bearing.
  const gx = Math.sin(b), gy = Math.cos(b);
  const sp = Math.sin(p), cp = Math.cos(p);
  const forward: Vec3 = [sp * gx, sp * gy, -cp];
  const up: Vec3 = [cp * gx, cp * gy, sp];
  // right = forward × up
  const right: Vec3 = [
    forward[1] * up[2] - forward[2] * up[1],
    forward[2] * up[0] - forward[0] * up[2],
    forward[0] * up[1] - forward[1] * up[0],
  ];
  const d = cam.distanceUm, t = cam.target;
  const eye: Vec3 = [t.x - forward[0] * d, t.y - forward[1] * d, t.z - forward[2] * d];
  let near = d * 0.01, far = d * 100;
  if (bounds) {
    // depth along the view direction: linear, so its extremes over the box are at corners
    let lo = Infinity, hi = -Infinity;
    for (const x of [bounds.minX, bounds.maxX])
      for (const y of [bounds.minY, bounds.maxY])
        for (const z of [bounds.minZ, bounds.maxZ]) {
          const depth = (x - eye[0]) * forward[0] + (y - eye[1]) * forward[1] + (z - eye[2]) * forward[2];
          lo = Math.min(lo, depth);
          hi = Math.max(hi, depth);
        }
    far = hi > 0 ? hi * 1.01 : d * 100;
    near = Math.max(lo * NEAR_HEADROOM, far / 1e4);
    if (!(far > near)) far = near * 2;
  }
  const fov = (cam.fovYDeg ?? DEFAULT_FOV_Y_DEG) * RAD;
  const matrix = multiply(perspective(fov, cam.widthPx / cam.heightPx, near, far), cameraBasis(eye, right, up, forward));
  return { eye, right, up, forward, focalPx: focalPx(cam), near, far, matrix };
}

/** The camera's model → clip matrix as the float32 `u_view` uniform. */
export function terrainCamera(cam: TerrainCamera, bounds?: Box3): Float32Array {
  return new Float32Array(cameraFrame(cam, bounds).matrix);
}

/** Squared distance from p to the nearest point of the box (0 inside). */
export function boxDistanceSq(bx: Box3, p: Vec3): number {
  const axis = (v: number, lo: number, hi: number) => (v < lo ? lo - v : v > hi ? v - hi : 0);
  const dx = axis(p[0], bx.minX, bx.maxX), dy = axis(p[1], bx.minY, bx.maxY), dz = axis(p[2], bx.minZ, bx.maxZ);
  return dx * dx + dy * dy + dz * dz;
}

export interface Ray {
  origin: Vec3;
  /** Unit direction. */
  dir: Vec3;
}

/** The ray through canvas pixel (px, py) — CSS-style, y down from the top-left — from the eye. */
export function screenRay(cam: TerrainCamera, px: number, py: number): Ray {
  const f = cameraFrame(cam);
  const sx = (px - cam.widthPx / 2) / f.focalPx, sy = (cam.heightPx / 2 - py) / f.focalPx;
  const d: [number, number, number] = [0, 0, 0];
  for (let i = 0; i < 3; i++) d[i] = f.forward[i] + f.right[i] * sx + f.up[i] * sy;
  const len = Math.hypot(d[0], d[1], d[2]);
  return { origin: f.eye, dir: [d[0] / len, d[1] / len, d[2] / len] };
}

/** Model point → canvas pixel (y down), or null behind the eye. */
export function projectToScreen(m: ArrayLike<number>, widthPx: number, heightPx: number, x: number, y: number, z: number): [number, number] | null {
  const [cx, cy, , w] = transform(m, x, y, z);
  if (w <= 0) return null;
  return [((cx / w + 1) / 2) * widthPx, ((1 - cy / w) / 2) * heightPx];
}
