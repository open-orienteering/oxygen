/**
 * Layout mode's viewer binding (docs/course-layout.md §2, §3; 08 §5.3
 * Layout column): click selects a page or map object of the scope, drag
 * moves it, a handle resizes it, the block moves, the selected frame
 * aligns the map; with a placement tool armed a click places; `P` draws a
 * polygon with the course editor's area flow (`areaBinding`, D16), and a
 * selected path takes the course editor's geometry gestures
 * (`lib/editor/geometry-gestures.ts`) in page mm.
 * Exclusive: the course layer's own targets stay off (Layout mode locks
 * course edits, 08 §5.4) and a drag on nothing pans. The object maths are
 * `lib/map-layout-editor.ts`'s.
 */

import type { CourseMapObject, DescriptionBlockSettings, MapRect } from "@oxygen/shared";
import type { EditorToolBinding, ToolPointer, ToolShape } from "../../../components/MapViewer";
import {
  alignedCentre, gridSnap, handleAt, layoutObjectAt, objectHandles, pageDelta, pagePerView, pathFromView, pathRule, rectInView,
  selectionShapes, sheetShapes, toPage, toView, type SheetGeometry,
} from "../../../lib/editor/layout";
import { clampPagePoint, constrainDescription, constrainMapObject, resizeMapObject, translateMapObject, type ResizeHandle } from "../../../lib/map-layout-editor";
import {
  draggedGeometry, dragGeometry, geometryShapes, insertAtEdge, pressGeometry, releaseGeometry, type GeometryDrag,
} from "../../../lib/editor/geometry-gestures";
import { courseMapObjectPageBounds } from "@oxygen/shared";
import { areaBinding, HANDLE_PX, type GestureRef } from "../tools/bindings";
import type { PolygonState } from "../tools/polygon";
import { mapVertices, type Vertex } from "../../../lib/editor/geometry-edit";

type Pt = { x: number; y: number };
type PathObject = Extract<CourseMapObject, { kind: "path" }>;

export type LayoutSelection = { kind: "object"; id: string } | { kind: "frame" } | { kind: "description" } | null;

/** What the rail arms (08 §5.2 Layout tools; `L` / `R` / `P` added, `O` removed again, docs/course-layout.md §3). */
export type PlaceKind = "header" | "text" | "image" | "whiteout" | "line" | "rectangle" | "path" | "description";
/** `P` is a drawing (`draw`, the polygon flow in the viewer's paper mm); the other tools place by a click. */
export type LayoutTool = { kind: "select" } | { kind: "place"; what: Exclude<PlaceKind, "path">; graphicId?: number } | { kind: "draw"; poly: PolygonState };

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
  /** A vertex or a handle grip of the selected path, in page mm (`geometry-gestures.ts`). */
  | { kind: "geometry"; id: string; base: PathObject; drag: GeometryDrag }
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
  onPlace: (what: Exclude<PlaceKind, "path">, page: Pt, graphicId?: number) => void;
  /** The selected path's focused vertex (a click on its handle): `Delete` removes it. */
  focusedVertex?: number | null;
  onVertexFocus?: (index: number | null) => void;
  /**
   * `P`'s drawing (the course editor's area flow, docs/course-layout.md §3), with `tool.kind === "draw"`:
   * its gesture and hover live in the page; `onPath` gets the closed path on the page (page mm, clamped).
   */
  draw?: {
    gesture: GestureRef;
    hover: Pt | null;
    onHover: (p: ToolPointer | null) => void;
    onPoly: (poly: PolygonState) => void;
    onPath: (points: Vertex[]) => void;
    onCancel: () => void;
  };
}

const inRect = (p: Pt, r: MapRect) => p.x >= r.x && p.x <= r.x + r.width && p.y >= r.y && p.y <= r.y + r.height;
const step = (d: Pt, on: boolean): Pt => (on ? { x: Math.round(d.x), y: Math.round(d.y) } : d);

