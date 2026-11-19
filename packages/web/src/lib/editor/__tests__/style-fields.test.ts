/**
 * The style fields' writes (J7; docs/course-editor.md §7 "Inspector"): opacity in %, defaults removing their key,
 * rotation clamped, size about the centre with the lock, a crop that keeps the content's scale and place.
 */
import { describe, expect, it } from "vitest";
import { clampCrop, cropChange, FULL_CROP, sizeChange, stylePatch, type StyleValue } from "../style-fields";
import { imageBox, turn } from "../image-box";

const box = [{ x: 0, y: 0 }, { x: 20, y: 10 }];
const img = (o: { graphicId: number; opacity?: number }) => o as StyleValue & { graphicId: number };

describe("style fields (J7)", () => {
  it("opacity: 50 % → 0.5, 100 % removes the key", () => {
    expect(stylePatch(img({ graphicId: 1 }), { opacityPct: 50 })).toEqual({ graphicId: 1, opacity: 0.5 });
    expect(stylePatch(img({ graphicId: 1, opacity: 0.5 }), { opacityPct: 100 })).toEqual({ graphicId: 1 });
    expect(stylePatch({}, { opacityPct: 130 })).toEqual({});
  });

  it("blend: Multiply sets it, Normal removes it", () => {
    expect(stylePatch({}, { blend: "multiply" })).toEqual({ blend: "multiply" });
    expect(stylePatch({ blend: "multiply" as const }, { blend: "normal" })).toEqual({});
  });

  it("rotation clamped to ±360, 0 removed; flips off removed", () => {
    expect(stylePatch({}, { rotationDeg: 400 })).toEqual({});
    expect(stylePatch({}, { rotationDeg: -30 })).toEqual({ rotationDeg: -30 });
    expect(stylePatch({ rotationDeg: 30 }, { rotationDeg: 0 })).toEqual({});
    expect(stylePatch({}, { flipH: true })).toEqual({ flipH: true });
    expect(stylePatch({ flipH: true, flipV: true }, { flipH: false })).toEqual({ flipV: true });
  });

  it("size: about the centre; a locked width change scales the height", () => {
    expect(sizeChange(box, "width", 40, true)).toEqual([{ x: -10, y: -5 }, { x: 30, y: 15 }]);
    expect(sizeChange(box, "height", 20, false)).toEqual([{ x: 0, y: -5 }, { x: 20, y: 15 }]);
    expect(sizeChange(box, "width", 0, false)[1].x - sizeChange(box, "width", 0, false)[0].x).toBe(1);
  });

  it("crop is clamped into the graphic", () => {
    expect(clampCrop({ x: 0.8, y: -1, width: 0.5, height: 0 })).toEqual({ x: 0.8, y: 0, width: 0.2, height: 0.01 });
  });

  // A source point's place on the map, through crop, box, flips and rotation (the layer's drawing, course-layer.md §3.6).
  const placeOf = (geometry: { x: number; y: number }[], crop: typeof FULL_CROP, style: { rotationDeg?: number; flipH?: boolean; flipV?: boolean }, u: number, v: number) => {
    const b = imageBox(geometry);
    let lx = ((u - crop.x) / crop.width - 0.5) * b.w, ly = -((v - crop.y) / crop.height - 0.5) * b.h;
    if (style.flipH) lx = -lx;
    if (style.flipV) ly = -ly;
    const o = turn({ x: lx, y: ly }, style.rotationDeg ?? 0);
    return { x: b.cx + o.x, y: b.cy + o.y };
  };

  for (const style of [{}, { rotationDeg: 30 }, { rotationDeg: 30, flipH: true }, { flipV: true }]) {
    it(`a crop change keeps the content's scale and place (${JSON.stringify(style)}); Reset restores the full box`, () => {
      const next = { x: 0.25, y: 0.1, width: 0.5, height: 0.6 };
      const r = cropChange(box, style, undefined, next);
      for (const [u, v] of [[0.3, 0.2], [0.7, 0.65]]) {
        const before = placeOf(box, FULL_CROP, style, u, v), after = placeOf(r.geometry, r.crop, style, u, v);
        expect(after.x).toBeCloseTo(before.x, 6);
        expect(after.y).toBeCloseTo(before.y, 6);
      }
      const back = cropChange(r.geometry, style, r.crop, FULL_CROP);
      expect(back.geometry[0].x).toBeCloseTo(0, 6);
      expect(back.geometry[0].y).toBeCloseTo(0, 6);
      expect(back.geometry[1].x).toBeCloseTo(20, 6);
      expect(back.geometry[1].y).toBeCloseTo(10, 6);
    });
  }
});
