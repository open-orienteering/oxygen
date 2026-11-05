/**
 * Layout mode's page-space maths (docs/course-layout.md §1–3): the sheet
 * drawn over the map in the viewer's paper mm (the map's own space, y-up),
 * page mm (y-down from the paper's top-left) through the sheet's frame and
 * window (`mapToPage` / `pageToMap`, the print's `T_map`), the UI-layer
 * shapes of the sheet, hit-testing of layout objects and their handles,
 * and align map. Pure; the bindings in `pages/editor/layout/` use it.
 */

import {
  courseMapObjectPageBounds,
  descriptionBlockSize,
  mapToPage,
  mapWindowForFrame,
  pageToMap,
  type CourseMapObject,
  type DescriptionBlockSettings,
  type MapRect,
  type MapWindow,
} from "@oxygen/shared";
import type { ToolShape } from "../../components/MapViewer";
import { clampPagePoint, type ResizeHandle } from "../map-layout-editor";
import { mapVertices, nearestEdge, vertexRule, type Vertex } from "./geometry-edit";

type Pt = { x: number; y: number };

/** The page as Layout mode lays it over the map. */
export interface SheetGeometry {
  paper: { widthMm: number; heightMm: number };
  /** Printable area, page mm. */
  printable: MapRect;
  /** Map frame, page mm. */
  frame: MapRect;
  window: MapWindow;
}

/** A page point (page mm, y-down) in the viewer's paper mm. */
export const toView = (p: Pt, g: Pick<SheetGeometry, "frame" | "window">): Pt => pageToMap(p, g.frame, g.window);
/** A viewer point (paper mm) on the page. */
export const toPage = (p: Pt, g: Pick<SheetGeometry, "frame" | "window">): Pt => mapToPage(p, g.frame, g.window);
/** Page mm per paper mm of the map: the print's scale ratio (`mapScale / printScale`). */
export const pagePerView = (g: Pick<SheetGeometry, "frame" | "window">): number => g.frame.width / g.window.width;

/**
 * The window of a sheet: centred on `centre` (paper mm), the frame's size at
 * the print scale, the meridian rotation of the resolved window kept.
 */
export function sheetWindow(frame: MapRect, centre: Pt, mapScale: number | null, printScale: number, rotationDeg = 0): MapWindow {
  return mapWindowForFrame(frame, centre, mapScale ?? printScale, printScale, rotationDeg);
}

export const windowCentre = (w: MapWindow): Pt => ({ x: w.minX + w.width / 2, y: w.minY + w.height / 2 });

/** A page rectangle's corners in paper mm (a rotated window turns it). */
export function rectInView(r: MapRect, g: Pick<SheetGeometry, "frame" | "window">): Pt[] {
  return [
    { x: r.x, y: r.y }, { x: r.x + r.width, y: r.y }, { x: r.x + r.width, y: r.y + r.height }, { x: r.x, y: r.y + r.height },
  ].map((p) => toView(p, g));
}

const GREY = "#cbd5e1";
const FRAME = "#7c3aed";
/** How far the grey surround reaches beyond the paper, page mm. */
const SURROUND_MM = 5000;

/**
 * The sheet as UI-layer shapes (docs/course-layout.md §1): the grey outside
 * the paper (four bands, so the map never shows off the paper), the paper
 * edge, the printable margin dashed, the map frame (purple when selected).
 * The map outside the frame is not drawn at all (the renderer's clip), so
 * the paper between frame and edge is white, as printed.
 */
