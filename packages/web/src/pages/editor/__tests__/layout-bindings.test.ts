import { describe, expect, it, vi } from "vitest";
import type { CourseMapObject } from "@oxygen/shared";
import type { ToolPointer } from "../../../components/MapViewer";
import { sheetWindow, toView, type SheetGeometry } from "../../../lib/editor/layout";
import { LAYOUT_KEYS, layoutBinding, type LayoutBindingContext, type LayoutGesture } from "../layout/bindings";
import type { GestureRef } from "../tools/bindings";
import type { PolygonState } from "../tools/polygon";

// A4, frame 10 mm in, map at the print scale (1 page mm = 1 paper mm), centred on (0, 0): page (105, 148.5) is paper (0, 0).
const frame = { x: 10, y: 10, width: 190, height: 277 };
const g: SheetGeometry = {
  paper: { widthMm: 210, heightMm: 297 },
  printable: { x: 3, y: 3, width: 204, height: 291 },
  frame,
  window: sheetWindow(frame, { x: 0, y: 0 }, 10000, 10000),
};
const at = (x: number, y: number, over: Partial<ToolPointer> = {}): ToolPointer => ({ pt: toView({ x, y }, g), target: null, shift: false, mmPerPx: 0.1, ...over });
const view = (x: number, y: number) => toView({ x, y }, g);

const box: CourseMapObject = { id: "box", kind: "rectangle", anchor: "page", x: 50, y: 50, width: 30, height: 20, fillMode: "none" };
const logo: CourseMapObject = { id: "logo", kind: "image", anchor: "page", graphicId: 9, x: 150, y: 250, width: 30, height: 30 };

function ctx(over: Partial<Omit<LayoutBindingContext, "onPreview" | "onCommit" | "onSelect" | "onPlace">> = {}) {
  const gesture: { current: LayoutGesture } = { current: null };
  const fns = { onPreview: vi.fn(), onCommit: vi.fn(), onSelect: vi.fn(), onPlace: vi.fn() };
  const c: LayoutBindingContext = {
    geometry: g, editable: [box], locked: [logo], description: { visible: true, x: 140, y: 12, cellSizeMm: 6 }, block: { x: 140, y: 12, width: 48, height: 30 },
    centre: { x: 0, y: 0 }, selection: null, tool: { kind: "select" }, snapping: false, gesture, imageHref: (id: number) => `/img/${id}`,
    ...fns,
    ...over,
  };
  return { ...c, ...fns };
}

