/**
 * Layout mode's viewer binding (docs/course-layout.md §2, §3; 08 §5.3
 * Layout column): click selects a page or map object of the scope, drag
 * moves it, a handle resizes it, the block moves, the selected frame
 * aligns the map; with a placement tool armed a click places. Exclusive:
 * the course layer's own targets stay off (Layout mode locks course
 * edits, 08 §5.4) and a drag on nothing pans. The object maths are
 * `lib/map-layout-editor.ts`'s, unchanged.
 */

import type { CourseMapObject, DescriptionBlockSettings, MapRect } from "@oxygen/shared";
import type { EditorToolBinding, ToolPointer, ToolShape } from "../../../components/MapViewer";
import {
  alignedCentre, handleAt, layoutObjectAt, objectHandles, pageDelta, pagePerView, rectInView, selectionShapes, sheetShapes, toPage, toView,
  type SheetGeometry,
} from "../../../lib/editor/layout";
import { constrainDescription, constrainMapObject, resizeMapObject, translateMapObject, type ResizeHandle } from "../../../lib/map-layout-editor";
import { courseMapObjectPageBounds } from "@oxygen/shared";
import { HANDLE_PX } from "../tools/bindings";

type Pt = { x: number; y: number };

export type LayoutSelection = { kind: "object"; id: string } | { kind: "frame" } | { kind: "description" } | null;

/** What the rail arms (08 §5.2 Layout tools; `L` / `R` / `P` added, `O` removed again, docs/course-layout.md §3). */
export type PlaceKind = "header" | "text" | "image" | "whiteout" | "line" | "rectangle" | "path" | "description";
export type LayoutTool = { kind: "select" } | { kind: "place"; what: PlaceKind; graphicId?: number };

/** The rail's keys (the page owns the keyboard). */
export const LAYOUT_KEYS: Record<string, PlaceKind | "select"> = {
  V: "select", H: "header", T: "text", I: "image", D: "description", W: "whiteout", L: "line", R: "rectangle", P: "path",
};

/** What Layout mode shows: a sheet, or a template previewed with the selected course. */
export type LayoutTarget = { sheet: number } | { template: number };

export type LayoutGesture =
  | { kind: "move"; id: string; from: Pt; base: CourseMapObject; moved: boolean }
  | { kind: "resize"; id: string; handle: ResizeHandle; from: Pt; base: CourseMapObject; moved: boolean; proportional: boolean }
  | { kind: "description"; from: Pt; base: DescriptionBlockSettings; moved: boolean }
  | { kind: "align"; from: Pt; base: Pt; moved: boolean }
  | null;

/** What one gesture changes: the scope's objects, the block's settings, the window centre. */
export interface LayoutChange {
  objects?: CourseMapObject[];
  description?: DescriptionBlockSettings;
  centre?: Pt;
}

export interface LayoutBindingContext {
  geometry: SheetGeometry;
  /** The scope's objects (sheet scope: the sheet's; template scope: the template's). */
  editable: readonly CourseMapObject[];
  /** Drawn, never selected (the template's objects in sheet scope). */
  locked: readonly CourseMapObject[];
  description: DescriptionBlockSettings;
  /** The block on the page while it is shown. */
  block: MapRect | null;
  centre: Pt;
  selection: LayoutSelection;
  tool: LayoutTool;
  /** 1 mm steps (08 §5.3 "Grid 1 mm"). */
  snapping: boolean;
  gesture: { current: LayoutGesture };
  imageHref: (graphicId: number) => string;
  onPreview: (change: LayoutChange | null) => void;
  onCommit: (change: LayoutChange) => void;
  onSelect: (selection: LayoutSelection) => void;
  onPlace: (what: PlaceKind, page: Pt, graphicId?: number) => void;
}

const inRect = (p: Pt, r: MapRect) => p.x >= r.x && p.x <= r.x + r.width && p.y >= r.y && p.y <= r.y + r.height;
const step = (d: Pt, on: boolean): Pt => (on ? { x: Math.round(d.x), y: Math.round(d.y) } : d);

/** What a drag from `g.from` to `to` changes. */
export function gestureChange(c: Pick<LayoutBindingContext, "geometry" | "editable" | "block" | "snapping">, g: NonNullable<LayoutGesture>, to: Pt): LayoutChange {
  const { frame, window, printable } = c.geometry;
  if (g.kind === "align") return { centre: alignedCentre(g.base, g.from, to) };
  const d = step(pageDelta(g.from, to, c.geometry), c.snapping);
  if (g.kind === "description") {
    const b = c.block;
    return { description: constrainDescription({ ...g.base, x: g.base.x + d.x, y: g.base.y + d.y }, b?.width ?? 0, b?.height ?? 0, printable) };
  }
  const next = g.kind === "move"
    ? constrainMapObject(translateMapObject(g.base, d.x, d.y, frame, window), printable, frame, window)
    : resizeMapObject(g.base, g.handle, d.x, d.y, frame, window, { printable, imageMode: g.proportional ? "proportional" : "free" });
  return { objects: c.editable.map((o) => (o.id === g.id ? next : o)) };
}

