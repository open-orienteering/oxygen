/**
 * Layout mode's model (docs/course-layout.md §2): the sheet or template
 * being edited as one snapshot — what one gesture changes and one write
 * stores — and everything drawn from it: the page geometry, the page
 * request the GL layer draws (the composer's input), the editable and
 * locked objects of the scope.
 */

import {
  course,
  courseMapObjectPageBounds as courseMapObjectPageBoundsOf,
  getPaperDimensions,
  isWhiteoutObject,
  type CourseMapObject,
  type DescriptionBlockSettings,
  type MapFillMode,
  type MapRect,
  type MapTemplateSettings,
  type PathVertex,
} from "@oxygen/shared";
import type { LayoutRequest } from "../../../lib/course-layer-request";
import { sheetWindow, windowCentre, type SheetGeometry } from "../../../lib/editor/layout";
import { constrainMapObjectExtent, createImageObjectAt, createObjectAt, translateMapObject } from "../../../lib/map-layout-editor";
import { flipVertices, rotateVertices } from "../../../lib/editor/transform-gestures";
import type { PlaceKind } from "./bindings";
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "@oxygen/api";

type Pt = { x: number; y: number };

/**
 * The inspector's fill modes. `whiteoutInverted` stays selectable although
 * Layout has no tool for it (docs/course-layout.md §3, D14): objects that
 * have it stay editable and a polygon can still be made one.
 */
export const FILL_MODES: MapFillMode[] = ["none", "solid", "whiteout", "whiteoutInverted", "outOfBounds"];

/** The header text's size on paper (the rail's `H`). */
export const HEADER_SIZE_MM = 6;

export type EditorSheet = inferRouterOutputs<AppRouter>["courseMap"]["resolveSheet"];

/** What a Layout gesture edits; sheet scope stores it with `courseMap.saveLayout`, template scope with `mapTemplate.update`. */
export interface LayoutSnapshot {
  /** The window centre, paper mm (sheet scope: stored; template scope: the preview's, never stored). */
  centre: Pt;
  printScale: number;
  description: DescriptionBlockSettings;
  sheetObjects: CourseMapObject[];
  templateObjects: CourseMapObject[];
  /** The template's name (template scope writes it with the rest, one undo entry; E-pages). */
  templateName: string;
  /** Template scope's page settings (sheet scope: the template's, read-only). */
  paper: string;
  orientation: string;
  paperWidthMm: number | null;
  paperHeightMm: number | null;
  settings: MapTemplateSettings;
}

/** The snapshot of what the server holds. */
export function snapshotOf(s: EditorSheet): LayoutSnapshot {
  const t = s.template;
  return {
    centre: windowCentre(s.window),
    printScale: s.scope === "sheet" ? s.sheet?.overrides.printScale ?? t.printScale : t.printScale,
    description: s.scope === "sheet" ? s.document.description : t.settings.description,
    sheetObjects: s.sheet?.objects ?? [],
    templateObjects: t.objects,
    templateName: t.name,
    paper: t.paper,
    orientation: t.orientation,
    paperWidthMm: t.paperWidthMm,
    paperHeightMm: t.paperHeightMm,
    settings: t.settings,
  };
}

/** Template scope's write (`mapTemplate.update` without the id and token): the whole template as the snapshot holds it. */
export function templateWriteOf(s: LayoutSnapshot) {
  return {
    name: s.templateName,
    paper: s.paper as "A4",
    orientation: s.orientation as "portrait",
    ...(s.paper === "custom" ? { paperWidthMm: s.paperWidthMm, paperHeightMm: s.paperHeightMm } : {}),
    printScale: s.printScale,
    settings: { ...s.settings, description: s.description },
    objects: s.templateObjects,
  };
}

/** A course's next sheet name: "<course> 2", "<course> 3", … — the first free number after its sheets (E-pages). */
export function nextSheetName(base: string, taken: readonly string[]): string {
  const names = new Set(taken);
  for (let i = Math.max(2, taken.length + 1); ; i += 1) if (!names.has(`${base} ${i}`)) return `${base} ${i}`;
}

