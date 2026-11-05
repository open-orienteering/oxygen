import { describe, it, expect } from "vitest";
import { loupeView, project, viewMatrix } from "../view";
import { scissorOfRing } from "../renderer";

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

describe("loupeView (the editor's loupe, docs/map-rendering.md §5.5)", () => {
  const main = { centreX: 1_250_000, centreY: -40_000, pxPerUm: 0.01, widthPx: 1000, heightPx: 2000, rotationDeg: 0 };
  const origin = { x: 1_000_000, y: 0 };
  const p = { x: 1_262_345, y: -37_890 };
  const at = (m: Float32Array, px: number, py: number) => project(m, px - origin.x, py - origin.y);

  it("is the main view at ×scale about the point, size² device px", () => {
    const v = loupeView({ ...main, rotationDeg: 17 }, p, 2.5, 315);
    expect(v).toEqual({ centreX: p.x, centreY: p.y, pxPerUm: 0.025, widthPx: 315, heightPx: 315, rotationDeg: 17 });
  });

  // Float32 matrix entries: 4 digits of clip is a hundredth of a loupe pixel.
  it("maps the dragged point to the loupe's centre and magnifies distances by the scale", () => {
    const m = viewMatrix(loupeView(main, p, 2.5, 315), origin.x, origin.y);
    const [x0, y0, w] = at(m, p.x, p.y);
    expect(x0).toBeCloseTo(0, 4);
    expect(y0).toBeCloseTo(0, 4);
    expect(w).toBe(1);
    // 20 main px east of the point → 50 loupe px right of the centre (clip = px / half size).
    const d = 20 / main.pxPerUm;
    expect(at(m, p.x + d, p.y)[0]).toBeCloseTo((2.5 * 20) / (315 / 2), 4);
    expect(at(m, p.x, p.y + d)[1]).toBeCloseTo((2.5 * 20) / (315 / 2), 4);
  });

  it("keeps the main view's rotation: with 90° an east point lands above the centre", () => {
    const m = viewMatrix(loupeView({ ...main, rotationDeg: 90 }, p, 2.5, 200), origin.x, origin.y);
    const [x, y] = at(m, p.x + 10 / main.pxPerUm, p.y);
    expect(x).toBeCloseTo(0, 4);
    expect(y).toBeCloseTo((2.5 * 10) / 100, 4);
  });

  it("defaults a missing rotation to 0", () => {
    const { rotationDeg: _r, ...upright } = main;
    expect(loupeView(upright, p, 2.5, 100).rotationDeg).toBe(0);
  });
});

describe("scissorOfRing (Layout mode's map clip, docs/course-layout.md §1)", () => {
  it("the frame's screen box in device pixels, bottom-left origin, clamped to the target", () => {
    // 1 px per mm (0.001 px/µm), 400 × 300 px, centred on (0, 0) paper; origin (1000, 2000) µm.
    const view = { centreX: 0, centreY: 0, pxPerUm: 0.001, widthPx: 400, heightPx: 300 };
    const m = viewMatrix(view, 1000, 2000);
    const ring: [number, number][] = [[-50_000, -20_000], [50_000, -20_000], [50_000, 40_000], [-50_000, 40_000]];
    expect(scissorOfRing(m, ring, 1000, 2000, 400, 300)).toEqual([150, 130, 100, 60]);
    // Twice the device pixels: twice the box.
    expect(scissorOfRing(m, ring, 1000, 2000, 800, 600)).toEqual([300, 260, 200, 120]);
    const big: [number, number][] = [[-1e6, -1e6], [1e6, -1e6], [1e6, 1e6], [-1e6, 1e6]];
    expect(scissorOfRing(m, big, 1000, 2000, 400, 300)).toEqual([0, 0, 400, 300]);
  });
});
