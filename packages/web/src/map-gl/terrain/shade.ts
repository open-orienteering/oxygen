/**
 * Relief shading (docs/map-rendering.md §5.6 "Shading", decided with the
 * user 2026-11-14): flat ground is exactly 1, slopes away from the light
 * darken and slopes towards it brighten, the light from the north-west
 * 45° up, fixed in paper space. The GLSL in `program.ts` is built from the
 * constants here and mirrors `shade` line for line.
 */

/** Unit direction to the light, paper space (x right, y up, z up). */
export const LIGHT: readonly [number, number, number] = [-0.5, 0.5, Math.SQRT1_2];
export const SHADE_MIN = 0.4;
export const SHADE_MAX = 1.25;

/** The normal at exaggeration e from the normal at 1: `normalize(n.xy · e, n.z)` (= `heightNormals(field, e)`). */
export function exaggerateNormal(n: readonly [number, number, number], e: number): [number, number, number] {
  const x = n[0] * e, y = n[1] * e, z = n[2], len = Math.hypot(x, y, z) || 1;
  return [x / len, y / len, z / len];
}

/** `clamp(max(0, n·l) / l.z, SHADE_MIN, SHADE_MAX)` for the normal at 1 drawn at exaggeration e. */
export function shade(n: readonly [number, number, number], e = 1): number {
  const m = exaggerateNormal(n, e);
  const s = Math.max(0, m[0] * LIGHT[0] + m[1] * LIGHT[1] + m[2] * LIGHT[2]) / LIGHT[2];
  return Math.min(Math.max(s, SHADE_MIN), SHADE_MAX);
}

/** The drawn colour: `min(1, colour · shade)` per channel, no tint. */
export function shadeColour(rgb: readonly [number, number, number], s: number): [number, number, number] {
  return [Math.min(1, rgb[0] * s), Math.min(1, rgb[1] * s), Math.min(1, rgb[2] * s)];
}

const glslFloat = (v: number) => (Number.isInteger(v) ? `${v}.0` : `${v}`);

/** The GLSL of `shade` with its constants. */
export const SHADE_GLSL = `
const vec3 LIGHT = vec3(${LIGHT.map(glslFloat).join(", ")});
float shade(vec3 n, float e) {
  vec3 m = normalize(vec3(n.xy * e, n.z));
  return clamp(max(0.0, dot(m, LIGHT)) / LIGHT.z, ${glslFloat(SHADE_MIN)}, ${glslFloat(SHADE_MAX)});
}
`;
