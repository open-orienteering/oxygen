/**
 * The style fields' pure part (J7; docs/course-editor.md §7 "Inspector"):
 * what a change to opacity, blend, rotation, flip, size or crop writes on a
 * course object (and, from J8, a page object). A default value removes its
 * key (100 %, Normal, 0°, no flip, the full crop), so an untouched object's
 * props stay as they were (J4 (5)).
 */

import { boxAbout, imageBox, IMAGE_MIN_MM, turn } from "./image-box";

type Pt = { x: number; y: number };

export interface StyleValue {
  opacity?: number;
  blend?: "multiply";
  rotationDeg?: number;
  flipH?: boolean;
  flipV?: boolean;
  crop?: Crop;
}
export interface Crop { x: number; y: number; width: number; height: number }

export const FULL_CROP: Crop = { x: 0, y: 0, width: 1, height: 1 };

/** A field's edit as the next props: `patch` over `props`, a default value removing its key. */
export function stylePatch<P extends StyleValue>(props: P, patch: { opacityPct?: number; blend?: "normal" | "multiply"; rotationDeg?: number; flipH?: boolean; flipV?: boolean; crop?: Crop | null }): P {
  const next = { ...props } as Record<string, unknown>;
  const set = (key: string, value: unknown, isDefault: boolean) => {
    if (isDefault) delete next[key];
    else next[key] = value;
  };
  if (patch.opacityPct !== undefined) {
    const pct = Math.round(Math.max(0, Math.min(100, patch.opacityPct)));
    set("opacity", pct / 100, pct === 100);
  }
  if (patch.blend !== undefined) set("blend", "multiply", patch.blend === "normal");
  if (patch.rotationDeg !== undefined) {
    const deg = Math.max(-360, Math.min(360, patch.rotationDeg));
    set("rotationDeg", deg, deg === 0 || Math.abs(deg) === 360);
  }
  if (patch.flipH !== undefined) set("flipH", true, !patch.flipH);
  if (patch.flipV !== undefined) set("flipV", true, !patch.flipV);
  if (patch.crop !== undefined) {
    const c = patch.crop;
    set("crop", c, !c || (c.x === 0 && c.y === 0 && c.width === 1 && c.height === 1));
  }
  return next as P;
}

/** A width or height typed for the box, about its centre (rotation is about the centre, so the image stays put); with `lock` the other side keeps the ratio. */
export function sizeChange(geometry: readonly Pt[], which: "width" | "height", mm: number, lock: boolean): [Pt, Pt] {
  const b = imageBox(geometry);
  const v = Math.max(IMAGE_MIN_MM, mm);
  let w = b.w, h = b.h;
  if (which === "width") {
    w = v;
    if (lock && b.w > 0) h = Math.max(IMAGE_MIN_MM, (b.h * v) / b.w);
  } else {
    h = v;
    if (lock && b.h > 0) w = Math.max(IMAGE_MIN_MM, (b.w * v) / b.h);
  }
  return boxAbout({ x: b.cx, y: b.cy }, w, h);
}

/**
 * A crop typed (or reset) in whole per cent: clamped so it stays in the graphic (at least 1 % a side), and the box
 * follows it so the visible pixels keep their scale and place on the map — the box grows or shrinks by the crop and
 * its centre moves to the new crop's centre, through the flips and the rotation (as J9's crop mode, "the content
 * stays put"). Returns the geometry and crop to write together.
 */
export function cropChange(geometry: readonly Pt[], style: Pick<StyleValue, "rotationDeg" | "flipH" | "flipV">, oldCrop: Crop | undefined, typed: Crop): { geometry: [Pt, Pt]; crop: Crop } {
  const old = oldCrop ?? FULL_CROP;
  const crop = clampCrop(typed);
  const b = imageBox(geometry);
  // mm per source fraction, horizontally and vertically.
  const sx = old.width > 0 ? b.w / old.width : 0, sy = old.height > 0 ? b.h / old.height : 0;
  const du = crop.x + crop.width / 2 - (old.x + old.width / 2);
  const dv = crop.y + crop.height / 2 - (old.y + old.height / 2);
  // Source u runs right, v down; the local frame is y-up; a flip mirrors its axis about the centre.
  const local = { x: du * sx * (style.flipH ? -1 : 1), y: -dv * sy * (style.flipV ? -1 : 1) };
  const off = turn(local, style.rotationDeg ?? 0);
  const w = Math.max(IMAGE_MIN_MM, crop.width * sx), h = Math.max(IMAGE_MIN_MM, crop.height * sy);
  return { geometry: boxAbout({ x: b.cx + off.x, y: b.cy + off.y }, w, h), crop };
}

/** A crop in the graphic: x, y in [0, 0.99], width, height at least 0.01, x + width and y + height at most 1. */
export function clampCrop(c: Crop): Crop {
  const r = (v: number) => Math.round(v * 100) / 100;
  const x = Math.max(0, Math.min(0.99, r(c.x))), y = Math.max(0, Math.min(0.99, r(c.y)));
  const width = Math.max(0.01, Math.min(1 - x, r(c.width))), height = Math.max(0.01, Math.min(1 - y, r(c.height)));
  return { x, y, width: r(width), height: r(height) };
}
