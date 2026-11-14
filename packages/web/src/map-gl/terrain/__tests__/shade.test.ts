import { describe, expect, it } from "vitest";
import { heightNormals } from "@oxygen/shared/src/terrain/field/read.js";
import { LIGHT, SHADE_GLSL, SHADE_MAX, SHADE_MIN, exaggerateNormal, shade, shadeColour } from "../shade";
import { coneField } from "../synthetic";

/** The outward normal of a slope rising at tan θ = g, facing horizontal unit (ux, uy). */
const slope = (g: number, ux: number, uy: number): [number, number, number] => {
  const len = Math.hypot(g, 1);
  return [(g * ux) / len, (g * uy) / len, 1 / len];
};
const NW = [-Math.SQRT1_2, Math.SQRT1_2] as const;

describe("shade (map-rendering.md §5.6, decided 2026-11-14)", () => {
  it("is exactly 1 on flat ground", () => {
    expect(shade([0, 0, 1])).toBe(1);
    expect(shade([0, 0, 1], 5)).toBe(1);
    expect(Math.hypot(...LIGHT)).toBeCloseTo(1, 12);
  });

  it("gives sin θ + cos θ facing the light and cos θ − sin θ away from it", () => {
    const g = 0.25, th = Math.atan(g);
    expect(shade(slope(g, NW[0], NW[1]))).toBeCloseTo(Math.sin(th) + Math.cos(th), 12);
    expect(shade(slope(g, -NW[0], -NW[1]))).toBeCloseTo(Math.cos(th) - Math.sin(th), 12);
    // across the light: n·l = l.z · cos θ
    expect(shade(slope(g, Math.SQRT1_2, Math.SQRT1_2))).toBeCloseTo(Math.cos(th), 12);
  });

  it("clamps to [0.4, 1.25]", () => {
    expect(shade(slope(1, NW[0], NW[1]))).toBe(SHADE_MAX);
    expect(shade(slope(3, -NW[0], -NW[1]))).toBe(SHADE_MIN);
  });

  it("applies exaggeration as heightNormals(field, e) does", () => {
    const f = coneField();
    const n1 = heightNormals(f, 1), n3 = heightNormals(f, 3);
    const at = (n: Int8Array, i: number): [number, number, number] => [n[i * 3] / 127, n[i * 3 + 1] / 127, n[i * 3 + 2] / 127];
    for (const [cx, cy] of [[50, 110], [110, 50], [80, 120], [30, 80]]) {
      const i = cy * f.header.width + cx;
      expect(Math.abs(shade(at(n1, i), 3) - shade(at(n3, i), 1))).toBeLessThan(0.03);
    }
    const e = exaggerateNormal([0.6, 0, 0.8], 2);
    expect(e[0] / e[2]).toBeCloseTo((0.6 * 2) / 0.8, 12);
  });

  it("multiplies the colour with no tint, capped at 1", () => {
    expect(shadeColour([0.5, 0.2, 1], 1.2)).toEqual([0.6, 0.24, 1]);
    expect(shadeColour([1, 1, 1], 0.5)).toEqual([0.5, 0.5, 0.5]);
  });

  it("carries the same constants into the GLSL", () => {
    expect(SHADE_GLSL).toContain(`vec3(-0.5, 0.5, ${Math.SQRT1_2})`);
    expect(SHADE_GLSL).toContain("0.4, 1.25");
  });
});