export function sheetShapes(g: SheetGeometry, frameSelected: boolean): ToolShape[] {
  const W = g.paper.widthMm, H = g.paper.heightMm, S = SURROUND_MM;
  const bands: MapRect[] = [
    { x: -S, y: -S, width: W + 2 * S, height: S },
    { x: -S, y: H, width: W + 2 * S, height: S },
    { x: -S, y: 0, width: S, height: H },
    { x: W, y: 0, width: S, height: H },
  ];
  return [
    ...bands.map((b): ToolShape => ({ kind: "line", points: rectInView(b, g), closed: true, fill: GREY, color: GREY, widthPx: 0 })),
    { kind: "line", points: rectInView({ x: 0, y: 0, width: W, height: H }, g), closed: true, color: "#64748b", widthPx: 1, testId: "editor-layout-paper" },
    { kind: "line", points: rectInView(g.printable, g), closed: true, dashed: true, color: "#ef4444", widthPx: 1, testId: "editor-layout-printable" },
    {
      kind: "line", points: rectInView(g.frame, g), closed: true, color: FRAME, widthPx: frameSelected ? 2.5 : 1, ...(frameSelected ? {} : { dashed: true }),
      testId: "editor-layout-frame", data: { selected: String(frameSelected) },
    },
  ];
}

/** The description block's rectangle on the page. */
export function descriptionRect(d: DescriptionBlockSettings, rowCount: number, headerRows: number): MapRect {
  const s = descriptionBlockSize(rowCount, d.cellSizeMm, headerRows);
  return { x: d.x, y: d.y, width: s.width, height: s.height };
}

const inRect = (p: Pt, r: MapRect, tol = 0) => p.x >= r.x - tol && p.x <= r.x + r.width + tol && p.y >= r.y - tol && p.y <= r.y + r.height + tol;

