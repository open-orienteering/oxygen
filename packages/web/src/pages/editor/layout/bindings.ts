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
  alignedCentre, gridSnap, handleAt, isTurnable, layoutObjectAt, objectHandles, objectPivot, objectRing, pageDelta, pagePerView, pathFromView,
  pathRule, rectInView, ringShapes, selectionShapes, sheetShapes, toPage, toView, upOf, type SheetGeometry, type TurnedObject,
} from "../../../lib/editor/layout";
import {
  cropEdge, edgeHandles, knobBase, resizeBox, rotationAt, ROTATE_STEM_PX, uncroppedRing, type BoxEdge,
} from "../../../lib/editor/transform-gestures";
import { stylePatch } from "../../../lib/editor/style-fields";
import { rectOfStyleGeometry, styleChangeOf, styleGeometryOf } from "./model";
import { clampPagePoint, constrainDescription, constrainMapObjectExtent, resizeMapObject, translateMapObject, type ResizeHandle } from "../../../lib/map-layout-editor";
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
  | { kind: "resize"; id: string; handle: ResizeHandle; from: Pt; base: CourseMapObject; moved: boolean }
  /** A rectangle's or image's corner in its own frame (J9): the opposite drawn corner fixed; `lock` the press's, Shift live. */
  | { kind: "box"; id: string; corner: number; base: Extract<CourseMapObject, { kind: "rectangle" | "image" }>; lock: boolean; shift: boolean; to: Pt; moved: boolean }
  /** The rotate knob (J9): the pointer's turn about the pivot from `press` (page mm), Shift snapping to 15°. */
  | { kind: "rotate"; id: string; base: TurnedObject; press: Pt; shift: boolean; to: Pt; moved: boolean }
  /** A crop edge of the image in crop mode (J9). */
  | { kind: "crop"; id: string; edge: BoxEdge; base: Extract<CourseMapObject, { kind: "image" }>; to: Pt; moved: boolean }
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
  /** An image corner drag keeps the ratio while on; Shift inverts it (J8; live during the drag, J9). */
  aspectLock?: boolean;
  /** The image in crop mode (J9): its edges crop, its corners and knob are hidden. */
  cropMode?: string | null;
  onCropMode?: (id: string | null) => void;
  gesture: { current: LayoutGesture };
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
  if (g.kind === "box" || g.kind === "rotate" || g.kind === "crop") {
    const next = transformed(c, g);
    return { objects: c.editable.map((o) => (o.id === g.id ? next : o)) };
  }
  const d = step(pageDelta(g.from, to, c.geometry), c.snapping);
  if (g.kind === "description") {
    const b = c.block;
    return { description: constrainDescription({ ...g.base, x: g.base.x + d.x, y: g.base.y + d.y }, b?.width ?? 0, b?.height ?? 0, printable) };
  }
  // A move keeps the object on the page as drawn (a turned box by its turned extent, J9 review (3)); a turned
  // text's corner is taken into its frame and, as a turned box's, not clamped.
  const turnedText = g.base.kind === "text" && !!(g.base.rotationDeg ?? 0);
  const next = g.kind === "move"
    ? constrainMapObjectExtent(translateMapObject(g.base, d.x, d.y), printable)
    : resizeMapObject(g.base, g.handle, ...turnedDelta(g.base, d), turnedText ? {} : { printable });
  return { objects: c.editable.map((o) => (o.id === g.id ? next : o)) };
}

/** A drag's page offset in a turned text's own frame (its handles sit on the turned corners, J9). */
function turnedDelta(o: CourseMapObject, d: Pt): [number, number] {
  const deg = o.kind === "text" ? o.rotationDeg ?? 0 : 0;
  if (!deg) return [d.x, d.y];
  const r = (-deg * Math.PI) / 180, cos = Math.cos(r), sin = Math.sin(r);
  // y-up turn by −deg (the inverse of the drawn turn), back to y-down.
  const u = upOf(d);
  return [u.x * cos + u.y * sin, -(-u.x * sin + u.y * cos)];
}

/** The box ring's corner index (`boxRing`: sw, se, ne, nw on the page) of a resize handle. */
const CORNER: Partial<Record<ResizeHandle, number>> = { sw: 0, se: 1, ne: 2, nw: 3 };

/** Layout's smallest box side, page mm (as `resizeMapObject`'s). */
const MIN_BOX_MM = 2;

