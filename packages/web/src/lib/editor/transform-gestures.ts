/**
 * Transform gestures on a box (J9; docs/course-layout.md §3 "Transform
 * handles", docs/course-editor.md §7 "Editing geometry"): a box's turned
 * ring and its corner handles, the rotate knob above it, a corner resize in
 * the box's own frame with the opposite corner fixed (the aspect lock XOR
 * Shift), a rotation from the pointer's angle about the pivot (Shift snaps
 * to 15°), the crop edges of an image (the visible pixels stay put), and
 * the rotate and flip a line or path takes from the inspector (baked into
 * its vertices; lines and paths store no angle).
 *
 * Everything is in the caller's units, y-up, `rotationDeg` clockwise as
 * seen (as `image-box.ts` and the course layer, J4 (4)); Layout mode feeds
 * page mm through J8's y-negating adapter (`layout/model.ts`
 * `styleGeometryOf`). Pure; a drag in progress is the caller's object.
 */

import { boxAbout, imageBox, turn } from "./image-box";
import { cropChange, FULL_CROP, type Crop, type StyleValue } from "./style-fields";
import type { Vertex } from "./geometry-edit";

type Pt = { x: number; y: number };

/** The rotate knob's stem above the top edge, screen px. */
export const ROTATE_STEM_PX = 24;

const unturn = (v: Pt, deg: number): Pt => turn(v, -deg);
const add = (a: Pt, b: Pt): Pt => ({ x: a.x + b.x, y: a.y + b.y });
const sub = (a: Pt, b: Pt): Pt => ({ x: a.x - b.x, y: a.y - b.y });

/**
 * The box (two stored corners, unturned) turned `rotationDeg` about `pivot` (default its centre) as a ring in
 * `imageRing`'s order: x0y0, x1y0, x1y1, x0y1 (y-up: bottom-left, bottom-right, top-right, top-left).
 */
export function boxRing(geometry: readonly Pt[], rotationDeg = 0, pivot?: Pt): Pt[] {
  const b = imageBox(geometry);
  const c = pivot ?? { x: b.cx, y: b.cy };
  return [{ x: b.x0, y: b.y0 }, { x: b.x1, y: b.y0 }, { x: b.x1, y: b.y1 }, { x: b.x0, y: b.y1 }]
    .map((q) => add(c, turn(sub(q, c), rotationDeg)));
}

/** The top edge's midpoint of a ring and its outward unit normal (the knob's stem runs along it). */
export function knobBase(ring: readonly Pt[]): { at: Pt; normal: Pt } {
  const at = { x: (ring[2].x + ring[3].x) / 2, y: (ring[2].y + ring[3].y) / 2 };
  const edge = sub(ring[2], ring[3]);
  const len = Math.hypot(edge.x, edge.y) || 1;
  // The top edge runs x0y1 → x1y1; its outward normal is the edge turned a quarter counter-clockwise.
  return { at, normal: { x: -edge.y / len, y: edge.x / len } };
}

/** The knob `stem` units above the top edge. */
export function rotateKnob(ring: readonly Pt[], stem: number): Pt {
  const k = knobBase(ring);
  return add(k.at, { x: k.normal.x * stem, y: k.normal.y * stem });
}

/**
 * Corner `corner` (an index into `boxRing`'s ring) dragged to `pt`: the opposite corner stays where it is drawn, the
 * size is the pointer's offset in the box's own frame (with `lock`, projected onto the box's diagonal so the ratio is
 * kept), at least `minSize` a side. The box turns about its centre.
 */
export function resizeBox(geometry: readonly Pt[], rotationDeg: number, corner: number, pt: Pt, lock: boolean, minSize: number): [Pt, Pt] {
  const b = imageBox(geometry);
  const ring = boxRing(geometry, rotationDeg);
  const opposite = ring[(corner + 2) % 4];
  const sx = corner === 1 || corner === 2 ? 1 : -1;
  const sy = corner === 2 || corner === 3 ? 1 : -1;
  const d = unturn(sub(pt, opposite), rotationDeg);
  let w: number, h: number;
  if (lock && b.w > 0 && b.h > 0) {
    const t = (d.x * sx * b.w + d.y * sy * b.h) / (b.w * b.w + b.h * b.h);
    const k = Math.max(t, minSize / b.w, minSize / b.h);
    w = b.w * k;
    h = b.h * k;
  } else {
    w = Math.max(minSize, d.x * sx);
    h = Math.max(minSize, d.y * sy);
  }
  const off = turn({ x: (sx * w) / 2, y: (sy * h) / 2 }, rotationDeg);
  return boxAbout(add(opposite, off), w, h);
}

/** A rotation normalised to (−180, 180], rounded to 0.1° (the field's step). */
export function normaliseDeg(deg: number): number {
  let d = ((deg % 360) + 360) % 360;
  if (d > 180) d -= 360;
  const r = Math.round(d * 10) / 10;
  return r === -180 ? 180 : r === 0 ? 0 : r;
}

/**
 * The rotation a knob drag sets: `baseDeg` plus the pointer's turn about `pivot` from `press` to `pt`, clockwise as
 * seen (so the knob follows the pointer without a jump at the press); `snap` rounds to 15°.
 */
export function rotationAt(baseDeg: number, pivot: Pt, press: Pt, pt: Pt, snap: boolean): number {
  const a0 = Math.atan2(press.y - pivot.y, press.x - pivot.x), a1 = Math.atan2(pt.y - pivot.y, pt.x - pivot.x);
  // y-up: atan2 grows counter-clockwise, so clockwise as seen is its decrease.
  let deg = baseDeg - ((a1 - a0) * 180) / Math.PI;
  if (snap) deg = Math.round(deg / 15) * 15;
  return normaliseDeg(deg);
}