/** The status bar's sheet key (docs/course-layout.md §5): `1:10000 A4 portrait`. */
export function sheetKeyOf(snap: Pick<LayoutSnapshot, "printScale" | "paper" | "orientation" | "paperWidthMm" | "paperHeightMm">): string {
  const paper = snap.paper === "custom" ? `${Math.round(snap.paperWidthMm ?? 0)}×${Math.round(snap.paperHeightMm ?? 0)}` : snap.paper;
  return `1:${snap.printScale} ${paper} ${snap.orientation}`;
}

/** The frame: the sheet's override, else the template's. */
export function frameOf(s: EditorSheet, snap: LayoutSnapshot): MapRect {
  return (s.scope === "sheet" ? s.sheet?.overrides.mapFrame : undefined) ?? snap.settings.mapFrame;
}

export function geometryOf(s: EditorSheet, snap: LayoutSnapshot): SheetGeometry {
  const paper = getPaperDimensions(
    snap.paper as "A4",
    snap.orientation as "portrait",
    snap.paper === "custom" ? { width: snap.paperWidthMm ?? 210, height: snap.paperHeightMm ?? 297 } : undefined,
  );
  const m = snap.settings.printMarginMm;
  const frame = frameOf(s, snap);
  return {
    paper: { widthMm: paper.width, heightMm: paper.height },
    printable: { x: m, y: m, width: Math.max(0.001, paper.width - 2 * m), height: Math.max(0.001, paper.height - 2 * m) },
    frame,
    window: sheetWindow(frame, snap.centre, s.mapScale, snap.printScale, s.window.rotationDeg ?? 0),
  };
}

/** The objects a gesture may change (the scope's own) and the ones drawn but locked (the template's, in sheet scope). */
export function scopeObjects(s: EditorSheet, snap: LayoutSnapshot): { editable: CourseMapObject[]; locked: CourseMapObject[] } {
  return s.scope === "sheet" ? { editable: snap.sheetObjects, locked: snap.templateObjects } : { editable: snap.templateObjects, locked: [] };
}

/** The snapshot with the scope's editable objects replaced. */
export function withEditable(s: EditorSheet, snap: LayoutSnapshot, objects: CourseMapObject[]): LayoutSnapshot {
  return s.scope === "sheet" ? { ...snap, sheetObjects: objects } : { ...snap, templateObjects: objects };
}

/**
 * The sheet as the course layer and the page part draw it (the composer's
 * input, `resolveSheet`): layout objects of both scopes, the scale's text
 * value and overprint, the block where the snapshot puts it, and a course
 * sheet's part (`section_index`, course-layer.md §11).
 */
export function layoutRequestOf(s: EditorSheet, snap: LayoutSnapshot, g: SheetGeometry): LayoutRequest {
  const d = snap.description;
  return {
    page: {
      paper: { heightMm: g.paper.heightMm },
      frame: g.frame,
      window: g.window,
      objects: [...snap.templateObjects, ...snap.sheetObjects],
      textValues: { ...s.page.textValues, scale: `1:${snap.printScale}` },
      description: d.visible ? { x: d.x, y: d.y, cellSizeMm: d.cellSizeMm, rows: s.block.rows, header: s.block.header, title: s.block.title } : null,
    },
    appearance: course.appearanceFromTemplate(snap.settings.appearance),
    ...(s.sheet?.kind === "course" && s.sheet.sectionIndex !== undefined ? { section: s.sheet.sectionIndex } : {}),
  };
}

/**
 * `P`'s drawn polygon (docs/course-layout.md §3, D16): a closed page path
 * with the drawn points (page mm, already clamped) and the defaults of
 * `createObjectAt("path")`.
 */