/** The object a box, rotate or crop drag leaves (J9, docs/course-layout.md §3 "Transform handles"). */
function transformed(c: Pick<LayoutBindingContext, "geometry" | "snapping">, g: Extract<NonNullable<LayoutGesture>, { kind: "box" | "rotate" | "crop" }>): CourseMapObject {
  const { printable } = c.geometry;
  if (g.kind === "rotate") {
    const deg = rotationAt(g.base.rotationDeg ?? 0, upOf(objectPivot(g.base)), upOf(g.press), upOf(g.to), g.shift);
    // Kept on the printable area by the drawn extent, as the rotation field (J8 review (1)).
    return styleChangeOf(g.base, { props: stylePatch(g.base, { rotationDeg: deg }) }, printable);
  }
  if (g.kind === "crop") {
    const r = cropEdge(styleGeometryOf(g.base)!, g.base, g.edge, upOf(g.to));
    return styleChangeOf(g.base, { props: stylePatch(g.base, { crop: r.crop }), geometry: r.geometry }, printable);
  }
  const deg = g.base.rotationDeg ?? 0;
  // An unturned box: the corner on the printable area and the 1 mm grid, as before. A turned one is not clamped
  // (validation flags a corner off the page, `object_outside_page`).
  const lock = g.lock !== g.shift;
  const pt = deg ? g.to : gridSnap(clampPagePoint(g.to, printable), c.snapping);
  const r = rectOfStyleGeometry(resizeBox(styleGeometryOf(g.base)!, deg, g.corner, upOf(pt), lock, MIN_BOX_MM));
  return { ...g.base, ...(deg ? r : keptOnPage(r, g.corner, lock, printable)) };
}

/**
 * An unturned box resized from corner `corner` kept on the printable area, its opposite corner fixed: a locked
 * resize projects the pointer onto the diagonal, so the corner can pass the margin though the pointer did not; the
 * box is scaled back whole (the ratio kept), an unlocked one side by side (J9 review (1)).
 */
function keptOnPage(r: MapRect, corner: number, lock: boolean, printable: MapRect): MapRect {
  // `boxRing`'s page corners: sw 0, se 1, ne 2, nw 3; the dragged side's direction on the page.
  const right = corner === 1 || corner === 2, down = corner === 0 || corner === 1;
  const fx = right ? r.x : r.x + r.width, fy = down ? r.y : r.y + r.height;
  const maxW = right ? printable.x + printable.width - fx : fx - printable.x;
  const maxH = down ? printable.y + printable.height - fy : fy - printable.y;
  let w = r.width, h = r.height;
  if (lock) {
    const k = Math.min(1, maxW / w, maxH / h);
    w *= k;
    h *= k;
  } else {
    w = Math.min(w, maxW);
    h = Math.min(h, maxH);
  }
  return { x: right ? fx : fx - w, y: down ? fy : fy - h, width: w, height: h };
}

/**
 * The pointer on the page for a geometry drag: a vertex moved with the grid on goes in whole millimetres from where
 * it was (the offset snapped, as a move); handles are free.
 */
function geometryPoint(c: Pick<LayoutBindingContext, "geometry" | "snapping">, d: GeometryDrag, to: Pt): Pt {
  const page = toPage(to, c.geometry);
  if (!c.snapping || d.kind !== "object" || d.vertex === null) return page;
  return { x: d.from.x + Math.round(page.x - d.from.x), y: d.from.y + Math.round(page.y - d.from.y) };
}

/** The vertex a drag moves (Alt or not, F18), −1 for none. */
const movedVertex = (d: GeometryDrag): number => (d.kind === "object" && d.vertex !== null ? d.vertex : -1);

/** The scope's objects with the path's page points stored; the `moved` vertex kept on the printable area. */
function pathChange(c: Pick<LayoutBindingContext, "geometry" | "editable">, base: PathObject, points: readonly Vertex[], moved = -1): LayoutChange {
  const page = points.map((v, i) => (i === moved ? { ...v, ...clampPagePoint(v, c.geometry.printable) } : v));
  const next: PathObject = { ...base, points: page };
  return { objects: c.editable.map((o) => (o.id === base.id ? next : o)) };
}

const PATH_IDS = { outline: "editor-layout-selection", handle: "editor-layout-handle", grip: "editor-layout-grip" };

/** The handle tolerance in page mm at the current zoom. */
const tolerance = (p: ToolPointer, g: SheetGeometry) => HANDLE_PX * p.mmPerPx * pagePerView(g);

