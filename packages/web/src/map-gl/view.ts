/**
 * WebGL2 backend, the arena path's projection (docs/map-rendering.md §5.2
 * "Drawing"): one model → clip matrix per frame, built here in float64 and
 * uploaded as the `u_view` mat4. Positions in the arenas are relative to
 * the document origin, so the matrix is too.
 *
 * Today the matrix is the orthographic map view — centre, px/µm, rotation.
 * Any other camera (a perspective one for terrain draping) is another
 * matrix passed through `DocumentRenderOptions.viewMatrix`; the shaders do
 * not change.
 */

import type { ViewRect } from "./buckets.js";

/** Render target of a frame: a framebuffer (null = the canvas) and its size in device pixels. */
export interface RenderTarget {
  framebuffer: WebGLFramebuffer | null;
  width: number;
  height: number;
}

/**
 * Column-major model → clip matrix for an orthographic map view:
 * `clip = S · R(rotation) · (p − (centre − origin))`, with
 * `S = diag(2·pxPerUm / widthPx, 2·pxPerUm / heightPx)`. The translation is
 * computed in float64 so the float32 upload loses nothing that matters
 * (the positions it applies to are origin-relative).
 */
export function viewMatrix(view: ViewRect, originX: number, originY: number): Float32Array {
  const a = ((view.rotationDeg ?? 0) * Math.PI) / 180;
  const c = Math.cos(a), s = Math.sin(a);
  const sx = (2 * view.pxPerUm) / view.widthPx, sy = (2 * view.pxPerUm) / view.heightPx;
  const m0 = sx * c, m1 = sy * s, m4 = -sx * s, m5 = sy * c;
  const cx = view.centreX - originX, cy = view.centreY - originY;
  const m = new Float32Array(16);
  m[0] = m0; m[1] = m1;
  m[4] = m4; m[5] = m5;
  m[10] = 1;
  m[12] = -(m0 * cx + m4 * cy);
  m[13] = -(m1 * cx + m5 * cy);
  m[15] = 1;
  return m;
}

/** Applies a column-major mat4 to (x, y, 0, 1); returns clip (x, y, w). For tests. */
export function project(m: ArrayLike<number>, x: number, y: number): [number, number, number] {
  return [m[0] * x + m[4] * y + m[12], m[1] * x + m[5] * y + m[13], m[3] * x + m[7] * y + m[15]];
}
