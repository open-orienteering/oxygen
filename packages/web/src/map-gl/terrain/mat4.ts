/**
 * Column-major 4 × 4 matrices in float64 (docs/map-rendering.md §5.6
 * "Camera"): the camera is composed here and converted to float32 once,
 * for the `u_view` upload, as `view.ts` does for the 2D view.
 */

export type Mat4 = Float64Array;
export type Vec3 = readonly [number, number, number];

export function identity(): Mat4 {
  const m = new Float64Array(16);
  m[0] = m[5] = m[10] = m[15] = 1;
  return m;
}

/** a · b (b applied first). */
export function multiply(a: ArrayLike<number>, b: ArrayLike<number>): Mat4 {
  const m = new Float64Array(16);
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
      m[c * 4 + r] = s;
    }
  return m;
}

/**
 * OpenGL perspective: camera space (x right, y up, looking down −z) → clip,
 * depth −1 at `near`, +1 at `far`.
 */
export function perspective(fovYRad: number, aspect: number, near: number, far: number): Mat4 {
  const f = 1 / Math.tan(fovYRad / 2);
  const m = new Float64Array(16);
  m[0] = f / aspect;
  m[5] = f;
  m[10] = (far + near) / (near - far);
  m[11] = -1;
  m[14] = (2 * far * near) / (near - far);
  return m;
}

/** World → camera space for a camera at `eye` with orthonormal right `r`, up `u` and forward `f`. */
export function cameraBasis(eye: Vec3, r: Vec3, u: Vec3, f: Vec3): Mat4 {
  const m = new Float64Array(16);
  m[0] = r[0]; m[4] = r[1]; m[8] = r[2];
  m[1] = u[0]; m[5] = u[1]; m[9] = u[2];
  m[2] = -f[0]; m[6] = -f[1]; m[10] = -f[2];
  m[12] = -(r[0] * eye[0] + r[1] * eye[1] + r[2] * eye[2]);
  m[13] = -(u[0] * eye[0] + u[1] * eye[1] + u[2] * eye[2]);
  m[14] = f[0] * eye[0] + f[1] * eye[1] + f[2] * eye[2];
  m[15] = 1;
  return m;
}

/** m · (x, y, z, 1) → (x, y, z, w). */
export function transform(m: ArrayLike<number>, x: number, y: number, z: number): [number, number, number, number] {
  return [
    m[0] * x + m[4] * y + m[8] * z + m[12],
    m[1] * x + m[5] * y + m[9] * z + m[13],
    m[2] * x + m[6] * y + m[10] * z + m[14],
    m[3] * x + m[7] * y + m[11] * z + m[15],
  ];
}

/** The inverse of m, or null when it is singular. */
export function invert(m: ArrayLike<number>): Mat4 | null {
  const a = Array.from(m);
  const inv = identity();
  for (let col = 0; col < 4; col++) {
    let piv = col;
    for (let r = col + 1; r < 4; r++) if (Math.abs(a[col * 4 + r]) > Math.abs(a[col * 4 + piv])) piv = r;
    if (Math.abs(a[col * 4 + piv]) < 1e-300) return null;
    if (piv !== col)
      for (let c = 0; c < 4; c++) {
        [a[c * 4 + col], a[c * 4 + piv]] = [a[c * 4 + piv], a[c * 4 + col]];
        [inv[c * 4 + col], inv[c * 4 + piv]] = [inv[c * 4 + piv], inv[c * 4 + col]];
      }
    const d = a[col * 4 + col];
    for (let c = 0; c < 4; c++) {
      a[c * 4 + col] /= d;
      inv[c * 4 + col] /= d;
    }
    for (let r = 0; r < 4; r++) {
      if (r === col) continue;
      const k = a[col * 4 + r];
      if (k === 0) continue;
      for (let c = 0; c < 4; c++) {
        a[c * 4 + r] -= k * a[c * 4 + col];
        inv[c * 4 + r] -= k * inv[c * 4 + col];
      }
    }
  }
  return inv;
}
