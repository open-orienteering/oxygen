/**
 * An `image` course object's box as the editor edits it (J7;
 * docs/course-editor.md §7 "Editing geometry"): the two stored corners are
 * the unturned box, drawn turned `rotationDeg` clockwise as seen about its
 * centre (`imageRing`, course-layer.md §3.6 "Images"). Paper mm at the
 * map's scale, y-up, as every course object.
 *
 * - `imageBoxAt`: the box `I` places, centred on the click, at the
 *   graphic's aspect, `longerMm` on its longer side.
 * - `resizeImage`: a corner dragged in the object's own frame, the opposite
 *   corner fixed where it is drawn; with the lock the box keeps its ratio.
 * - `imageAt`: the topmost image whose turned box holds a point (the
 *   click that selects an image, §5).
 */

import type { course } from "@oxygen/shared";
import { imageRing, insideConvexRing as insideConvex } from "./hit";

type Pt = { x: number; y: number };
type ImageObject = Extract<course.CourseObject, { kind: "image" }>;

/** `I` places at this size on the longer side (map-scale mm, as a text's size). */
export const IMAGE_PLACE_MM = 30;
/** No side of an image is made smaller by a gesture or a field. */
export const IMAGE_MIN_MM = 1;

/** The box centred on `pt` at the aspect `widthPx` : `heightPx`, `longerMm` on its longer side; a square when the size is unknown. */
export function imageBoxAt(pt: Pt, widthPx: number | null | undefined, heightPx: number | null | undefined, longerMm = IMAGE_PLACE_MM): [Pt, Pt] {
  const w = widthPx ?? 0, h = heightPx ?? 0;
  const k = w > 0 && h > 0 ? longerMm / Math.max(w, h) : 0;
  const bw = k ? w * k : longerMm, bh = k ? h * k : longerMm;
  return [{ x: pt.x - bw / 2, y: pt.y - bh / 2 }, { x: pt.x + bw / 2, y: pt.y + bh / 2 }];
}

/** The stored box: min / max corners, centre and size. */
export function imageBox(geometry: readonly Pt[]): { x0: number; y0: number; x1: number; y1: number; cx: number; cy: number; w: number; h: number } {
  const [p, q] = geometry;
  const x0 = Math.min(p.x, q.x), x1 = Math.max(p.x, q.x), y0 = Math.min(p.y, q.y), y1 = Math.max(p.y, q.y);
  return { x0, y0, x1, y1, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, w: x1 - x0, h: y1 - y0 };
}

/** `v` (a local offset) turned clockwise as seen by `deg` (y-up), as `imageRing` turns the corners. */
export function turn(v: Pt, deg: number): Pt {
  const r = (deg * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r);
  return { x: v.x * c + v.y * s, y: -v.x * s + v.y * c };
}

/** The inverse of `turn`. */
const unturn = (v: Pt, deg: number): Pt => turn(v, -deg);

/** The box centred on `c`, `w` × `h`, as two stored corners. */
export const boxAbout = (c: Pt, w: number, h: number): [Pt, Pt] => [{ x: c.x - w / 2, y: c.y - h / 2 }, { x: c.x + w / 2, y: c.y + h / 2 }];

/**
 * Corner `corner` (the index into `imageRing`'s ring: x0y0, x1y0, x1y1, x0y1) dragged to `pt`: the opposite
 * corner stays where it is drawn, the size is the pointer's offset in the object's frame (with `lock`, projected
 * onto the box's diagonal so the ratio is kept), at least `IMAGE_MIN_MM` a side.
 */
export function resizeImage(geometry: readonly Pt[], rotationDeg: number, corner: number, pt: Pt, lock: boolean): [Pt, Pt] {
  const b = imageBox(geometry);
  const ring = imageRing(geometry, rotationDeg);
  const opposite = ring[(corner + 2) % 4];
  const sx = corner === 1 || corner === 2 ? 1 : -1;
  const sy = corner === 2 || corner === 3 ? 1 : -1;
  const d = unturn({ x: pt.x - opposite.x, y: pt.y - opposite.y }, rotationDeg);
  let w: number, h: number;
  if (lock && b.w > 0 && b.h > 0) {
    const t = (d.x * sx * b.w + d.y * sy * b.h) / (b.w * b.w + b.h * b.h);
    const k = Math.max(t, IMAGE_MIN_MM / b.w, IMAGE_MIN_MM / b.h);
    w = b.w * k;
    h = b.h * k;
  } else {
    w = Math.max(IMAGE_MIN_MM, d.x * sx);
    h = Math.max(IMAGE_MIN_MM, d.y * sy);
  }
  const off = turn({ x: (sx * w) / 2, y: (sy * h) / 2 }, rotationDeg);
  return boxAbout({ x: opposite.x + off.x, y: opposite.y + off.y }, w, h);
}

/** The topmost (last drawn) image whose turned box holds `pt`; null when none. */
export function imageAt(objects: readonly course.CourseObject[], pt: Pt): ImageObject | null {
  for (let i = objects.length - 1; i >= 0; i--) {
    const o = objects[i];
    if (o.kind === "image" && insideConvex(pt, imageRing(o.geometry, o.props.rotationDeg))) return o;
  }
  return null;
}