describe("Layout binding (docs/course-layout.md §2, §3; 08 §5.3 Layout column)", () => {
  it("the rail's keys: no white-out-outside tool (D14), the polygon stays", () => {
    expect(Object.keys(LAYOUT_KEYS)).toEqual(["V", "H", "T", "I", "D", "W", "L", "R", "P"]);
    expect(Object.values(LAYOUT_KEYS)).not.toContain("whiteoutOutside");
    expect(LAYOUT_KEYS.O).toBeUndefined();
  });

  it("is exclusive: course targets stay off, a drag on nothing pans", () => {
    const c = ctx();
    const b = layoutBinding(c);
    expect(b.exclusive).toBe(true);
    expect(b.onPointerDown!(at(120, 200))).toBe(false);
  });

  it("draws the sheet and the page images on the UI layer", () => {
    const shapes = layoutBinding(ctx()).shapes!;
    const ids = shapes.flatMap((s) => ("testId" in s && s.testId ? [s.testId] : []));
    expect(ids).toEqual(expect.arrayContaining(["editor-layout-paper", "editor-layout-printable", "editor-layout-frame", "editor-layout-image", "editor-layout-description"]));
    const img = shapes.find((s) => s.kind === "image")!;
    expect(img.kind === "image" && img.href).toBe("/img/9");
  });

  it("click on an object selects it; a drag moves it by the page offset and commits once", () => {
    const c = ctx();
    const b = layoutBinding(c);
    expect(b.onPointerDown!(at(60, 60))).toBe(true);
    expect(c.onSelect).toHaveBeenCalledWith({ kind: "object", id: "box" });
    b.onPointerDrag!(view(65, 58));
    const preview = c.onPreview.mock.calls[0][0];
    const moved = preview.objects[0] as Extract<CourseMapObject, { kind: "rectangle" }>;
    expect(moved.x).toBeCloseTo(55, 6);
    expect(moved.y).toBeCloseTo(48, 6);
    b.onPointerUp!(view(65, 58));
    expect(c.onPreview).toHaveBeenLastCalledWith(null);
    expect(c.onCommit).toHaveBeenCalledTimes(1);
  });

  it("a click without movement selects only; snapping moves in whole millimetres", () => {
    const c = ctx({ snapping: true });
    const b = layoutBinding(c);
    b.onPointerDown!(at(60, 60));
    b.onPointerUp!(view(60, 60));
    expect(c.onCommit).not.toHaveBeenCalled();
    b.onPointerDown!(at(60, 60));
    b.onPointerDrag!(view(62.4, 60.6));
    b.onPointerUp!(view(62.4, 60.6));
    const o = c.onCommit.mock.calls[0][0].objects[0] as Extract<CourseMapObject, { kind: "rectangle" }>;
    expect(o.x).toBeCloseTo(52, 6);
    expect(o.y).toBeCloseTo(51, 6);
  });

  it("the selected object's handle resizes it inside the printable area", () => {
    const c = ctx({ selection: { kind: "object", id: "box" } });
    const b = layoutBinding(c);
    expect(b.onPointerDown!(at(80, 70))).toBe(true);
    b.onPointerDrag!(view(300, 80));
    b.onPointerUp!(view(300, 80));
    const o = c.onCommit.mock.calls[0][0].objects[0] as Extract<CourseMapObject, { kind: "rectangle" }>;
    expect(o.x + o.width).toBeCloseTo(207, 6);
    expect(o.height).toBeCloseTo(30, 6);
  });

  it("template objects are locked in sheet scope: not taken, a click selects the frame", () => {
    const c = ctx();
    const b = layoutBinding(c);
    expect(b.onPointerDown!(at(160, 260))).toBe(false);
    b.onClick!(at(160, 260));
    expect(c.onSelect).toHaveBeenCalledWith({ kind: "frame" });
    b.onClick!(at(5, 5));
    expect(c.onSelect).toHaveBeenLastCalledWith(null);
  });

  it("align map: the selected frame dragged moves the window centre by the drag (paper mm)", () => {
    const c = ctx({ selection: { kind: "frame" }, centre: { x: 0, y: 0 } });
    const b = layoutBinding(c);
    expect(b.onPointerDown!(at(120, 200))).toBe(true);
    b.onPointerDrag!(view(130, 190));
    expect(c.onPreview.mock.calls[0][0].centre.x).toBeCloseTo(10, 6);
    expect(c.onPreview.mock.calls[0][0].centre.y).toBeCloseTo(10, 6);
    b.onPointerUp!(view(130, 190));
    expect(c.onCommit).toHaveBeenCalledWith({ centre: expect.objectContaining({ x: expect.closeTo(10, 6), y: expect.closeTo(10, 6) }) });
  });

  it("the block moves by its own drag, kept on the printable area", () => {
    const c = ctx();
    const b = layoutBinding(c);
    expect(b.onPointerDown!(at(150, 20))).toBe(true);
    expect(c.onSelect).toHaveBeenCalledWith({ kind: "description" });
    b.onPointerDrag!(view(200, 20));
    b.onPointerUp!(view(200, 20));
    const d = c.onCommit.mock.calls[0][0].description;
    expect(d.x).toBeCloseTo(207 - 48, 6);
    expect(d.y).toBeCloseTo(12, 6);
  });

  it("an armed placement tool: drag pans, a click places at the page point", () => {
    const c = ctx({ tool: { kind: "place", what: "image", graphicId: 9 } });
    const b = layoutBinding(c);
    expect(b.onPointerDown!(at(60, 60))).toBe(false);
    b.onClick!(at(40, 100));
    const [what, page, graphic] = c.onPlace.mock.calls[0];
    expect(what).toBe("image");
    expect(page.x).toBeCloseTo(40, 6);
    expect(page.y).toBeCloseTo(100, 6);
    expect(graphic).toBe(9);
  });
});

