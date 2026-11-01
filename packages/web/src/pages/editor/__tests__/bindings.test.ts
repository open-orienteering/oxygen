import { describe, expect, it, vi } from "vitest";
import type { course } from "@oxygen/shared";
import type { ToolPointer } from "../../../components/MapViewer";
import { areaBinding, gapBinding, placeBinding, selectBinding, type GestureRef } from "../tools/bindings";

const ptr = (x: number, y: number, over: Partial<ToolPointer> = {}): ToolPointer => ({ pt: { x, y }, target: null, shift: false, mmPerPx: 0.1, ...over });
const square = (id: number, kind: course.CourseObject["kind"] = "oob_area"): course.CourseObject =>
  ({ id, kind, geometry: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }], props: {}, scope: { all: true }, z: 0, version: "1", inCourses: null }) as course.CourseObject;

function selectOpts(over: Partial<Parameters<typeof selectBinding>[0]> = {}) {
  const gesture: GestureRef = { current: null };
  const o = {
    gesture, selected: null, objects: [square(4)], sites: [{ id: 31, x: 5, y: 5, kind: "control" as const }, { id: 32, x: 50, y: 50, kind: "control" as const }],
    multi: [], ringMm: 2.5, redraw: vi.fn(), onToggleMulti: vi.fn(), onLasso: vi.fn(), onSelectObject: vi.fn(), onObjectDraft: vi.fn(),
    onObjectMoved: vi.fn(), onLegDoubleClick: vi.fn(), ...over,
  };
  return o;
}

describe("V binding (docs/course-editor.md §6.5, §7)", () => {
  it("Shift-click on a site toggles it; a plain click is the viewer's", () => {
    const o = selectOpts();
    const b = selectBinding(o);
    expect(b.onPointerDown!(ptr(5, 5, { target: { kind: "site", id: "31" } }))).toBe(false);
    expect(b.onPointerDown!(ptr(5, 5, { target: { kind: "site", id: "31" }, shift: true }))).toBe(true);
    b.onPointerUp!({ x: 5, y: 5 });
    expect(o.onToggleMulti).toHaveBeenCalledWith(31);
  });

  it("Shift-drag on empty map lassos the controls inside", () => {
    const o = selectOpts();
    const b = selectBinding(o);
    expect(b.onPointerDown!(ptr(0, 0, { shift: true }))).toBe(true);
    for (const [x, y] of [[20, 0], [20, 20], [0, 20]]) b.onPointerDrag!({ x, y });
    b.onPointerUp!({ x: 0, y: 20 });
    expect(o.onLasso).toHaveBeenCalledWith([31]);
  });

  it("an object is selected on press; a drag moves it, a handle drag moves its vertex", () => {
    const o = selectOpts();
    expect(selectBinding(o).onPointerDown!(ptr(5, 5, { target: { kind: "object", id: 4 } }))).toBe(true);
    expect(o.onSelectObject).toHaveBeenCalledWith(4);

    const sel = selectOpts({ selected: square(4) });
    const b = selectBinding(sel);
    b.onPointerDown!(ptr(5, 5, { target: { kind: "object", id: 4 } }));
    b.onPointerDrag!({ x: 7, y: 5 });
    b.onPointerUp!({ x: 7, y: 5 });
    expect(sel.onObjectMoved).toHaveBeenCalledWith(4, [{ x: 2, y: 0 }, { x: 12, y: 0 }, { x: 12, y: 10 }, { x: 2, y: 10 }]);

    const v = selectOpts({ selected: square(4) });
    const bv = selectBinding(v);
    bv.onPointerDown!(ptr(10.3, 10.2)); // within the 7 px handle reach of (10, 10)
    bv.onPointerUp!({ x: 12, y: 12 });
    // No drag moved it past the threshold, so it never moved: a click on a handle.
    expect(v.onObjectMoved).not.toHaveBeenCalled();
    bv.onPointerDown!(ptr(10, 10));
    bv.onPointerDrag!({ x: 12, y: 13 });
    bv.onPointerUp!({ x: 12, y: 13 });
    expect(v.onObjectMoved).toHaveBeenCalledWith(4, [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 12, y: 13 }, { x: 0, y: 10 }]);
  });

  it("outlines filter regions and toner savers always, other objects when selected", () => {
    const shapes = selectBinding(selectOpts({ objects: [square(1), square(2, "filter_region")] })).shapes!;
    expect(shapes.filter((s) => s.testId === "editor-object-outline").map((s) => (s as { data?: Record<string, string> }).data?.["object-id"])).toEqual(["2"]);
  });

  it("double-click on a leg inserts", () => {
    const o = selectOpts();
    selectBinding(o).onDoubleClick!(ptr(1, 2, { target: { kind: "leg", courseId: "c", index: 3 } }));
    expect(o.onLegDoubleClick).toHaveBeenCalledWith({ kind: "leg", courseId: "c", index: 3 }, { x: 1, y: 2 });
  });
});