/** What a drag from `g.from` to `to` changes. */
export function gestureChange(c: Pick<LayoutBindingContext, "geometry" | "editable" | "block" | "snapping">, g: NonNullable<LayoutGesture>, to: Pt): LayoutChange {
  const { printable } = c.geometry;
  if (g.kind === "align") return { centre: alignedCentre(g.base, g.from, to) };
  // The drag's own state (`dragGeometry` updates it with the keys held); `to` is already in it.
  if (g.kind === "geometry") return g.drag.moved ? pathChange(c, g.base, draggedGeometry(g.drag), movedVertex(g.drag)) : {};
  const d = step(pageDelta(g.from, to, c.geometry), c.snapping);
  if (g.kind === "description") {
    const b = c.block;
    return { description: constrainDescription({ ...g.base, x: g.base.x + d.x, y: g.base.y + d.y }, b?.width ?? 0, b?.height ?? 0, printable) };
  }
  const next = g.kind === "move"
    ? constrainMapObject(translateMapObject(g.base, d.x, d.y), printable)
    : resizeMapObject(g.base, g.handle, d.x, d.y, { printable, imageMode: g.proportional ? "proportional" : "free" });
  return { objects: c.editable.map((o) => (o.id === g.id ? next : o)) };
}

/**
 * The pointer on the page for a geometry drag: a vertex moved with the grid on goes in whole millimetres from where
 * it was (the offset snapped, as a move); handles are free.
 */
function geometryPoint(c: Pick<LayoutBindingContext, "geometry" | "snapping">, d: GeometryDrag, to: Pt): Pt {
  const page = toPage(to, c.geometry);
  if (!c.snapping || d.kind !== "object" || d.vertex === null || d.alt) return page;
  return { x: d.from.x + Math.round(page.x - d.from.x), y: d.from.y + Math.round(page.y - d.from.y) };
}

/** The vertex a drag moves (not an Alt-drag, which pulls its handles), −1 for none. */
const movedVertex = (d: GeometryDrag): number => (d.kind === "object" && d.vertex !== null && !d.alt ? d.vertex : -1);

/** The scope's objects with the path's page points stored; the `moved` vertex kept on the printable area. */
function pathChange(c: Pick<LayoutBindingContext, "geometry" | "editable">, base: PathObject, points: readonly Vertex[], moved = -1): LayoutChange {
  const page = points.map((v, i) => (i === moved ? { ...v, ...clampPagePoint(v, c.geometry.printable) } : v));
  const next: PathObject = { ...base, points: page };
  return { objects: c.editable.map((o) => (o.id === base.id ? next : o)) };
}

const PATH_IDS = { outline: "editor-layout-selection", handle: "editor-layout-handle", grip: "editor-layout-grip" };

/** The handle tolerance in page mm at the current zoom. */
const tolerance = (p: ToolPointer, g: SheetGeometry) => HANDLE_PX * p.mmPerPx * pagePerView(g);