describe("P: polygons drawn with the course editor's area flow (D16, docs/course-layout.md §3)", () => {
  function drawing(poly: PolygonState, over: Partial<Omit<LayoutBindingContext, "onPreview" | "onCommit" | "onSelect" | "onPlace">> = {}) {
    const draw = { gesture: { current: null } as GestureRef, hover: null, onHover: vi.fn(), onPoly: vi.fn(), onPath: vi.fn(), onCancel: vi.fn() };
    const c = ctx({ tool: { kind: "draw", poly }, draw, ...over });
    return { c, draw, b: layoutBinding(c) };
  }
  const empty: PolygonState = { kind: "layout_path", vertices: [] };

  it("arms the polygon flow: exclusive, crosshair, the sheet still drawn under the preview", () => {
    const { b } = drawing({ kind: "layout_path", vertices: [view(40, 60), view(90, 60)] });
    expect(b.exclusive).toBe(true);
    expect(b.cursor).toBe("crosshair");
    const ids = b.shapes!.flatMap((s) => ("testId" in s && s.testId ? [s.testId] : []));
    expect(ids).toEqual(expect.arrayContaining(["editor-layout-paper", "editor-layout-frame", "editor-polygon", "editor-polygon-vertex"]));
  });

  it("a press places a vertex at the pointer; with the grid on, on whole page millimetres", () => {
    const { b, draw } = drawing(empty);
    expect(b.onPointerDown!(at(40.4, 60.3))).toBe(true);
    const v = draw.onPoly.mock.calls[0][0].vertices[0];
    expect(v.x).toBeCloseTo(view(40.4, 60.3).x, 9);
    const snapped = drawing(empty, { snapping: true });
    snapped.b.onPointerDown!(at(40.4, 60.6));
    const w = snapped.draw.onPoly.mock.calls[0][0].vertices[0];
    expect(w.x).toBeCloseTo(view(40, 61).x, 9);
    expect(w.y).toBeCloseTo(view(40, 61).y, 9);
  });

  it("a click on the first vertex closes: one path in page mm, handles mapped, vertices clamped", () => {
    // View mm here are page mm mirrored (y up): a handle 10 view mm up is 10 page mm up the page.
    const a = view(40, 60);
    const poly: PolygonState = { kind: "layout_path", vertices: [a, { ...view(90, 60), hOut: { x: 0, y: 10 }, hIn: { x: 0, y: -10 } }, view(300, 110)] };
    const { b, draw } = drawing(poly);
    expect(b.onPointerDown!(at(40, 60))).toBe(false);
    b.onClick!(at(40, 60));
    expect(draw.onPath).toHaveBeenCalledTimes(1);
    const pts = draw.onPath.mock.calls[0][0];
    expect(pts).toHaveLength(3);
    expect(pts[0].x).toBeCloseTo(40, 9);
    expect(pts[0].y).toBeCloseTo(60, 9);
    expect(pts[1].hOut.x).toBeCloseTo(0, 9);
    expect(pts[1].hOut.y).toBeCloseTo(-10, 9);
    expect(pts[2].x).toBeCloseTo(207, 9);
  });

  it("right-click cancels", () => {
    const { b, draw } = drawing(empty);
    b.onContextMenu!(at(50, 50));
    expect(draw.onCancel).toHaveBeenCalled();
  });
});