describe("armed and area bindings", () => {
  it("placement is exclusive: a click places, right-click exits, touch gets Place / Done", () => {
    const onPlace = vi.fn(), onExit = vi.fn();
    const b = placeBinding({ ghost: null, onHover: vi.fn(), onPlace, onExit, touch: { placeLabel: "Place", doneLabel: "Done" } });
    expect(b.exclusive).toBe(true);
    b.onClick!(ptr(1, 1));
    b.onContextMenu!(ptr(1, 1));
    expect(onPlace).toHaveBeenCalled();
    expect(onExit).toHaveBeenCalled();
    expect(b.touch?.placeLabel).toBe("Place");
  });

  it("the ghost draws a true-size circle, its label and the pending legs", () => {
    const b = placeBinding({
      ghost: { at: { x: 1, y: 1 }, radiusMm: 2.5, role: "control", label: "3 · 47", description: "boulder", legs: [[{ x: 0, y: 0 }, { x: 1, y: 1 }]] },
      onHover: vi.fn(), onPlace: vi.fn(), onExit: vi.fn(), touch: null,
    });
    const ids = b.shapes!.map((s) => s.testId);
    expect(ids).toEqual(expect.arrayContaining(["editor-ghost", "editor-ghost-label", "editor-ghost-description", "editor-pending-leg"]));
    expect(b.shapes!.find((s) => s.testId === "editor-ghost")).toMatchObject({ kind: "circle", rMm: 2.5 });
  });

  it("the area flow: clicks add vertices, the first vertex closes, a vertex is dragged before closing", () => {
    const gesture: GestureRef = { current: null };
    const onPoly = vi.fn(), onDone = vi.fn();
    const poly = { kind: "oob_area" as const, vertices: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }] };
    const b = areaBinding({ gesture, poly, hover: null, onHover: vi.fn(), onPoly, onDone, onCancel: vi.fn(), snap: (p) => p });
    expect(b.onPointerDown!(ptr(10, 0.2))).toBe(true); // vertex 1
    b.onPointerDrag!({ x: 11, y: 1 });
    expect(onPoly).toHaveBeenCalledWith({ kind: "oob_area", vertices: [{ x: 0, y: 0 }, { x: 11, y: 1 }, { x: 10, y: 10 }] });
    b.onPointerUp!({ x: 11, y: 1 });
    expect(b.onPointerDown!(ptr(0.1, 0.1))).toBe(false); // the first vertex is a click, not a drag
    b.onClick!(ptr(0.1, 0.1));
    expect(onDone).toHaveBeenCalledWith(poly.vertices);
  });
});

describe("G binding (§6.3)", () => {
  const circle = { kind: "circle" as const, siteId: 31, centre: { x: 0, y: 0 }, radiusMm: 3, gaps: [{ start: 100, end: 120 }] };

  it("a rim drag adds a gap; off the rim nothing is taken", () => {
    const onAdd = vi.fn();
    const gesture: GestureRef = { current: null };
    const b = gapBinding({ gesture, target: circle, redraw: vi.fn(), onAdd, onRemove: vi.fn(), onExit: vi.fn() });
    expect(b.onPointerDown!(ptr(0, 0))).toBe(false);
    expect(b.onPointerDown!(ptr(0, 3))).toBe(true); // north on the rim
    b.onPointerDrag!({ x: 3, y: 0 });
    b.onPointerUp!({ x: 3, y: 0 });
    expect(onAdd).toHaveBeenCalledWith({ start: 0, end: 90 });
  });

  it("a click on a gap removes it", () => {
    const onRemove = vi.fn();
    const gesture: GestureRef = { current: null };
    const b = gapBinding({ gesture, target: circle, redraw: vi.fn(), onAdd: vi.fn(), onRemove, onExit: vi.fn() });
    const at = { x: 3 * Math.sin((110 * Math.PI) / 180), y: 3 * Math.cos((110 * Math.PI) / 180) };
    b.onPointerDown!(ptr(at.x, at.y));
    b.onPointerUp!(at);
    expect(onRemove).toHaveBeenCalledWith(0);
  });

  it("leg gaps by fraction", () => {
    const onAdd = vi.fn();
    const gesture: GestureRef = { current: null };
    const b = gapBinding({ gesture, target: { kind: "leg", itemIndex: 2, a: { x: 0, y: 0 }, b: { x: 100, y: 0 }, gaps: [] }, redraw: vi.fn(), onAdd, onRemove: vi.fn(), onExit: vi.fn() });
    expect(b.onPointerDown!(ptr(40, 0.5))).toBe(true);
    b.onPointerUp!({ x: 60, y: 0 });
    expect(onAdd).toHaveBeenCalledWith({ from: 0.4, to: 0.6 });
  });
});
