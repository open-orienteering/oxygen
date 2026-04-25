import { describe, it, expect } from "vitest";
import { rotatedBoundingBox } from "../map-rotation";

/**
 * Reference implementation: rotate the four corners of an inner rectangle
 * by `deg` around the centre, and check that all four corners of the
 * outer rectangle (also relative to the same centre) lie inside the
 * rotated inner rectangle. This is what we actually need from the helper
 * — the rotated inner layer must fully cover the outer container.
 */
function outerCornersInsideRotatedInner(
  outerW: number,
  outerH: number,
  innerW: number,
  innerH: number,
  deg: number,
): boolean {
  const rad = (deg * Math.PI) / 180;
  // We want every outer corner, expressed in the inner-rectangle's local
  // (rotated) frame, to fall inside [-innerW/2, innerW/2] × [-innerH/2, innerH/2].
  // To go from world coords (outer frame) to inner frame, rotate by -deg.
  const cos = Math.cos(-rad);
  const sin = Math.sin(-rad);
  const halfOuterW = outerW / 2;
  const halfOuterH = outerH / 2;
  const halfInnerW = innerW / 2;
  const halfInnerH = innerH / 2;
  const corners = [
    [-halfOuterW, -halfOuterH],
    [halfOuterW, -halfOuterH],
    [halfOuterW, halfOuterH],
    [-halfOuterW, halfOuterH],
  ];
  // small epsilon so we don't fail on float rounding at the boundary
  const eps = 1e-9;
  for (const [x, y] of corners) {
    const lx = x * cos - y * sin;
    const ly = x * sin + y * cos;
    if (Math.abs(lx) > halfInnerW + eps) return false;
    if (Math.abs(ly) > halfInnerH + eps) return false;
  }
  return true;
}

describe("rotatedBoundingBox", () => {
  it("returns the outer dimensions verbatim at 0°", () => {
    expect(rotatedBoundingBox(1024, 600, 0)).toEqual({ width: 1024, height: 600 });
    expect(rotatedBoundingBox(600, 1024, 0)).toEqual({ width: 600, height: 1024 });
  });

  // At cardinal angles the float `cos`/`sin` aren't exactly 0/1
  // (Math.cos(Math.PI/2) ≈ 6e-17), so Math.ceil may add 1px. Allow that.

  it("at 90° swaps width and height", () => {
    const r = rotatedBoundingBox(1024, 600, 90);
    expect(r.width).toBeGreaterThanOrEqual(600);
    expect(r.width).toBeLessThanOrEqual(601);
    expect(r.height).toBeGreaterThanOrEqual(1024);
    expect(r.height).toBeLessThanOrEqual(1025);
  });

  it("at 180° equals (within 1px of) the outer dimensions", () => {
    const r = rotatedBoundingBox(1024, 600, 180);
    expect(r.width).toBeGreaterThanOrEqual(1024);
    expect(r.width).toBeLessThanOrEqual(1025);
    expect(r.height).toBeGreaterThanOrEqual(600);
    expect(r.height).toBeLessThanOrEqual(601);
  });

  it("at -90° swaps width and height (sign-independent)", () => {
    const r = rotatedBoundingBox(1024, 600, -90);
    expect(r.width).toBeGreaterThanOrEqual(600);
    expect(r.width).toBeLessThanOrEqual(601);
    expect(r.height).toBeGreaterThanOrEqual(1024);
    expect(r.height).toBeLessThanOrEqual(1025);
  });

  it("never under-covers the outer rectangle for typical angles and aspect ratios", () => {
    const sizes: Array<[number, number]> = [
      [1024, 600],   // landscape (typical desktop dashboard)
      [600, 1024],   // portrait (mobile rotated)
      [800, 800],    // square
      [1920, 1080],  // wide
      [375, 812],    // mobile portrait
    ];
    const angles = [-45, -30, -11, -7, -1, 1, 7, 11, 30, 45, 60, 89];
    for (const [w, h] of sizes) {
      for (const deg of angles) {
        const { width, height } = rotatedBoundingBox(w, h, deg);
        expect(
          outerCornersInsideRotatedInner(w, h, width, height, deg),
          `outer ${w}×${h} not covered by rotated ${width}×${height} at ${deg}°`,
        ).toBe(true);
      }
    }
  });

  it("over-covers by at most 2 pixels per axis (close to optimal)", () => {
    // The exact (non-integer) minimum is w·|cos|+h·|sin| / w·|sin|+h·|cos|.
    // Math.ceil rounds up by ≤1px; allow 2 to be safe against float rounding.
    const cases: Array<[number, number, number]> = [
      [1024, 600, 11],
      [1024, 600, 7],
      [1920, 1080, 30],
      [800, 800, 45],
    ];
    for (const [w, h, deg] of cases) {
      const rad = (deg * Math.PI) / 180;
      const exactW = w * Math.abs(Math.cos(rad)) + h * Math.abs(Math.sin(rad));
      const exactH = w * Math.abs(Math.sin(rad)) + h * Math.abs(Math.cos(rad));
      const { width, height } = rotatedBoundingBox(w, h, deg);
      expect(width - exactW).toBeGreaterThanOrEqual(0);
      expect(width - exactW).toBeLessThanOrEqual(2);
      expect(height - exactH).toBeGreaterThanOrEqual(0);
      expect(height - exactH).toBeLessThanOrEqual(2);
    }
  });

  it("fixes the regression of the single-factor (|cos|+|sin|) formula on landscape viewports", () => {
    // Old formula: renderH = round(h * (|cos|+|sin|)) for h=600, deg=11°
    // gave ≈ 704, but the true minimum is ~785 — an 81px deficit that
    // produced visible white wedges at the top/bottom corners.
    const w = 1024, h = 600, deg = 11;
    const { height } = rotatedBoundingBox(w, h, deg);
    expect(height).toBeGreaterThanOrEqual(785);
    expect(outerCornersInsideRotatedInner(w, h, rotatedBoundingBox(w, h, deg).width, height, deg)).toBe(true);
  });
});
