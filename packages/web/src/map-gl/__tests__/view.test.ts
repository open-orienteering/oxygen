import { describe, it, expect } from "vitest";
import { project, viewMatrix } from "../view";

describe("viewMatrix (arena projection, docs/map-rendering.md §5.2)", () => {
  const view = { centreX: 1_250_000, centreY: -40_000, pxPerUm: 0.01, widthPx: 1000, heightPx: 500 };
  const origin = { x: 1_000_000, y: 0 };
  const at = (m: Float32Array, px: number, py: number) => project(m, px - origin.x, py - origin.y);

  it("maps the view centre to clip (0, 0) and the canvas edges to ±1, y-up", () => {
    const m = viewMatrix(view, origin.x, origin.y);
    const [x0, y0, w] = at(m, view.centreX, view.centreY);
    expect(x0).toBeCloseTo(0, 6);
    expect(y0).toBeCloseTo(0, 6);
    expect(w).toBe(1);
    // Half the canvas width in µm to the right is the right edge; half the height up is the top.
    expect(at(m, view.centreX + 500 / 0.01, view.centreY)[0]).toBeCloseTo(1, 6);
    expect(at(m, view.centreX, view.centreY + 250 / 0.01)[1]).toBeCloseTo(1, 6);
  });

  it("rotates counter-clockwise by rotationDeg", () => {
    const m = viewMatrix({ ...view, rotationDeg: 90, widthPx: 500 }, origin.x, origin.y);
    // A point east of the centre ends up above it.
    const [x, y] = at(m, view.centreX + 250 / 0.01, view.centreY);
    expect(x).toBeCloseTo(0, 6);
    expect(y).toBeCloseTo(1, 6);
  });

  it("keeps sub-pixel precision far from the origin after the float32 upload", () => {
    // Club-full scale: ± 585 mm from the origin, 20× paper on a 2.625-DPR phone (≈ 0.2 px/µm).
    const far = { centreX: 585_000, centreY: 300_000, pxPerUm: 0.2, widthPx: 1081, heightPx: 2402 };
    const m = viewMatrix(far, 0, 0);
    // The shader's float32 arithmetic: every product and sum rounded.
    const f = Math.fround;
    const p = f(585_000 + 37.5), q = f(300_000);
    const x = f(f(f(m[0] * p) + f(m[4] * q)) + m[12]);
    const px = (x * far.widthPx) / 2;
    expect(Math.abs(px - 37.5 * 0.2)).toBeLessThan(0.05);
  });
});
