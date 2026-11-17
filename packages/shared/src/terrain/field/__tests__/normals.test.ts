import { describe, expect, it } from "vitest";
import { heightNormals } from "../index.js";
import { gridField } from "./fixtures.js";

const at = (n: Int8Array, i: number) => [n[i * 3], n[i * 3 + 1], n[i * 3 + 2]];
/** The unit normal of z = a·x + b·y (metres per metre) as snorm8. */
const analytic = (a: number, b: number) => {
  const l = Math.hypot(a, b, 1);
  return [-a / l, -b / l, 1 / l].map((v) => Math.round(v * 127) + 0);
};

describe("heightNormals (map-terrain.md §5.4)", () => {
  // 0.2 mm cells at 1:15 000 = 3 m on the ground; 16 units per cell in x = 1.25 m per 3 m.
  const f = gridField(6, 5, (cx, cy) => 16 * cx - 8 * cy);
  const ax = (16 * 5) / 64 / 3, ay = (-8 * 5) / 64 / 3;

  it("equals the analytic normal of a plane, edges included", () => {
    const n = heightNormals(f);
    for (const i of [0, 7, 14, 29]) expect(at(n, i)).toEqual(analytic(ax, ay));
  });

  it("scales the slope by the exaggeration", () => {
    expect(at(heightNormals(f, 2), 14)).toEqual(analytic(2 * ax, 2 * ay));
  });

  it("points straight up on a flat field and in no-data cells; one-sided beside no-data", () => {
    expect(at(heightNormals(gridField(3, 3, () => 40)), 4)).toEqual([0, 0, 127]);
    const holes = gridField(5, 3, (cx, cy) => (cx === 3 && cy === 1 ? NaN : 16 * cx));
    const n = heightNormals(holes);
    expect(at(n, 8)).toEqual([0, 0, 127]);
    expect(at(n, 7)).toEqual(analytic((16 * 5) / 64 / 3, 0));
    expect(at(n, 9)).toEqual(analytic(0, 0));
  });
});