/** A box edge in its own (unturned, unflipped) frame. */
export type BoxEdge = "left" | "right" | "top" | "bottom";
export const BOX_EDGES: readonly BoxEdge[] = ["left", "right", "top", "bottom"];

/** The midpoints of a turned ring's edges (the crop mode's handles). */
export function edgeHandles(ring: readonly Pt[]): { edge: BoxEdge; at: Pt }[] {
  const mid = (a: Pt, b: Pt) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  return [
    { edge: "left", at: mid(ring[0], ring[3]) }, { edge: "right", at: mid(ring[1], ring[2]) },
    { edge: "top", at: mid(ring[2], ring[3]) }, { edge: "bottom", at: mid(ring[0], ring[1]) },
  ];
}

/**
 * The whole graphic's ring for an image cropped to `crop` (the dashed outline crop mode shows): the box grown back
 * to the full source at the crop's scale, through the flips and the rotation.
 */
export function uncroppedRing(geometry: readonly Pt[], style: Pick<StyleValue, "rotationDeg" | "flipH" | "flipV" | "crop">): Pt[] {
  const full = cropChange(geometry, style, style.crop, FULL_CROP);
  return boxRing(full.geometry, style.rotationDeg ?? 0);
}

/**
 * Edge `edge` of an image's box dragged to `pt`: the crop side under that edge (a flip mirrors which source side it
 * is) moves to the pointer, the opposite side stays, and the box follows (`cropChange`: whole per cent, inside the
 * graphic, at least 1 % and 1 mm a side; the visible pixels keep their scale and place).
 */
export function cropEdge(geometry: readonly Pt[], style: Pick<StyleValue, "rotationDeg" | "flipH" | "flipV" | "crop">, edge: BoxEdge, pt: Pt): { geometry: [Pt, Pt]; crop: Crop } {
  const old = style.crop ?? FULL_CROP;
  const b = imageBox(geometry);
  const sx = b.w / old.width, sy = b.h / old.height;
  const local = unturn(sub(pt, { x: b.cx, y: b.cy }), style.rotationDeg ?? 0);
  // Source u runs right, v down; the local frame is y-up; a flip mirrors its axis about the centre.
  const u = old.x + old.width / 2 + (local.x * (style.flipH ? -1 : 1)) / sx;
  const v = old.y + old.height / 2 - (local.y * (style.flipV ? -1 : 1)) / sy;
  let x0 = old.x, x1 = old.x + old.width, y0 = old.y, y1 = old.y + old.height;
  const horizontal = edge === "left" || edge === "right";
  // Which source side the box edge shows: the box's right edge is u's max side, unless flipped.
  const maxSide = horizontal ? (edge === "right") !== !!style.flipH : (edge === "bottom") !== !!style.flipV;
  if (horizontal) {
    if (maxSide) x1 = Math.max(x0 + 0.01, Math.min(1, u));
    else x0 = Math.min(x1 - 0.01, Math.max(0, u));
  } else if (maxSide) y1 = Math.max(y0 + 0.01, Math.min(1, v));
  else y0 = Math.min(y1 - 0.01, Math.max(0, v));
  return cropChange(geometry, style, style.crop, { x: x0, y: y0, width: x1 - x0, height: y1 - y0 });
}

/** A line's or path's vertices turned `deg` clockwise as seen about `about` (y-up), handles turned with them. */
export function rotateVertices<V extends Vertex>(vertices: readonly V[], deg: number, about: Pt): V[] {
  return vertices.map((v) => {
    const p = add(about, turn(sub(v, about), deg));
    return {
      ...v, x: p.x, y: p.y,
      ...(v.hIn ? { hIn: turn(v.hIn, deg) } : {}),
      ...(v.hOut ? { hOut: turn(v.hOut, deg) } : {}),
    };
  });
}

/** A line's or path's vertices mirrored across the vertical (`h`) or horizontal (`v`) line through `about`. */
export function flipVertices<V extends Vertex>(vertices: readonly V[], axis: "h" | "v", about: Pt): V[] {
  const m = (q: Pt): Pt => (axis === "h" ? { x: -q.x, y: q.y } : { x: q.x, y: -q.y });
  return vertices.map((v) => {
    const p = add(about, m(sub(v, about)));
    return { ...v, x: p.x, y: p.y, ...(v.hIn ? { hIn: m(v.hIn) } : {}), ...(v.hOut ? { hOut: m(v.hOut) } : {}) };
  });
}

/**
 * A text's rotate knob (J11; docs/course-editor.md §7 "Transform handles"): `stem` units from its anchor along the
 * text's own up, turned `rotationDeg` clockwise as seen (y-up). A course text stores no box, so the knob is all it
 * gets: it turns about the anchor (user answer 6).
 */
export function anchorKnob(anchor: Pt, rotationDeg: number, stem: number): Pt {
  return add(anchor, turn({ x: 0, y: stem }, rotationDeg));
}

/** An inspector turn or flip of a line's or path's vertices about `about` (J11); null for a whole turn (no write). */
export function transformVertices<V extends Vertex>(
  vertices: readonly V[], op: { kind: "rotate"; deg: number } | { kind: "flip"; axis: "h" | "v" }, about: Pt,
): V[] | null {
  if (op.kind === "rotate") return op.deg % 360 === 0 ? null : rotateVertices(vertices, op.deg, about);
  return flipVertices(vertices, op.axis, about);
}