export function pathObject(points: PathVertex[], printable: MapRect): Extract<CourseMapObject, { kind: "path" }> {
  const o = createObjectAt("path", points[0] ?? { x: printable.x, y: printable.y }, printable);
  if (o.kind !== "path") throw new Error("createObjectAt(\"path\") made no path");
  return { ...o, points, closed: true };
}

/**
 * A new object of a rail tool at a page point (docs/course-layout.md §3),
 * clamped to the printable area by `lib/map-layout-editor.ts`'s creators.
 * The block is not an object: the rail's `D` shows it (`description`).
 */
export function placeObject(
  what: Exclude<PlaceKind, "description" | "path">, at: Pt, printable: MapRect, graphicId?: number,
  size?: { widthPx: number | null; heightPx: number | null } | null,
): CourseMapObject | null {
  switch (what) {
    case "header": {
      const o = createObjectAt("text", at, printable);
      return o.kind === "text" ? { ...o, fontSizeMm: HEADER_SIZE_MM } : o;
    }
    case "text":
      return createObjectAt("text", at, printable);
    case "image":
      return graphicId === undefined ? null : createImageObjectAt(graphicId, at, printable, size);
    case "whiteout": {
      const o = createObjectAt("rectangle", at, printable);
      if (o.kind !== "rectangle") return o;
      // A white-out has no border.
      const { stroke: _stroke, strokeWidthMm: _width, ...plain } = o;
      return { ...plain, fillMode: "whiteout" };
    }
    case "line":
    case "rectangle":
      return createObjectAt(what, at, printable);
  }
}

// ─── Style fields (J8; docs/course-layout.md §3 "Style fields") ───

/** Which style fields a page object shows: opacity always; blend off white-outs; rotation on text, rectangle, image; flip and crop on image; size on rectangle and image, the lock on image. */
export function styleShowOf(o: CourseMapObject): { blend: boolean; rotation: boolean; flip: boolean; size: boolean; crop: boolean; lock: boolean } {
  const image = o.kind === "image";
  return {
    blend: !isWhiteoutObject(o),
    rotation: o.kind === "text" || o.kind === "rectangle" || image,
    flip: image,
    size: image || o.kind === "rectangle",
    crop: image,
    lock: image,
  };
}

/**
 * A rectangle's or image's box as the shared style fields take it: two corners, y-up (`lib/editor/style-fields.ts`
 * works in a course object's y-up paper mm). Page mm are y-down, so y is negated; `rotationDeg` is clockwise as
 * seen in both spaces.
 */
export function styleGeometryOf(o: CourseMapObject): [Pt, Pt] | undefined {
  if (o.kind !== "rectangle" && o.kind !== "image") return undefined;
  return [{ x: o.x, y: -(o.y + o.height) }, { x: o.x + o.width, y: -o.y }];
}

/** The page box (y-down, top-left) of a style-field geometry. */
export function rectOfStyleGeometry(g: readonly Pt[]): MapRect {
  const x0 = Math.min(g[0].x, g[1].x), x1 = Math.max(g[0].x, g[1].x), y0 = Math.min(g[0].y, g[1].y), y1 = Math.max(g[0].y, g[1].y);
  return { x: x0, y: -y1, width: x1 - x0, height: y1 - y0 };
}

/**
 * A style field's commit on page object `o` as the whole next object (default values removed, not merged). A size
 * or crop sets the box from `geometry`, no larger than the printable area (an image scaled down whole, so it keeps
 * its ratio). A change of box or rotation is then kept on the printable area by its drawn extent; opacity, blend and
 * flips move nothing (docs/course-layout.md §3 "Style fields").
 */