/** Distance from `p` to the segment a–b. */
function segmentDistance(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len = dx * dx + dy * dy;
  const t = len === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** A path's vertices on the page (page mm): a map-anchored path's through the window, handles as offsets. */
export function pagePoints(o: Extract<CourseMapObject, { kind: "path" }>, g: Pick<SheetGeometry, "frame" | "window">): Vertex[] {
  return o.anchor === "page" ? o.points : mapVertices(o.points, (q) => toPage(q, g));
}

/** What a Layout path allows: a closed one is the polygon (`P`, three or more vertices), an open one a line (two or more); both curve. */
export const pathRule = (o: Extract<CourseMapObject, { kind: "path" }>) => vertexRule(o.closed ? "layout_path" : "oob_line");

/** Page points back in the path's own space (page mm, or paper mm for a map-anchored path). */
export function nativePoints(o: Extract<CourseMapObject, { kind: "path" }>, points: readonly Vertex[], g: Pick<SheetGeometry, "frame" | "window">): Vertex[] {
  return o.anchor === "page" ? [...points] : mapVertices(points, (q) => toView(q, g));
}

/**
 * A path drawn in the viewer's paper mm (the course editor's area flow,
 * docs/course-layout.md §3 `P`) on the page: vertices and handles mapped
 * affinely, each vertex clamped to the printable area.
 */
export function pathFromView(vertices: readonly Vertex[], g: Pick<SheetGeometry, "frame" | "window">, printable: MapRect): Vertex[] {
  return mapVertices(vertices, (q) => toPage(q, g)).map((v) => ({ ...v, ...clampPagePoint(v, printable) }));
}

/**
 * The topmost layout object under a page point (the last in draw order
 * wins): text, rectangles and images by their bounds, lines within `tolMm`
 * of the segment, paths within `tolMm` of their outline along its curves —
 * a closed path never by its inside, as the course editor's areas (D16,
 * docs/course-layout.md §3), so a press inside one reaches what is under
 * it, or pans. −1 for none.
 */
export function layoutObjectAt(p: Pt, objects: readonly CourseMapObject[], g: Pick<SheetGeometry, "frame" | "window">, tolMm: number): number {
  for (let i = objects.length - 1; i >= 0; i--) {
    const o = objects[i];
    if (o.kind === "line") {
      const page = (q: Pt) => (o.anchor === "page" ? q : toPage(q, g));
      if (segmentDistance(p, page({ x: o.x1, y: o.y1 }), page({ x: o.x2, y: o.y2 })) <= tolMm) return i;
      continue;
    }
    if (o.kind === "path") {
      const edge = nearestEdge(pagePoints(o, g), o.closed, p);
      if (edge && edge.dist <= tolMm) return i;
      continue;
    }
    const b = courseMapObjectPageBounds(o, g.frame, g.window);
    if (b && inRect(p, b, tolMm)) return i;
  }
  return -1;
}

/** An object's resize handles on the page (`resizeMapObject`'s handle names). */
export function objectHandles(o: CourseMapObject, g: Pick<SheetGeometry, "frame" | "window">): { handle: ResizeHandle; at: Pt }[] {
  const page = (q: Pt) => (o.anchor === "page" ? q : toPage(q, g));
  if (o.kind === "line") return [{ handle: "start", at: page({ x: o.x1, y: o.y1 }) }, { handle: "end", at: page({ x: o.x2, y: o.y2 }) }];
  if (o.kind === "path") return o.points.map((v, i) => ({ handle: `vertex-${i}` as ResizeHandle, at: page(v) }));
  const b = courseMapObjectPageBounds(o, g.frame, g.window);
  if (!b) return [];
  return [
    { handle: "nw", at: { x: b.x, y: b.y } }, { handle: "ne", at: { x: b.x + b.width, y: b.y } },
    { handle: "sw", at: { x: b.x, y: b.y + b.height } }, { handle: "se", at: { x: b.x + b.width, y: b.y + b.height } },
  ];
}

/** The handle within `tolMm` of a page point, nearest first. */
export function handleAt(p: Pt, handles: readonly { handle: ResizeHandle; at: Pt }[], tolMm: number): ResizeHandle | null {
  let best: ResizeHandle | null = null, bestD = tolMm;
  for (const h of handles) {
    const d = Math.hypot(h.at.x - p.x, h.at.y - p.y);
    if (d <= bestD) { best = h.handle; bestD = d; }
  }
  return best;
}

/** A page rectangle's outline and its four corner handles as UI shapes (the selection). */
export function selectionShapes(r: MapRect, handles: readonly { handle: ResizeHandle; at: Pt }[], g: Pick<SheetGeometry, "frame" | "window">, testId: string): ToolShape[] {
  return [
    { kind: "line", points: rectInView(r, g), closed: true, color: "#2563eb", dashed: true, widthPx: 1.5, testId },
    ...handles.map((h): ToolShape => ({ kind: "handle", ...toView(h.at, g), testId: "editor-layout-handle", data: { handle: h.handle } })),
  ];
}

/**
 * Align map (08 §4.6; docs/course-layout.md §4): dragging the selected frame
 * moves the sheet over the map, so the window centre follows the pointer —
 * the paper-mm offset of the drag, whatever the window's rotation.
 */
export function alignedCentre(centre: Pt, from: Pt, to: Pt): Pt {
  return { x: centre.x + (to.x - from.x), y: centre.y + (to.y - from.y) };
}

/** A page offset (page mm) of a drag from `from` to `to` (paper mm). */
export function pageDelta(from: Pt, to: Pt, g: Pick<SheetGeometry, "frame" | "window">): Pt {
  const a = toPage(from, g), b = toPage(to, g);
  return { x: b.x - a.x, y: b.y - a.y };
}

/** The 1 mm grid of Layout mode's snapping (08 §5.3), page mm. */
export function gridSnap(p: Pt, on: boolean): Pt {
  return on ? { x: Math.round(p.x), y: Math.round(p.y) } : p;
}

/** The paper's bounds in paper mm: `F` fits the page. */
export function pageBounds(g: SheetGeometry): { minX: number; minY: number; maxX: number; maxY: number } {
  const c = rectInView({ x: 0, y: 0, width: g.paper.widthMm, height: g.paper.heightMm }, g);
  return {
    minX: Math.min(...c.map((p) => p.x)), maxX: Math.max(...c.map((p) => p.x)),
    minY: Math.min(...c.map((p) => p.y)), maxY: Math.max(...c.map((p) => p.y)),
  };
}
