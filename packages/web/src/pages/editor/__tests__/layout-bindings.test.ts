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