export function styleChangeOf(o: CourseMapObject, next: { props?: CourseMapObject; geometry?: readonly Pt[] }, printable: MapRect): CourseMapObject {
  let out = next.props ?? o;
  let boxChanged = false;
  if (next.geometry && (out.kind === "rectangle" || out.kind === "image")) {
    const r = rectOfStyleGeometry(next.geometry);
    const cx = r.x + r.width / 2, cy = r.y + r.height / 2;
    let { width, height } = r;
    if (out.kind === "image") {
      const k = Math.min(1, printable.width / width, printable.height / height);
      width *= k;
      height *= k;
    } else {
      width = Math.min(width, printable.width);
      height = Math.min(height, printable.height);
    }
    out = { ...out, x: cx - width / 2, y: cy - height / 2, width, height };
    boxChanged = true;
  }
  const turned = "rotationDeg" in out && (out.rotationDeg ?? 0) !== ("rotationDeg" in o ? (o.rotationDeg ?? 0) : 0);
  return boxChanged || turned ? constrainMapObjectExtent(out, printable) : out;
}

/** A line's or path's inspector transform (J9): turn by `deg` clockwise as seen, or mirror across H / V. */
export type PathTransform = { kind: "rotate"; deg: number } | { kind: "flip"; axis: "h" | "v" };

/**
 * A line or path transformed about the centre of its bounds, baked into its vertices and Bézier handles (lines and
 * paths store no angle, docs/course-layout.md §3 "Rotate and flip a line or path"), kept on the printable area
 * (`constrainMapObjectExtent`: one larger than the area is pinned at its top-left). Null for any other kind (those
 * turn by their field and knob) and for a whole turn.
 */
export function transformPathOf(o: CourseMapObject, op: PathTransform, printable: MapRect): CourseMapObject | null {
  if (o.kind !== "path" && o.kind !== "line") return null;
  // A whole turn changes nothing: no write, no empty undo entry.
  if (op.kind === "rotate" && op.deg % 360 === 0) return null;
  const b = courseMapObjectPageBoundsOf(o);
  const about = { x: b.x + b.width / 2, y: -(b.y + b.height / 2) };
  // Page mm are y-down: the shared maths turn and mirror in y-up, so y (and each handle's y) is negated round it.
  const up = <V extends { x: number; y: number; hIn?: Pt; hOut?: Pt }>(v: V): V => ({
    ...v, y: -v.y, ...(v.hIn ? { hIn: { x: v.hIn.x, y: -v.hIn.y } } : {}), ...(v.hOut ? { hOut: { x: v.hOut.x, y: -v.hOut.y } } : {}),
  });
  const apply = <V extends { x: number; y: number; hIn?: Pt; hOut?: Pt }>(vs: readonly V[]): V[] =>
    (op.kind === "rotate" ? rotateVertices(vs.map(up), op.deg, about) : flipVertices(vs.map(up), op.axis, about)).map(up);
  if (o.kind === "line") {
    const [a, c] = apply([{ x: o.x1, y: o.y1 }, { x: o.x2, y: o.y2 }]);
    return constrainMapObjectExtent({ ...o, x1: a.x, y1: a.y, x2: c.x, y2: c.y }, printable);
  }
  return constrainMapObjectExtent({ ...o, points: apply(o.points) }, printable);
}

/** `Ctrl+D` on a page object (J12; docs/course-layout.md §2 "Keys"): a copy 3 mm down-right on the page, a new id, kept on the printable area. */
export function duplicatePageObject(o: CourseMapObject, printable: MapRect): CourseMapObject {
  return constrainMapObjectExtent({ ...translateMapObject(o, 3, 3), id: crypto.randomUUID() } as CourseMapObject, printable);
}

/** `Ctrl+V` of a page object (J12): its page bounds' centre on `at` (page mm), a new id, kept on the printable area. */
export function pastePageObject(o: CourseMapObject, at: Pt, printable: MapRect): CourseMapObject {
  const b = courseMapObjectPageBoundsOf(o);
  const moved = translateMapObject(o, at.x - (b.x + b.width / 2), at.y - (b.y + b.height / 2));
  return constrainMapObjectExtent({ ...moved, id: crypto.randomUUID() } as CourseMapObject, printable);
}