/** An image object's corners in paper mm, for the UI layer's raster. */
function imageShape(o: Extract<CourseMapObject, { kind: "image" }>, g: SheetGeometry, href: string): ToolShape | null {
  const b = courseMapObjectPageBounds(o);
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
  if (selected?.kind === "path" && c.tool.kind !== "draw") {
    // The course editor's selected path (§7 "Editing geometry"): its outline along the curves, handles, grips.
    const inView = mapVertices(selected.points, (q) => toView(q, g));
    shapes.push(...geometryShapes(inView, selected.closed, { selected: true, focused: c.focusedVertex ?? null, ids: PATH_IDS }));
  } else if (selected && c.tool.kind !== "draw") {
    shapes.push(...selectionShapes(courseMapObjectPageBounds(selected), objectHandles(selected), g, "editor-layout-selection"));
  }
  if (c.block && c.selection?.kind === "description") shapes.push(...selectionShapes(c.block, [], g, "editor-layout-selection"));
  if (c.block) shapes.push({ kind: "line", points: rectInView(c.block, g), closed: true, color: "transparent", widthPx: 0, testId: "editor-layout-description" });

  const placing = c.tool.kind === "place" ? c.tool : null;
  if (c.tool.kind === "draw" && c.draw) return drawBinding(c, c.tool.poly, c.draw, shapes);

  return {
    exclusive: true,
    cursor: placing ? "crosshair" : undefined,
    shapes,
    onPointerDown: (p) => {
      if (placing) return false;
      const page = toPage(p.pt, g);
      const tol = tolerance(p, g);
      if (selected?.kind === "path") {
        // A vertex or a grip; the edge falls through to the move below (topmost first, kept on the printable area).
        const d = pressGeometry(selected.points, pathRule(selected), { pt: page, reach: tol, alt: p.alt, shift: p.shift }, false);
        if (d && !(d.kind === "object" && d.vertex === null)) {
          c.gesture.current = { kind: "geometry", id: selected.id, base: selected, drag: d };
          return true;
        }
      } else if (selected) {
        const h = handleAt(page, objectHandles(selected), tol);
        if (h) {
          c.gesture.current = { kind: "resize", id: selected.id, handle: h, from: p.pt, base: selected, moved: false, proportional: p.shift };
          return true;
        }
      }
      const i = layoutObjectAt(page, c.editable, tol);
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
    onPointerDrag: (pt, mods) => {
      const gst = c.gesture.current;
      if (!gst) return;
      if (gst.kind === "geometry") {
        if (dragGeometry(gst.drag, geometryPoint(c, gst.drag, pt), mods)) c.onPreview(gestureChange(c, gst, pt));
        return;
      }
      gst.moved = true;
      c.onPreview(gestureChange(c, gst, pt));
    },
    onPointerUp: (pt) => {
      const gst = c.gesture.current;
      c.gesture.current = null;
      c.onPreview(null);
      if (gst?.kind === "geometry") {
        // A drag writes; a click focuses the vertex, Alt-click retracts its handles (§7 "Editing geometry").
        const r = releaseGeometry(gst.drag, pt ? geometryPoint(c, gst.drag, pt) : null, pathRule(gst.base));
        if (r?.kind === "commit") c.onCommit(pathChange(c, gst.base, r.geometry, movedVertex(gst.drag)));
        else if (r?.kind === "focus") c.onVertexFocus?.(r.index);
        return;
      }
      if (gst && pt && gst.moved) c.onCommit(gestureChange(c, gst, pt));
      // A click anywhere else unfocuses the vertex.
      else if (pt) c.onVertexFocus?.(null);
    },
    onDoubleClick: (p) => {
      // On the selected path's edge, off its vertices: a vertex there, focused.
      if (selected?.kind !== "path" || placing) return;
      const inserted = insertAtEdge(selected.points, pathRule(selected), toPage(p.pt, g), tolerance(p, g));
      if (!inserted) return;
      c.onVertexFocus?.(inserted.index);
      c.onCommit(pathChange(c, selected, inserted.geometry));
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

/**
 * `P` (D16): the course editor's area flow drawn in the viewer's paper mm
 * over the sheet, a vertex on the 1 mm page grid when snapping
 * (`toView ∘ gridSnap ∘ toPage`), the finished path mapped onto the page.
 */
function drawBinding(c: LayoutBindingContext, poly: PolygonState, d: NonNullable<LayoutBindingContext["draw"]>, sheet: readonly ToolShape[]): EditorToolBinding {
  const g = c.geometry;
  const flow = areaBinding({
    gesture: d.gesture, poly, hover: d.hover, onHover: d.onHover, onPoly: d.onPoly, onCancel: d.onCancel,
    snap: (pt) => (c.snapping ? toView(gridSnap(toPage(pt, g), true), g) : pt),
    onDone: (vertices) => d.onPath(pathFromView(vertices, g, g.printable)),
  });
  return { ...flow, shapes: [...sheet, ...(flow.shapes ?? [])] };
}
