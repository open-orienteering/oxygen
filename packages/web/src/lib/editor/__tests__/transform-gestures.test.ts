import { describe, expect, it } from "vitest";
import { course } from "@oxygen/shared";
import { imageRing } from "../hit";
import {
  anchorKnob, boxRing, cropEdge, edgeHandles, flipVertices, normaliseDeg, resizeBox, rotateKnob, rotateVertices, rotationAt,
  transformVertices, uncroppedRing,
} from "../transform-gestures";

type Pt = { x: number; y: number };
const g: [Pt, Pt] = [{ x: 0, y: 0 }, { x: 40, y: 20 }];
const close = (a: Pt, b: Pt) => { expect(a.x).toBeCloseTo(b.x, 6); expect(a.y).toBeCloseTo(b.y, 6); };

describe("transform gestures (J9, docs/course-layout.md §3 \"Transform handles\")", () => {
  it("boxRing is imageRing about the centre, and turns about a given pivot", () => {
    boxRing(g, 30).forEach((p, i) => close(p, imageRing(g, 30)[i]));
    const r = boxRing(g, 90, { x: 0, y: 0 });
    // A quarter turn clockwise as seen about the bottom-left corner: x1y0 goes below it.
    close(r[0], { x: 0, y: 0 });
    close(r[1], { x: 0, y: -40 });
  });

  it("the knob sits above the top edge, and turns with the box", () => {
    close(rotateKnob(boxRing(g, 0), 5), { x: 20, y: 25 });
    close(rotateKnob(boxRing(g, 90), 5), { x: 35, y: 10 });
  });

  it("resizeBox keeps the opposite corner at 0° and 30°; the lock keeps the ratio; the minimum holds", () => {
    for (const deg of [0, 30]) {
      const ring = boxRing(g, deg);
      const to = { x: ring[2].x + 4, y: ring[2].y + 1 };
      const out = boxRing(resizeBox(g, deg, 2, to, false, 2), deg);
      close(out[0], ring[0]);
      close(out[2], to);
    }
    const locked = resizeBox(g, 0, 2, { x: 60, y: 100 }, true, 2);
    expect((locked[1].x - locked[0].x) / (locked[1].y - locked[0].y)).toBeCloseTo(2, 6);
    const tiny = resizeBox(g, 0, 2, { x: -50, y: -50 }, false, 2);
    expect(tiny[1].x - tiny[0].x).toBeCloseTo(2, 6);
  });

  it("rotationAt: a quarter turn clockwise as seen is +90, a press in place the base, Shift 15° steps, normalised", () => {
    const c = { x: 0, y: 0 };
    expect(rotationAt(0, c, { x: 0, y: 10 }, { x: 10, y: 0 }, false)).toBe(90);
    expect(rotationAt(12.3, c, { x: 0, y: 10 }, { x: 0, y: 10 }, false)).toBe(12.3);
    expect(rotationAt(0, c, { x: 0, y: 10 }, { x: 10, y: 7 }, true) % 15).toBe(0);
    expect(rotationAt(170, c, { x: 0, y: 10 }, { x: 10, y: 0 }, false)).toBe(-100);
    expect(normaliseDeg(-180)).toBe(180);
    expect(normaliseDeg(360)).toBe(0);
  });

  // The renderer's rule (`course.imageCorners`): a source (u, v) placed bilinearly in the crop on the turned, flipped box.
  function place(geometry: readonly Pt[], style: { rotationDeg?: number; flipH?: boolean; flipV?: boolean; crop?: { x: number; y: number; width: number; height: number } }, u: number, v: number): Pt {
    const crop = style.crop ?? { x: 0, y: 0, width: 1, height: 1 };
    const x0 = Math.min(geometry[0].x, geometry[1].x), y0 = Math.min(geometry[0].y, geometry[1].y);
    const box = { x: x0, y: y0, width: Math.abs(geometry[1].x - geometry[0].x), height: Math.abs(geometry[1].y - geometry[0].y) };
    const [bl, br, tr, tl] = course.imageCorners(box, style);
    const s = (u - crop.x) / crop.width, t = (v - crop.y) / crop.height;
    const top = { x: tl.x + (tr.x - tl.x) * s, y: tl.y + (tr.y - tl.y) * s };
    const bot = { x: bl.x + (br.x - bl.x) * s, y: bl.y + (br.y - bl.y) * s };
    return { x: top.x + (bot.x - top.x) * t, y: top.y + (bot.y - top.y) * t };
  }

  for (const style of [{}, { rotationDeg: 30 }, { flipH: true }, { rotationDeg: -40, flipV: true }]) {
    it(`cropEdge moves the dragged side only and keeps the pixels in place: ${JSON.stringify(style)}`, () => {
      const ring = boxRing(g, (style as { rotationDeg?: number }).rotationDeg ?? 0);
      const right = edgeHandles(ring).find((h) => h.edge === "right")!.at;
      const left = edgeHandles(ring).find((h) => h.edge === "left")!.at;
      // Three quarters of the way from the left edge to the right one.
      const to = { x: left.x + (right.x - left.x) * 0.75, y: left.y + (right.y - left.y) * 0.75 };
      const r = cropEdge(g, style, "right", to);
      expect(r.crop.width).toBeCloseTo(0.75, 6);
      expect(r.crop.x).toBeCloseTo((style as { flipH?: boolean }).flipH ? 0.25 : 0, 6);
      const next = { ...style, crop: r.crop };
      close(place(r.geometry, next, 0.5, 0.5), place(g, style, 0.5, 0.5));
      // The edge that stayed: its pixels did not move.
      const keptU = (style as { flipH?: boolean }).flipH ? 1 : 0;
      close(place(r.geometry, next, keptU, 0.3), place(g, style, keptU, 0.3));
    });
  }

  it("cropEdge on top and bottom under flipV, on an already cropped and turned image, keeps the pixels", () => {
    const style = { rotationDeg: -130, flipV: true, flipH: true, crop: { x: 0.1, y: 0.2, width: 0.6, height: 0.6 } };
    for (const edge of ["top", "bottom", "left"] as const) {
      const ring = boxRing(g, style.rotationDeg);
      const h = edgeHandles(ring).find((e) => e.edge === edge)!.at;
      const c = { x: 20, y: 10 };
      const to = { x: h.x + (c.x - h.x) * 0.3, y: h.y + (c.y - h.y) * 0.3 };
      const r = cropEdge(g, style, edge, to);
      const next = { ...style, crop: r.crop };
      // A pixel near the middle stays; the crop shrank by about 30 % of the half on that axis.
      close(place(r.geometry, next, 0.4, 0.5), place(g, style, 0.4, 0.5));
      if (edge === "left") expect(r.crop.width).toBeLessThan(0.6);
      else expect(r.crop.height).toBeLessThan(0.6);
    }
  });

  it("cropEdge stops at the whole graphic and at 1 %; uncroppedRing is the full graphic", () => {
    const cropped = cropEdge(g, {}, "top", { x: 20, y: 10 });
    expect(cropped.crop).toEqual({ x: 0, y: 0.5, width: 1, height: 0.5 });
    const back = cropEdge(cropped.geometry, { crop: cropped.crop }, "top", { x: 20, y: 500 });
    expect(back.crop).toEqual({ x: 0, y: 0, width: 1, height: 1 });
    boxRing(g).forEach((p, i) => close(p, uncroppedRing(cropped.geometry, { crop: cropped.crop })[i]));
    const thin = cropEdge(g, {}, "right", { x: -100, y: 10 });
    // At least 1 mm at the image's scale: 1 / 40 → 3 % in whole per cent.
    expect(thin.crop.width).toBeCloseTo(0.03, 6);
  });

  it("rotateVertices and flipVertices turn and mirror the handles; four quarter turns and two flips restore", () => {
    const path = [{ x: 0, y: 0, hOut: { x: 2, y: 1 } }, { x: 10, y: 0, hIn: { x: -1, y: 3 } }, { x: 10, y: 5 }];
    const about = { x: 5, y: 2.5 };
    const q = rotateVertices(path, 90, about);
    close(q[0], { x: 2.5, y: 7.5 });
    close(q[0].hOut!, { x: 1, y: -2 });
    let r = path;
    for (let i = 0; i < 4; i++) r = rotateVertices(r, 90, about);
    r.forEach((v, i) => close(v, path[i]));
    const f = flipVertices(path, "h", about);
    close(f[0], { x: 10, y: 0 });
    close(f[0].hOut!, { x: -2, y: 1 });
    flipVertices(flipVertices(path, "v", about), "v", about).forEach((v, i) => close(v, path[i]));
  });

  it("anchorKnob: straight up from a text's anchor at 0°, turned with it (J11)", () => {
    close(anchorKnob({ x: 3, y: 4 }, 0, 5), { x: 3, y: 9 });
    close(anchorKnob({ x: 3, y: 4 }, 90, 5), { x: 8, y: 4 });
  });

  it("transformVertices: a turn with its handles, both flips, a whole turn is null (J11)", () => {
    const tri = [{ x: 0, y: 0, hOut: { x: 1, y: 0 } }, { x: 4, y: 0 }, { x: 2, y: 2 }];
    const about = { x: 2, y: 1 };
    const q = transformVertices(tri, { kind: "rotate", deg: 90 }, about)!;
    q.forEach((v, i) => close(v, rotateVertices(tri, 90, about)[i]));
    close(q[0].hOut!, { x: 0, y: -1 });
    close(transformVertices(tri, { kind: "flip", axis: "h" }, about)![1], { x: 0, y: 0 });
    close(transformVertices(tri, { kind: "flip", axis: "v" }, about)![2], { x: 2, y: 0 });
    expect(transformVertices(tri, { kind: "rotate", deg: 360 }, about)).toBeNull();
    expect(transformVertices(tri, { kind: "rotate", deg: -720 }, about)).toBeNull();
  });
});
