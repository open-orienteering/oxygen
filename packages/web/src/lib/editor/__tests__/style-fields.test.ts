/**
 * The style fields' writes (J7; docs/course-editor.md §7 "Inspector"): opacity in %, defaults removing their key,
 * rotation clamped, size about the centre with the lock, a crop that keeps the content's scale and place.
 */
import { describe, expect, it } from "vitest";
import { clampCrop, cropChange, FULL_CROP, sizeChange, stylePatch, type StyleValue } from "../style-fields";
import { course } from "@oxygen/shared";
import { imageBox, imageBoxAt, imageAt, resizeImage } from "../image-box";
import { imageRing } from "../hit";

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

  it("crop is clamped into the graphic, and to at least 1 mm a side at the image's scale", () => {
    expect(clampCrop({ x: 0.8, y: -1, width: 0.5, height: 0 })).toEqual({ x: 0.5, y: 0, width: 0.5, height: 0.01 });
    expect(clampCrop({ x: 0.8, y: 0, width: 0.1, height: 1 })).toEqual({ x: 0.8, y: 0, width: 0.1, height: 1 });
    // A 20 × 10 mm box: 1 mm is 5 % across and 10 % down; Reset then gives the same box back.
    const r = cropChange(box, {}, undefined, { x: 0, y: 0, width: 0.01, height: 0.01 });
    expect(r.crop).toEqual({ x: 0, y: 0, width: 0.05, height: 0.1 });
    const back = cropChange(r.geometry, {}, r.crop, FULL_CROP).geometry;
    expect(back[1].x - back[0].x).toBeCloseTo(20, 6);
    expect(back[1].y - back[0].y).toBeCloseTo(10, 6);
  });

  // A source point's place on the map, from the course layer's own image corners (bottom-left, bottom-right,
  // top-right, top-left of the visible part; course-layer.md §3.6), so a change there fails this test.
  const placeOf = (geometry: { x: number; y: number }[], crop: typeof FULL_CROP, style: { rotationDeg?: number; flipH?: boolean; flipV?: boolean }, u: number, v: number) => {
    const b = imageBox(geometry);
    const [bl, br, , tl] = course.imageCorners({ x: b.x0, y: b.y0, width: b.w, height: b.h }, style);
    const s = (u - crop.x) / crop.width, t = 1 - (v - crop.y) / crop.height;
    return { x: bl.x + s * (br.x - bl.x) + t * (tl.x - bl.x), y: bl.y + s * (br.y - bl.y) + t * (tl.y - bl.y) };
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

describe("image box (J7)", () => {
  const image = (id: number, geometry: { x: number; y: number }[], rotationDeg?: number) =>
    ({ id, kind: "image", geometry, props: { graphicId: 1, ...(rotationDeg ? { rotationDeg } : {}) }, scope: { all: true }, z: 0, version: "1", inCourses: null }) as course.CourseObject;

  it("imageAt: the topmost image holding the point, turned boxes by their turn, other kinds skipped", () => {
    const a = image(1, [{ x: 0, y: 0 }, { x: 20, y: 20 }]), b = image(2, [{ x: 10, y: 10 }, { x: 30, y: 30 }]);
    const area = { id: 3, kind: "whiteout", geometry: [{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 40, y: 40 }], props: {}, scope: { all: true }, z: 0, version: "1", inCourses: null } as course.CourseObject;
    expect(imageAt([a, b, area], { x: 15, y: 15 })?.id).toBe(2);
    expect(imageAt([a, b], { x: 5, y: 5 })?.id).toBe(1);
    expect(imageAt([area], { x: 5, y: 5 })).toBeNull();
    const turned = image(4, [{ x: 0, y: 0 }, { x: 20, y: 20 }], 45);
    expect(imageAt([turned], { x: 1, y: 1 })).toBeNull();
    expect(imageAt([turned], { x: -3, y: 10 })?.id).toBe(4);
  });

  it("resizeImage: every corner keeps its opposite; at least 1 mm a side", () => {
    const g = imageBoxAt({ x: 0, y: 0 }, 2, 1, 20);
    for (const corner of [0, 1, 3]) {
      const ring = imageRing(g, 30);
      const to = { x: ring[corner].x + 3, y: ring[corner].y - 2 };
      const out = imageRing(resizeImage(g, 30, corner, to, false), 30);
      expect(out[(corner + 2) % 4].x).toBeCloseTo(ring[(corner + 2) % 4].x, 6);
      expect(out[(corner + 2) % 4].y).toBeCloseTo(ring[(corner + 2) % 4].y, 6);
      expect(out[corner].x).toBeCloseTo(to.x, 6);
      expect(out[corner].y).toBeCloseTo(to.y, 6);
    }
    const tiny = resizeImage(g, 0, 2, { x: -100, y: -100 }, false);
    expect(tiny[1].x - tiny[0].x).toBeCloseTo(1, 6);
    expect(tiny[1].y - tiny[0].y).toBeCloseTo(1, 6);
    const locked = resizeImage(g, 0, 2, { x: -100, y: -100 }, true);
    expect(locked[1].y - locked[0].y).toBeCloseTo(1, 6);
    expect(locked[1].x - locked[0].x).toBeCloseTo(2, 6);
  });
});