export function layoutBinding(c: LayoutBindingContext): EditorToolBinding {
  const g = c.geometry;
  const selected = c.selection?.kind === "object" ? c.editable.find((o) => o.id === (c.selection as { id: string }).id) ?? null : null;

  // Images are drawn by the map engine with the page layer (J6), not on the UI layer.
  const shapes: ToolShape[] = [...sheetShapes(g, c.selection?.kind === "frame")];
  if (selected?.kind === "path" && c.tool.kind !== "draw") {
    // The course editor's selected path (§7 "Editing geometry"): its outline along the curves, handles, grips.
    const inView = mapVertices(selected.points, (q) => toView(q, g));
    shapes.push(...geometryShapes(inView, selected.closed, { selected: true, focused: c.focusedVertex ?? null, ids: PATH_IDS }));
  } else if (selected && isTurnable(selected) && c.tool.kind !== "draw") {
    // The drawn (turned) box, its corners and the rotate knob (J9); in crop mode the edges and the whole graphic.
    const ring = objectRing(selected);
    if (selected.kind === "image" && c.cropMode === selected.id) {
      const full = uncroppedRing(styleGeometryOf(selected)!, selected).map(upOf);
      shapes.push({ kind: "line", points: full.map((q) => toView(q, g)), closed: true, color: "#94a3b8", dashed: true, widthPx: 1, testId: "editor-layout-crop-full" });
      shapes.push(...ringShapes(ring, [], g, "editor-layout-selection"));
      for (const h of edgeHandles(ring.map(upOf))) shapes.push({ kind: "handle", ...toView(upOf(h.at), g), testId: "editor-layout-crop-edge", data: { edge: h.edge } });
    } else {
      shapes.push(...ringShapes(ring, objectHandles(selected), g, "editor-layout-selection"));
      const k = knobBase(ring.map(upOf));
      shapes.push({
        kind: "grip", from: toView(upOf(k.at), g), ...toView(upOf({ x: k.at.x + k.normal.x, y: k.at.y + k.normal.y }), g),
        lengthPx: ROTATE_STEM_PX, testId: "editor-layout-rotate",
      });
    }
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
      } else if (selected && selected.kind === "image" && c.cropMode === selected.id) {
        // Crop mode (J9): the edges only; the body still moves below.
        const ring = objectRing(selected).map(upOf);
        const up = upOf(page);
        const e = edgeHandles(ring).find((h) => Math.hypot(h.at.x - up.x, h.at.y - up.y) <= tol);
        if (e) {
          c.gesture.current = { kind: "crop", id: selected.id, edge: e.edge, base: selected, to: page, moved: false };
          return true;
        }
      } else if (selected) {
        if (isTurnable(selected)) {
          // The knob first: it sits outside the box, a fixed screen distance above its top edge.
          const k = knobBase(objectRing(selected).map(upOf));
          const stem = ROTATE_STEM_PX * p.mmPerPx * pagePerView(g);
          const knob = upOf({ x: k.at.x + k.normal.x * stem, y: k.at.y + k.normal.y * stem });
          if (Math.hypot(knob.x - page.x, knob.y - page.y) <= tol) {
            c.gesture.current = { kind: "rotate", id: selected.id, base: selected, press: page, shift: !!p.shift, to: page, moved: false };
            return true;
          }
        }
        const h = handleAt(page, objectHandles(selected), tol);
        if (h) {
          const corner = CORNER[h];
          if ((selected.kind === "rectangle" || selected.kind === "image") && corner !== undefined) {
            // The aspect lock is the image's (on by default); a rectangle has none, so Shift alone keeps its ratio.
            const lock = selected.kind === "image" ? c.aspectLock ?? false : false;
            c.gesture.current = { kind: "box", id: selected.id, corner, base: selected, lock, shift: !!p.shift, to: page, moved: false };
          } else {
            c.gesture.current = { kind: "resize", id: selected.id, handle: h, from: p.pt, base: selected, moved: false };
          }
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
      if (gst.kind === "box" || gst.kind === "rotate" || gst.kind === "crop") {
        gst.to = toPage(pt, g);
        // Shift is read live (J9): pressed or let go mid-drag, the lock or the snap follows.
        if (mods && gst.kind !== "crop") gst.shift = mods.shift;
      }
      c.onPreview(gestureChange(c, gst, pt));
    },
    onPointerUp: (pt) => {
      const gst = c.gesture.current;
      c.gesture.current = null;
      c.onPreview(null);
      if (gst?.kind === "geometry") {
        // A drag writes; a click focuses the vertex, Alt-click toggles it corner / smooth (§7 "Editing geometry").
        const r = releaseGeometry(gst.drag, pt ? geometryPoint(c, gst.drag, pt) : null, pathRule(gst.base));
        if (r?.kind === "commit") c.onCommit(pathChange(c, gst.base, r.geometry, movedVertex(gst.drag)));
        else if (r?.kind === "focus") c.onVertexFocus?.(r.index);
        return;
      }
      if (gst && pt && gst.moved) {
        if (gst.kind === "box" || gst.kind === "rotate" || gst.kind === "crop") gst.to = toPage(pt, g);
        c.onCommit(gestureChange(c, gst, pt));
      }
      // A click anywhere else unfocuses the vertex.
      else if (pt) c.onVertexFocus?.(null);
    },
    onDoubleClick: (p) => {
      if (placing) return;
      // On the selected image: crop mode (J9).
      if (selected?.kind === "image" && c.cropMode !== selected.id && layoutObjectAt(toPage(p.pt, g), [selected], 0) === 0) {
        c.onCropMode?.(selected.id);
        return;
      }
      // On the selected path's edge, off its vertices: a smooth vertex there (Alt: a corner), focused.
      if (selected?.kind !== "path") return;
      const inserted = insertAtEdge(selected.points, pathRule(selected), toPage(p.pt, g), tolerance(p, g), !!p.alt);
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