describe("V on a selected path: the course editor's geometry gestures (D16, docs/course-layout.md §3)", () => {
  type Path = Extract<CourseMapObject, { kind: "path" }>;
  const poly: Path = {
    id: "poly", kind: "path", anchor: "page", closed: true, fillMode: "none", stroke: "#000000", strokeWidthMm: 0.35,
    points: [{ x: 40, y: 60 }, { x: 90, y: 60, hIn: { x: -5, y: 0 }, hOut: { x: 5, y: 0 } }, { x: 90, y: 110 }, { x: 40, y: 110 }],
  };
  const edit = (over: Partial<Omit<LayoutBindingContext, "onPreview" | "onCommit" | "onSelect" | "onPlace">> = {}) => {
    const onVertexFocus = vi.fn();
    const c = ctx({ editable: [box, poly], selection: { kind: "object", id: "poly" }, onVertexFocus, ...over });
    return { c, onVertexFocus, b: layoutBinding(c) };
  };
  const committed = (c: ReturnType<typeof ctx>): Path => c.onCommit.mock.calls[c.onCommit.mock.calls.length - 1][0].objects.find((o: CourseMapObject) => o.id === "poly");

  it("draws the outline along its curves, a handle per vertex (focused active) and a grip per Bézier handle", () => {
    const { b } = edit({ focusedVertex: 2 });
    const shapes = b.shapes!;
    const outline = shapes.filter((s) => "testId" in s && s.testId === "editor-layout-selection");
    expect(outline).toHaveLength(1);
    expect(outline[0].kind === "line" && outline[0].points.length).toBeGreaterThan(4);
    const handles = shapes.filter((s) => s.kind === "handle" && s.testId === "editor-layout-handle");
    expect(handles).toHaveLength(4);
    expect(handles.find((h) => h.kind === "handle" && h.active)).toMatchObject({ data: { index: "2", focused: "true" } });
    expect(shapes.filter((s) => s.kind === "grip" && s.testId === "editor-layout-grip")).toHaveLength(2);
  });

  it("a vertex drag moves that vertex by the page offset, clamped to the printable area, in whole mm with the grid", () => {
    const { c, b } = edit({ snapping: true });
    expect(b.onPointerDown!(at(90, 110))).toBe(true);
    b.onPointerDrag!(view(95.4, 120.6));
    expect(c.onPreview.mock.calls[0][0].objects[1].points[2]).toEqual({ x: 95, y: 121 });
    b.onPointerUp!(view(400, 121));
    const o = committed(c);
    expect(o.points[2].x).toBeCloseTo(207, 9);
    expect(o.points.slice(0, 2)).toEqual(poly.points.slice(0, 2));
    expect(c.onCommit).toHaveBeenCalledTimes(1);
  });

  it("Alt-drag on a vertex pulls symmetric handles in page mm; Alt-click retracts them", () => {
    const { c, b } = edit();
    expect(b.onPointerDown!(at(40, 110, { alt: true }))).toBe(true);
    b.onPointerDrag!(view(40, 120), { shift: false, alt: true });
    b.onPointerUp!(view(40, 120));
    const o = committed(c);
    expect(o.points[3].hOut!.x).toBeCloseTo(0, 9);
    expect(o.points[3].hOut!.y).toBeCloseTo(10, 9);
    expect(o.points[3].hIn!.y).toBeCloseTo(-10, 9);
    const r = edit();
    r.b.onPointerDown!(at(90, 60, { alt: true }));
    r.b.onPointerUp!(view(90, 60));
    expect(committed(r.c).points[1]).toEqual({ x: 90, y: 60 });
  });

  it("a grip drag moves its handle, the mirrored pair kept; Alt held breaks it", () => {
    const { c, b } = edit();
    expect(b.onPointerDown!(at(95, 60))).toBe(true);
    b.onPointerDrag!(view(95, 64), { shift: false, alt: false });
    b.onPointerUp!(view(95, 64));
    const v = committed(c).points[1];
    expect(v.hOut!.y).toBeCloseTo(4, 9);
    expect(v.hIn!.y).toBeCloseTo(-4, 9);
    const r = edit();
    r.b.onPointerDown!(at(95, 60));
    r.b.onPointerDrag!(view(95, 64), { shift: false, alt: true });
    r.b.onPointerUp!(view(95, 64));
    expect(committed(r.c).points[1].hIn).toEqual({ x: -5, y: 0 });
  });

  it("a click on a vertex focuses it, without a write", () => {
    const { c, b, onVertexFocus } = edit();
    b.onPointerDown!(at(40, 110));
    b.onPointerUp!(view(40, 110));
    expect(onVertexFocus).toHaveBeenCalledWith(3);
    expect(c.onCommit).not.toHaveBeenCalled();
  });

  it("a double-click on an edge inserts a vertex there and focuses it; off the edge nothing", () => {
    const { c, b, onVertexFocus } = edit();
    b.onDoubleClick!(at(65, 110.2));
    expect(onVertexFocus).toHaveBeenCalledWith(3);
    const o = committed(c);
    expect(o.points).toHaveLength(5);
    expect(o.points[3].x).toBeCloseTo(65, 6);
    expect(o.points[3].y).toBeCloseTo(110, 6);
    const r = edit();
    r.b.onDoubleClick!(at(65, 85));
    expect(r.c.onCommit).not.toHaveBeenCalled();
  });

  it("the edge drags the whole path; a press inside the selected closed path pans", () => {
    const { c, b } = edit({ editable: [poly] });
    expect(b.onPointerDown!(at(65, 60))).toBe(true);
    b.onPointerDrag!(view(70, 65));
    b.onPointerUp!(view(70, 65));
    expect(committed(c).points[0]).toEqual({ x: 45, y: 65 });
    expect(committed(c).points[1].hOut).toEqual({ x: 5, y: 0 });
    expect(edit({ editable: [poly] }).b.onPointerDown!(at(65, 85))).toBe(false);
  });

  it("a map-anchored path is edited on the page and stored back in paper mm", () => {
    const mapPoly: Path = { ...poly, anchor: "map", points: poly.points.map((v) => ({ ...view(v.x, v.y), ...(v.hOut ? { hOut: { x: v.hOut.x, y: -v.hOut.y }, hIn: { x: v.hIn!.x, y: -v.hIn!.y } } : {}) })) };
    const { c, b } = edit({ editable: [mapPoly] });
    expect(b.onPointerDown!(at(90, 110))).toBe(true);
    b.onPointerDrag!(view(95, 115));
    b.onPointerUp!(view(95, 115));
    const p = committed(c).points[2];
    expect(p.x).toBeCloseTo(view(95, 115).x, 9);
    expect(p.y).toBeCloseTo(view(95, 115).y, 9);
  });
});