/** The handle tolerance in page mm at the current zoom. */
const tolerance = (p: ToolPointer, g: SheetGeometry) => HANDLE_PX * p.mmPerPx * pagePerView(g);

/** An image object's corners in paper mm, for the UI layer's raster. */
function imageShape(o: Extract<CourseMapObject, { kind: "image" }>, g: SheetGeometry, href: string): ToolShape | null {
  const b = courseMapObjectPageBounds(o, g.frame, g.window);
  if (!b) return null;
  return {
    kind: "image", href, testId: "editor-layout-image", data: { objectId: o.id },
    topLeft: toView({ x: b.x, y: b.y }, g), topRight: toView({ x: b.x + b.width, y: b.y }, g), bottomLeft: toView({ x: b.x, y: b.y + b.height }, g),
  };
}

export function layoutBinding(c: LayoutBindingContext): EditorToolBinding {
  const g = c.geometry;
  const selected = c.selection?.kind === "object" ? c.editable.find((o) => o.id === (c.selection as { id: string }).id) ?? null : null;

  const shapes: ToolShape[] = [...sheetShapes(g, c.selection?.kind === "frame")];
  for (const o of [...c.locked, ...c.editable]) {
    if (o.kind !== "image") continue;
    const s = imageShape(o, g, c.imageHref(o.graphicId));
    if (s) shapes.push(s);
  }
  if (selected) {
    const b = courseMapObjectPageBounds(selected, g.frame, g.window);
    if (b) shapes.push(...selectionShapes(b, objectHandles(selected, g), g, "editor-layout-selection"));
  }
  if (c.block && c.selection?.kind === "description") shapes.push(...selectionShapes(c.block, [], g, "editor-layout-selection"));
  if (c.block) shapes.push({ kind: "line", points: rectInView(c.block, g), closed: true, color: "transparent", widthPx: 0, testId: "editor-layout-description" });

  const placing = c.tool.kind === "place" ? c.tool : null;

  return {
    exclusive: true,
    cursor: placing ? "crosshair" : undefined,
    shapes,
    onPointerDown: (p) => {
      if (placing) return false;
      const page = toPage(p.pt, g);
      const tol = tolerance(p, g);
      if (selected) {
        const h = handleAt(page, objectHandles(selected, g), tol);
        if (h) {
          c.gesture.current = { kind: "resize", id: selected.id, handle: h, from: p.pt, base: selected, moved: false, proportional: p.shift };
          return true;
        }
      }
      const i = layoutObjectAt(page, c.editable, g, tol);
      if (i >= 0) {
        const o = c.editable[i];
        c.onSelect({ kind: "object", id: o.id });
        c.gesture.current = { kind: "move", id: o.id, from: p.pt, base: o, moved: false };
        return true;
      }
      if (c.block && inRect(page, c.block)) {
        c.onSelect({ kind: "description" });
        c.gesture.current = { kind: "description", from: p.pt, base: c.description, moved: false };
        return true;
      }
      // Align map: only the selected frame drags (08 §5.3 "frame drag = align map"); else a drag pans.
      if (c.selection?.kind === "frame" && inRect(page, g.frame)) {
        c.gesture.current = { kind: "align", from: p.pt, base: c.centre, moved: false };
        return true;
      }
      return false;
    },
    onPointerDrag: (pt) => {
      const gst = c.gesture.current;
      if (!gst) return;
      gst.moved = true;
      c.onPreview(gestureChange(c, gst, pt));
    },
    onPointerUp: (pt) => {
      const gst = c.gesture.current;
      c.gesture.current = null;
      c.onPreview(null);
      if (gst && pt && gst.moved) c.onCommit(gestureChange(c, gst, pt));
    },
    onClick: (p) => {
      const page = toPage(p.pt, g);
      if (placing) {
        c.onPlace(placing.what, page, placing.graphicId);
        return;
      }
      // Template objects are locked in sheet scope: a click on one selects nothing (the inspector links to the template).
      c.onSelect(inRect(page, g.frame) ? { kind: "frame" } : null);
    },
  };
}
