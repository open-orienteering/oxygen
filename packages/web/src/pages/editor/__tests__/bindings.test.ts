import { describe, expect, it, vi } from "vitest";
import type { course } from "@oxygen/shared";
import type { ToolPointer, ToolShape } from "../../../components/MapViewer";
import { areaBinding, crossingGhost, gapBinding, pickSymbolBinding, placeBinding, scaleAbout, selectBinding, withCorridorGuides, type GestureRef } from "../tools/bindings";
import { railKeyOf } from "../tools/rail";

const ptr = (x: number, y: number, over: Partial<ToolPointer> = {}): ToolPointer => ({ pt: { x, y }, target: null, shift: false, mmPerPx: 0.1, ...over });
const square = (id: number, kind: course.CourseObject["kind"] = "oob_area"): course.CourseObject =>
  ({ id, kind, geometry: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }], props: {}, scope: { all: true }, z: 0, version: "1", inCourses: null }) as course.CourseObject;

function selectOpts(over: Partial<Parameters<typeof selectBinding>[0]> = {}) {
  const gesture: GestureRef = { current: null };
  const o = {
    gesture, selected: null, objects: [square(4)], sites: [{ id: 31, x: 5, y: 5, kind: "control" as const }, { id: 32, x: 50, y: 50, kind: "control" as const }],
    multi: [], ringMm: 2.5, redraw: vi.fn(), onToggleMulti: vi.fn(), onLasso: vi.fn(), onSelectObject: vi.fn(), onObjectDraft: vi.fn(),
    onObjectMoved: vi.fn(), onLegDoubleClick: vi.fn(), onVertexFocus: vi.fn(), ...over,
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

  // A closed area's target is its outline (the hit-test answers null inside it, §5): presses here are on its edge.
  it("an object is selected on press; a drag moves it, a handle drag moves its vertex", () => {
    const o = selectOpts();
    expect(selectBinding(o).onPointerDown!(ptr(5, 0, { target: { kind: "object", id: 4 } }))).toBe(true);
    expect(o.onSelectObject).toHaveBeenCalledWith(4);

    const sel = selectOpts({ selected: square(4) });
    const b = selectBinding(sel);
    b.onPointerDown!(ptr(5, 0, { target: { kind: "object", id: 4 } }));
    b.onPointerDrag!({ x: 7, y: 0 });
    b.onPointerUp!({ x: 7, y: 0 });
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

  it("a drag applies its offset to the geometry at pointer-down, not to the draft the page already shows", () => {
    // The page rebuilds the binding on every render with the draft applied to `objects`;
    // a drag that re-read it would move by the whole offset again on every event.
    const gesture: GestureRef = { current: null };
    const drafts = new Map<number, course.CourseObject["geometry"]>();
    const opts = () => selectOpts({
      gesture, selected: square(4), objects: [drafts.has(4) ? { ...square(4), geometry: drafts.get(4)! } : square(4)],
      onObjectDraft: vi.fn((id, g) => { if (g) drafts.set(id, g); else drafts.delete(id); }),
    });
    let o = opts();
    selectBinding(o).onPointerDown!(ptr(5, 0, { target: { kind: "object", id: 4 } }));
    selectBinding(o).onPointerDrag!({ x: 6, y: 0 });
    o = opts(); // re-rendered with the draft
    selectBinding(o).onPointerDrag!({ x: 7, y: 0 });
    o = opts();
    selectBinding(o).onPointerDrag!({ x: 8, y: 0 });
    expect(drafts.get(4)![0]).toEqual({ x: 3, y: 0 });
    o = opts();
    selectBinding(o).onPointerUp!({ x: 8, y: 0 });
    expect(o.onObjectMoved).toHaveBeenCalledWith(4, [{ x: 3, y: 0 }, { x: 13, y: 0 }, { x: 13, y: 10 }, { x: 3, y: 10 }]);
  });

  it("a closed area is pressed by its outline; inside it the map pans, also when it is selected (§7)", () => {
    for (const kind of ["oob_area", "whiteout", "toner_saver", "filter_region"] as const) {
      // Unselected: a press inside (the hit-test reports nothing there) is the viewer's — it pans.
      const o = selectOpts({ objects: [square(4, kind)] });
      expect(selectBinding(o).onPointerDown!(ptr(5, 5))).toBe(false);
      expect(o.onSelectObject).not.toHaveBeenCalled();

      // Selected: an interior press declines too — a drag inside pans and leaves the area and the selection alone.
      const sel = selectOpts({ selected: square(4, kind), objects: [square(4, kind)] });
      const b = selectBinding(sel);
      expect(b.onPointerDown!(ptr(5, 5))).toBe(false);
      expect(b.onPointerDown!(ptr(5, 1))).toBe(false); // 10 px off the edge: beyond the 7 px reach
      expect(sel.onSelectObject).not.toHaveBeenCalled();
      expect(sel.onObjectDraft).not.toHaveBeenCalled();

      // Within 7 px of its edge (`HANDLE_PX`, any pointer; no target needed) it drags; so does a press the hit-test
      // reports on its outline (the viewer's tolerance: 6 px, 12 px on touch).
      expect(b.onPointerDown!(ptr(5, 0.6))).toBe(true);
      b.onPointerDrag!({ x: 5, y: 2.6 });
      b.onPointerUp!({ x: 5, y: 2.6 });
      expect(sel.onObjectMoved).toHaveBeenLastCalledWith(4, [{ x: 0, y: 2 }, { x: 10, y: 2 }, { x: 10, y: 12 }, { x: 0, y: 12 }]);
      expect(b.onPointerDown!(ptr(5, 1.1, { target: { kind: "object", id: 4 } }))).toBe(true);
      b.onPointerUp!({ x: 5, y: 1.1 });

      // The pressing order is unchanged: a vertex wins over the edge.
      const v = selectOpts({ selected: square(4, kind), objects: [square(4, kind)] });
      const bv = selectBinding(v);
      bv.onPointerDown!(ptr(10, 0.2, { target: { kind: "object", id: 4 } }));
      bv.onPointerDrag!({ x: 11, y: 1 });
      bv.onPointerUp!({ x: 11, y: 1 });
      expect(v.onObjectMoved).toHaveBeenCalledWith(4, [{ x: 0, y: 0 }, { x: 11, y: 0.8 }, { x: 10, y: 10 }, { x: 0, y: 10 }]);
    }
  });

  it("a line's stroke press is still the object's", () => {
    const line = { ...square(6, "oob_line"), geometry: [{ x: 0, y: 0 }, { x: 20, y: 0 }] } as course.CourseObject;
    const o = selectOpts({ selected: line, objects: [line] });
    const b = selectBinding(o);
    expect(b.onPointerDown!(ptr(10, 0.05, { target: { kind: "object", id: 6 } }))).toBe(true);
    b.onPointerDrag!({ x: 12, y: 0.05 });
    b.onPointerUp!({ x: 12, y: 0.05 });
    expect(o.onObjectMoved).toHaveBeenCalledWith(6, [{ x: 2, y: 0 }, { x: 22, y: 0 }]);
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

describe("geometry editing on a selected object (docs/course-editor.md §7 \"Editing geometry\")", () => {
  type Shape = { kind: string; testId?: string; data?: Record<string, string>; points?: unknown[] };
  const curved = (id: number): course.CourseObject =>
    ({ ...square(id), geometry: [{ x: 0, y: 0, hIn: { x: 0, y: -2 }, hOut: { x: 0, y: 2 } }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }] }) as course.CourseObject;
  const shapesOf = (b: ReturnType<typeof selectBinding>, id: string) => (b.shapes as unknown as Shape[]).filter((s) => s.testId === id);
  /** The geometry of the `n`th write. */
  const movedTo = (o: ReturnType<typeof selectOpts>, n: number) => vi.mocked(o.onObjectMoved).mock.calls[n][1];

  it("the outline follows the curve; grips for each handle, none on corners", () => {
    const o = selectOpts({ selected: curved(4), objects: [curved(4)] });
    const b = selectBinding(o);
    expect(shapesOf(b, "editor-object-outline")[0].points).toHaveLength(1 + 8 + 2 + 8); // vertex 0 curves its first and its closing segment
    expect(shapesOf(b, "editor-object-grip").map((g) => g.data)).toEqual([{ index: "0", which: "in" }, { index: "0", which: "out" }]);
    expect(shapesOf(selectBinding(selectOpts({ selected: square(4) })), "editor-object-grip")).toHaveLength(0);
  });

  it("Alt-drag on a vertex moves it like a plain drag (F18: no handles pulled); one write on release", () => {
    const o = selectOpts({ selected: square(4) });
    const b = selectBinding(o);
    expect(b.onPointerDown!(ptr(10, 0, { alt: true }))).toBe(true);
    b.onPointerDrag!({ x: 13, y: 4 }, { shift: false, alt: true });
    expect(o.onObjectDraft).toHaveBeenLastCalledWith(4, expect.arrayContaining([{ x: 13, y: 4 }]));
    b.onPointerUp!({ x: 13, y: 4 });
    expect(o.onObjectMoved).toHaveBeenCalledTimes(1);
    expect(movedTo(o, 0)[1]).toEqual({ x: 13, y: 4 });
  });

  it("a filter region's Alt-drag moves the vertex (no handles)", () => {
    const o = selectOpts({ selected: square(4, "filter_region"), objects: [square(4, "filter_region")] });
    const b = selectBinding(o);
    b.onPointerDown!(ptr(10, 0, { alt: true }));
    b.onPointerDrag!({ x: 12, y: 0 }, { shift: false, alt: true });
    b.onPointerUp!({ x: 12, y: 0 });
    expect(movedTo(o, 0)[1]).toEqual({ x: 12, y: 0 });
  });

  it("Alt-click toggles a vertex: handles → corner, corner → smooth (F18); a filter region nothing; a plain click focuses the vertex", () => {
    const o = selectOpts({ selected: curved(4), objects: [curved(4)] });
    const b = selectBinding(o);
    b.onPointerDown!(ptr(0, 0, { alt: true }));
    b.onPointerUp!({ x: 0, y: 0 });
    expect(movedTo(o, 0)[0]).toEqual({ x: 0, y: 0 });
    // A corner becomes smooth: handles from its neighbours, (next − prev) / 6.
    b.onPointerDown!(ptr(10, 10, { alt: true }));
    b.onPointerUp!({ x: 10, y: 10 });
    expect(o.onObjectMoved).toHaveBeenCalledTimes(2);
    expect(movedTo(o, 1)[2]).toEqual({ x: 10, y: 10, hIn: { x: 10 / 6, y: -10 / 6 }, hOut: { x: -10 / 6, y: 10 / 6 } });
    const f = selectOpts({ selected: square(4, "filter_region"), objects: [square(4, "filter_region")] });
    const bf = selectBinding(f);
    bf.onPointerDown!(ptr(10, 10, { alt: true }));
    bf.onPointerUp!({ x: 10, y: 10 });
    expect(f.onObjectMoved).not.toHaveBeenCalled();
    b.onPointerDown!(ptr(10, 10));
    b.onPointerUp!({ x: 10, y: 10 });
    expect(o.onVertexFocus).toHaveBeenLastCalledWith(2);
    b.onPointerDown!(ptr(5, 0, { target: { kind: "object", id: 4 } })); // a click on its edge unfocuses
    b.onPointerUp!({ x: 5, y: 0 });
    expect(o.onVertexFocus).toHaveBeenLastCalledWith(null);
    const focused = selectBinding(selectOpts({ selected: square(4), focusedVertex: 2 }));
    expect(shapesOf(focused, "editor-object-handle").filter((h) => h.data?.focused)).toHaveLength(1);
  });

  it("a grip drag keeps the pair mirrored; Alt (live) breaks it", () => {
    const o = selectOpts({ selected: curved(4), objects: [curved(4)] });
    const b = selectBinding(o);
    expect(b.onPointerDown!(ptr(0, 2))).toBe(true); // hOut's grip
    b.onPointerDrag!({ x: 3, y: 0 }, { shift: false, alt: false });
    b.onPointerUp!({ x: 3, y: 0 });
    expect(movedTo(o, 0)[0]).toEqual({ x: 0, y: 0, hIn: { x: -3, y: -0 }, hOut: { x: 3, y: 0 } });
    b.onPointerDown!(ptr(0, -2)); // hIn's grip
    b.onPointerDrag!({ x: -1, y: -1 }, { shift: false, alt: true });
    b.onPointerUp!({ x: -1, y: -1 });
    expect(movedTo(o, 1)[0]).toEqual({ x: 0, y: 0, hIn: { x: -1, y: -1 }, hOut: { x: 0, y: 2 } });
  });

  it("double-click on an edge inserts a smooth vertex there (F18), Alt a corner; inside the area, on a vertex or on a text nothing", () => {
    const o = selectOpts({ selected: square(4) });
    const b = selectBinding(o);
    b.onDoubleClick!(ptr(5, 0.3));
    // Collinear handles from its neighbours: the edge stays straight until the vertex moves.
    expect(o.onObjectMoved).toHaveBeenCalledWith(4, [{ x: 0, y: 0 }, { x: 5, y: 0, hIn: { x: -10 / 6, y: -0 }, hOut: { x: 10 / 6, y: 0 } }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }]);
    expect(o.onVertexFocus).toHaveBeenLastCalledWith(1);
    b.onDoubleClick!(ptr(5, 0.3, { alt: true }));
    expect(movedTo(o, 1)).toEqual([{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }]);
    b.onDoubleClick!(ptr(5, 5));
    b.onDoubleClick!(ptr(10, 0.2));
    expect(o.onObjectMoved).toHaveBeenCalledTimes(2);
    const text = { ...square(5, "text"), geometry: [{ x: 0, y: 0 }] } as course.CourseObject;
    const t = selectOpts({ selected: text, objects: [text] });
    selectBinding(t).onDoubleClick!(ptr(0.2, 0));
    expect(t.onObjectMoved).not.toHaveBeenCalled();
  });

  it("a click leaves the page's draft (the last write) alone; a text's anchor is never focused", () => {
    const o = selectOpts({ selected: square(4) });
    const b = selectBinding(o);
    b.onPointerDown!(ptr(10, 10));
    b.onPointerUp!({ x: 10, y: 10 });
    expect(o.onObjectDraft).not.toHaveBeenCalled();
    const text = { ...square(5, "text"), geometry: [{ x: 0, y: 0 }] } as course.CourseObject;
    const t = selectOpts({ selected: text, objects: [text] });
    const bt = selectBinding(t);
    bt.onPointerDown!(ptr(0, 0));
    bt.onPointerUp!({ x: 0, y: 0 });
    expect(t.onVertexFocus).toHaveBeenLastCalledWith(null);
  });

  it("a grip drags by the pointer's offset, past a threshold", () => {
    const o = selectOpts({ selected: curved(4), objects: [curved(4)] });
    const b = selectBinding(o);
    b.onPointerDown!(ptr(0.4, 2)); // 0.4 mm off hOut's grip at (0, 2)
    b.onPointerDrag!({ x: 0.41, y: 2 }, { shift: false, alt: false }); // jitter
    b.onPointerUp!({ x: 0.41, y: 2 });
    expect(o.onObjectMoved).not.toHaveBeenCalled();
    b.onPointerDown!(ptr(0.4, 2));
    b.onPointerDrag!({ x: 0.4, y: 3 }, { shift: false, alt: false });
    b.onPointerUp!({ x: 0.4, y: 3 });
    expect(movedTo(o, 0)[0]).toMatchObject({ hOut: { x: 0, y: 3 } });
  });

  it("a press within reach of the selected object's edge is the object's, not the map's", () => {
    const b = selectBinding(selectOpts({ selected: square(4) }));
    expect(b.onPointerDown!(ptr(5, -0.5))).toBe(true);
    expect(b.onPointerDown!(ptr(5, -3))).toBe(false);
  });
});

describe("armed and area bindings", () => {
  it("placement is exclusive: a click places, right-click exits, touch gets Place / Done", () => {
    const onPlace = vi.fn(), onExit = vi.fn();
    const b = placeBinding({ ghost: null, provisionalDrawn: false, onHover: vi.fn(), onPlace, onExit, touch: { placeLabel: "Place", doneLabel: "Done" } });
    expect(b.exclusive).toBe(true);
    b.onClick!(ptr(1, 1));
    b.onContextMenu!(ptr(1, 1));
    expect(onPlace).toHaveBeenCalled();
    expect(onExit).toHaveBeenCalled();
    expect(b.touch?.placeLabel).toBe("Place");
  });

  it("with a provisional visit the layer draws the circle: the UI layer adds its label, description and the pending leg's length (P4)", () => {
    const b = placeBinding({
      ghost: { at: { x: 4, y: 2 }, radiusMm: 2.5, role: "control", label: "3 · 47", description: "boulder", legs: [[{ x: 0, y: 0 }, { x: 4, y: 2 }], [{ x: 4, y: 2 }, { x: 8, y: 0 }]], legLabel: "120 m" },
      provisionalDrawn: true, onHover: vi.fn(), onPlace: vi.fn(), onExit: vi.fn(), touch: null,
    });
    const ids = b.shapes!.map((s) => s.testId);
    expect(ids).toEqual(expect.arrayContaining(["editor-ghost-label", "editor-ghost-description", "editor-leg-length"]));
    expect(ids).not.toContain("editor-ghost");
    expect(ids).not.toContain("editor-pending-leg");
    expect(b.shapes!.filter((s) => s.kind === "circle")).toEqual([]);
    expect(b.shapes!.filter((s) => s.kind === "line")).toEqual([]);
    expect(b.shapes!.filter((s) => s.testId === "editor-leg-length")).toEqual([expect.objectContaining({ kind: "text", x: 2, y: 1, text: "120 m" })]);
    const noScale = placeBinding({ ghost: { at: { x: 4, y: 2 }, radiusMm: 2.5, role: "control", label: "1", description: null, legs: [[{ x: 0, y: 0 }, { x: 4, y: 2 }]], legLabel: null }, provisionalDrawn: true, onHover: vi.fn(), onPlace: vi.fn(), onExit: vi.fn(), touch: null });
    expect(noScale.shapes!.map((s) => s.testId)).not.toContain("editor-leg-length");
  });

  it("without a provisional visit (no course, or a reuse) the UI layer draws the true-size circle; a finish adds its inner one", () => {
    const ghost = (role: "control" | "finish") => ({ at: { x: 4, y: 2 }, radiusMm: 2.5, role, label: "Add 47", description: null, legs: [], legLabel: null });
    const b = placeBinding({ ghost: ghost("control"), provisionalDrawn: false, onHover: vi.fn(), onPlace: vi.fn(), onExit: vi.fn(), touch: null });
    expect(b.shapes!.filter((s) => s.kind === "circle")).toEqual([expect.objectContaining({ kind: "circle", x: 4, y: 2, rMm: 2.5, testId: "editor-ghost", data: { role: "control" } })]);
    expect(b.shapes!.map((s) => s.testId)).toContain("editor-ghost-label");
    const f = placeBinding({ ghost: ghost("finish"), provisionalDrawn: false, onHover: vi.fn(), onPlace: vi.fn(), onExit: vi.fn(), touch: null });
    expect(f.shapes!.filter((s) => s.kind === "circle").map((s) => s.kind === "circle" && s.rMm)).toEqual([2.5, 1.75]);
  });

  it("the crossing ghost (§6.8): two lines along the passage, no circle, the label; lit as C", () => {
    const ghost = { at: { x: 10, y: 5 }, radiusMm: 2.5, role: "crossing_point" as const, angleDeg: 0, label: "Crossing point", description: null, legs: [], legLabel: null };
    const b = placeBinding({ ghost, provisionalDrawn: false, onHover: vi.fn(), onPlace: vi.fn(), onExit: vi.fn(), touch: null });
    expect(b.shapes!.filter((s) => s.kind === "circle")).toEqual([]);
    const lines = b.shapes!.filter((s) => s.kind === "line");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ testId: "editor-ghost", data: { role: "crossing_point", angle: "0" } });
    // Due east: both lines run along x, either side of the site.
    const [a, c] = lines.map((l) => (l.kind === "line" ? l.points : []));
    expect(a.map((p) => p.y)).toEqual([5.475, 5.475]);
    expect(c.map((p) => p.y)).toEqual([4.525, 4.525]);
    expect(a.map((p) => p.x)).toEqual([8.5, 11.5]);
    // North without a leg.
    const north = crossingGhost({ x: 0, y: 0 }, 90);
    const pts = north[0].kind === "line" ? north[0].points : [];
    expect(pts[0].x).toBeCloseTo(-0.475, 9);
    expect(pts[1].y).toBeCloseTo(1.5, 9);
    expect(b.shapes!.map((s) => s.testId)).toContain("editor-ghost-label");
    expect(railKeyOf({ kind: "place", chain: { tool: "crossing", insertAt: null, anchorId: null, placed: [] } })).toBe("C");
  });

  it("the area flow: clicks add vertices, the first vertex closes, a vertex is dragged before closing", () => {
    const gesture: GestureRef = { current: null };
    const onPoly = vi.fn(), onDone = vi.fn();
    // Corners (placed with Alt), so the flow's moves are plain.
    const poly = { kind: "oob_area" as const, vertices: [{ x: 0, y: 0, corner: true as const }, { x: 10, y: 0, corner: true as const }, { x: 10, y: 10, corner: true as const }] };
    const b = areaBinding({ gesture, poly, hover: null, onHover: vi.fn(), onPoly, onDone, onCancel: vi.fn(), snap: (p) => p });
    expect(b.onPointerDown!(ptr(10, 0.2))).toBe(true); // vertex 1
    b.onPointerDrag!({ x: 11, y: 1 });
    expect(onPoly).toHaveBeenCalledWith({ kind: "oob_area", vertices: [poly.vertices[0], { x: 11, y: 1, corner: true }, poly.vertices[2]] });
    b.onPointerUp!({ x: 11, y: 1 });
    expect(b.onPointerDown!(ptr(0.1, 0.1))).toBe(false); // the first vertex is a click, not a drag
    b.onClick!(ptr(0.1, 0.1));
    expect(onDone).toHaveBeenCalledWith([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }]);
  });

  it("while drawing: a press places a smooth vertex (F18), a drag from it pulls symmetric handles (Shift: 45°)", () => {
    const gesture: GestureRef = { current: null };
    const onPoly = vi.fn();
    const poly = { kind: "whiteout" as const, vertices: [{ x: 0, y: 0 }, { x: 10, y: 0 }] };
    const opts = { gesture, poly, hover: null, onHover: vi.fn(), onPoly, onDone: vi.fn(), onCancel: vi.fn(), snap: (p: { x: number; y: number }) => p };
    const b = areaBinding(opts);
    expect(b.onPointerDown!(ptr(10, 10))).toBe(true);
    // The new vertex is the open end for now; vertex 1, now between two, gains its smooth handles on the same write.
    expect(onPoly).toHaveBeenLastCalledWith({ kind: "whiteout", vertices: [poly.vertices[0], { x: 10, y: 0, hIn: { x: -10 / 6, y: -10 / 6 }, hOut: { x: 10 / 6, y: 10 / 6 } }, { x: 10, y: 10 }] });
    b.onPointerDrag!({ x: 10.2, y: 10 }, { shift: false, alt: false }); // within 3 px: still the press's vertex
    expect(onPoly).toHaveBeenCalledTimes(1);
    b.onPointerDrag!({ x: 13, y: 14 }, { shift: false, alt: false });
    expect(onPoly.mock.calls[1][0].vertices[2]).toEqual({ x: 10, y: 10, hOut: { x: 3, y: 4 }, hIn: { x: -3, y: -4 }, pulled: true });
    b.onPointerDrag!({ x: 20, y: 11 }, { shift: true, alt: false });
    const last = onPoly.mock.calls[onPoly.mock.calls.length - 1][0].vertices[2];
    expect(last.hOut.y).toBeCloseTo(0);
    b.onPointerUp!({ x: 20, y: 11 });
    // The threshold is the press's, not the snapped vertex's; back within 3 px of the press is the press's kind again.
    const onPoly2 = vi.fn();
    const s2 = areaBinding({ ...opts, onPoly: onPoly2, snap: (p: { x: number; y: number }) => ({ x: Math.round(p.x), y: Math.round(p.y) }) });
    gesture.current = null;
    s2.onPointerDown!(ptr(20.4, 20.4));
    expect(onPoly2).toHaveBeenCalledTimes(1); // the vertex, at the snapped (20, 20)
    s2.onPointerDrag!({ x: 20.45, y: 20.4 }, { shift: false, alt: false });
    expect(onPoly2).toHaveBeenCalledTimes(1);
    s2.onPointerDrag!({ x: 23.4, y: 20.4 }, { shift: false, alt: false });
    expect(onPoly2.mock.calls[1][0].vertices[2]).toEqual({ x: 20, y: 20, hOut: { x: 3, y: 0 }, hIn: { x: -3, y: -0 }, pulled: true });
    s2.onPointerDrag!({ x: 20.5, y: 20.4 }, { shift: false, alt: false });
    expect(onPoly2.mock.calls[2][0].vertices[2]).toEqual({ x: 20, y: 20 });
    // Drawn with its handles: the preview follows the curve, the grips show.
    const drawn = areaBinding({
      ...opts,
      poly: { kind: "whiteout", vertices: [{ x: 0, y: 0, corner: true }, { x: 10, y: 0, corner: true }, { x: 10, y: 10, hOut: { x: 3, y: 0 }, hIn: { x: -3, y: 0 }, pulled: true }] },
    });
    const shapes = drawn.shapes as unknown as { testId?: string; points?: unknown[] }[];
    expect(shapes.find((s) => s.testId === "editor-polygon")!.points).toHaveLength(2 + 8 + 8);
    expect(shapes.filter((s) => s.testId === "editor-polygon-grip")).toHaveLength(2);
  });

  it("Alt at the press places a corner (F18); a pull past 3 px is still the manual curve (§6.4)", () => {
    const gesture: GestureRef = { current: null };
    const onPoly = vi.fn();
    const poly = { kind: "whiteout" as const, vertices: [{ x: 0, y: 0 }, { x: 10, y: 0 }] };
    const opts = { gesture, poly, hover: null, onHover: vi.fn(), onPoly, onDone: vi.fn(), onCancel: vi.fn(), snap: (p: { x: number; y: number }) => p };
    const b = areaBinding(opts);
    expect(b.onPointerDown!(ptr(10, 10, { alt: true }))).toBe(true);
    expect(onPoly.mock.calls[0][0].vertices[2]).toEqual({ x: 10, y: 10, corner: true });
    b.onPointerUp!({ x: 10, y: 10 });
    expect(onPoly).toHaveBeenCalledTimes(1);
    // The pull beats Alt: the pulled handles (the corner kept for a drag back).
    gesture.current = null;
    b.onPointerDown!(ptr(10, 10, { alt: true }));
    b.onPointerDrag!({ x: 13, y: 14 }, { shift: false, alt: true });
    expect(onPoly.mock.calls[onPoly.mock.calls.length - 1][0].vertices[2]).toEqual({ x: 10, y: 10, hOut: { x: 3, y: 4 }, hIn: { x: -3, y: -4 }, corner: true, pulled: true });
    // Without Alt the press is smooth: no flag.
    gesture.current = null;
    b.onPointerDown!(ptr(10, 10));
    expect(onPoly.mock.calls[onPoly.mock.calls.length - 1][0].vertices[2]).toEqual({ x: 10, y: 10 });
    // A filter region ignores Alt and smooths nothing.
    const onFr = vi.fn();
    gesture.current = null;
    areaBinding({ ...opts, poly: { kind: "filter_region", vertices: poly.vertices }, onPoly: onFr }).onPointerDown!(ptr(10, 10, { alt: true }));
    expect(onFr).toHaveBeenLastCalledWith({ kind: "filter_region", vertices: [...poly.vertices, { x: 10, y: 10 }] });
  });

  it("the closing click wraps the smooth vertices; Alt on it makes the first a corner; done carries no flags", () => {
    const poly = { kind: "oob_area" as const, vertices: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }] };
    const close = (alt: boolean) => {
      const onDone = vi.fn();
      areaBinding({ gesture: { current: null }, poly, hover: null, onHover: vi.fn(), onPoly: vi.fn(), onDone, onCancel: vi.fn(), snap: (p) => p }).onClick!(ptr(0.1, 0.1, { alt }));
      return onDone.mock.calls[0][0] as { x: number; y: number; hOut?: { x: number; y: number } }[];
    };
    const smooth = close(false);
    expect(smooth[0].hOut!.x).toBeCloseTo(0);
    expect(smooth[0].hOut!.y).toBeCloseTo(-10 / 6);
    const sharp = close(true);
    expect(sharp[0]).toEqual({ x: 0, y: 0 });
    expect(sharp[1].hOut!.x).toBeCloseTo(10 / 6);
    expect(sharp[2].hOut!.x).toBeCloseTo(-10 / 6);
    [...smooth, ...sharp].forEach((q) => {
      expect(q).not.toHaveProperty("corner");
      expect(q).not.toHaveProperty("pulled");
    });
  });

  it("the preview shows the hover as the smooth vertex a click places, without writing it; no provisional grips", () => {
    const onPoly = vi.fn();
    const poly = { kind: "whiteout" as const, vertices: [{ x: 0, y: 0 }, { x: 10, y: 0 }] };
    const b = areaBinding({ gesture: { current: null }, poly, hover: { x: 10, y: 10 }, onHover: vi.fn(), onPoly, onDone: vi.fn(), onCancel: vi.fn(), snap: (p) => p });
    const shapes = b.shapes as unknown as { testId?: string; points?: unknown[] }[];
    // The ring of three, all smooth, wrapped: every segment curves.
    expect(shapes.find((s) => s.testId === "editor-polygon")!.points).toHaveLength(1 + 8 + 8 + 8);
    expect(shapes.filter((s) => s.testId === "editor-polygon-grip")).toHaveLength(0);
    expect(onPoly).not.toHaveBeenCalled();
    expect(poly.vertices[1]).toEqual({ x: 10, y: 0 });
    // A filter region's preview is a polygon.
    const fr = areaBinding({ gesture: { current: null }, poly: { ...poly, kind: "filter_region" }, hover: { x: 10, y: 10 }, onHover: vi.fn(), onPoly, onDone: vi.fn(), onCancel: vi.fn(), snap: (p) => p });
    expect((fr.shapes as unknown as { testId?: string; points?: unknown[] }[]).find((s) => s.testId === "editor-polygon")!.points).toHaveLength(3);
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
    const b = gapBinding({ gesture, target: { kind: "leg", itemIndex: 2, points: [{ x: 0, y: 0 }, { x: 100, y: 0 }], gaps: [] }, redraw: vi.fn(), onAdd, onRemove: vi.fn(), onExit: vi.fn() });
    expect(b.onPointerDown!(ptr(40, 0.5))).toBe(true);
    b.onPointerUp!({ x: 60, y: 0 });
    expect(onAdd).toHaveBeenCalledWith({ from: 0.4, to: 0.6 });
  });

  it("on a bent leg: the target and gaps follow the bends, a press off the chord but on a bend reaches it", () => {
    const onAdd = vi.fn();
    const gesture: GestureRef = { current: null };
    const points = [{ x: 0, y: 0 }, { x: 30, y: 40 }, { x: 60, y: 0 }];
    const b = gapBinding({ gesture, target: { kind: "leg", itemIndex: 2, points, gaps: [{ from: 0.25, to: 0.75 }] }, redraw: vi.fn(), onAdd, onRemove: vi.fn(), onExit: vi.fn() });
    expect(b.shapes!.find((s) => s.testId === "editor-gap-target")).toMatchObject({ points });
    expect(b.shapes!.find((s) => s.testId === "editor-gap")).toMatchObject({ points: [{ x: 15, y: 20 }, { x: 30, y: 40 }, { x: 45, y: 20 }] });
    // Far from the chord (y = 0), on the first segment.
    expect(b.onPointerDown!(ptr(6, 8))).toBe(true);
    b.onPointerUp!({ x: 9, y: 12 });
    expect(onAdd).toHaveBeenCalledWith({ from: 0.1, to: 0.15 });
  });
});

describe("pinch-scale of a selected object (docs/course-editor.md §10)", () => {
  it("scales about a centre, Bézier handles with it", () => {
    expect(scaleAbout([{ x: 0, y: 0, hOut: { x: 1, y: 0 } }, { x: 10, y: 0 }], { x: 5, y: 0 }, 2)).toEqual([{ x: -5, y: 0, hOut: { x: 2, y: 0 } }, { x: 15, y: 0 }]);
  });

  it("two fingers with one on the handle ring scale it about its centroid; one write on lift", () => {
    const o = selectOpts({ selected: square(4) });
    const b = selectBinding(o);
    // Not on the ring (and nothing selected elsewhere): the map pinches.
    expect(b.onPinch!.start(ptr(5, 5), ptr(6, 6))).toBe(false);
    expect(b.onPinch!.start(ptr(10.5, 10.5), ptr(20, 20))).toBe(true);
    b.onPinch!.move(1.5);
    expect(o.onObjectDraft).toHaveBeenLastCalledWith(4, [{ x: -2.5, y: -2.5 }, { x: 12.5, y: -2.5 }, { x: 12.5, y: 12.5 }, { x: -2.5, y: 12.5 }]);
    b.onPinch!.move(2);
    b.onPinch!.end(true);
    expect(o.onObjectMoved).toHaveBeenCalledTimes(1);
    expect(o.onObjectMoved).toHaveBeenCalledWith(4, [{ x: -5, y: -5 }, { x: 15, y: -5 }, { x: 15, y: 15 }, { x: -5, y: 15 }]);
  });

  it("no object selected, a cancel, or no change writes nothing", () => {
    expect(selectBinding(selectOpts()).onPinch!.start(ptr(10, 10), ptr(20, 20))).toBe(false);
    const o = selectOpts({ selected: square(4) });
    const b = selectBinding(o);
    b.onPinch!.start(ptr(10, 10), ptr(20, 20));
    b.onPinch!.move(1.3);
    b.onPinch!.end(false);
    b.onPinch!.start(ptr(10, 10), ptr(20, 20));
    b.onPinch!.move(1.005);
    b.onPinch!.end(true);
    expect(o.onObjectMoved).not.toHaveBeenCalled();
    expect(o.onObjectDraft).toHaveBeenLastCalledWith(4, null);
  });
});

describe("the eyedropper binding (docs/course-editor.md §6.4)", () => {
  it("is exclusive with a crosshair: a click picks at the pointer with its tolerance, right-click exits, no shapes", () => {
    const onPick = vi.fn(), onExit = vi.fn();
    const b = pickSymbolBinding({ onPick, onExit });
    expect(b).toMatchObject({ exclusive: true, cursor: "crosshair" });
    expect(b.shapes ?? []).toEqual([]);
    b.onClick!(ptr(3, 4, { mmPerPx: 0.5 }));
    expect(onPick).toHaveBeenCalledWith({ x: 3, y: 4 }, 3);
    b.onContextMenu!(ptr(3, 4));
    expect(onExit).toHaveBeenCalled();
  });

  it("lights no rail button", () => {
    expect(railKeyOf({ kind: "pick-symbol" })).toBeNull();
  });
});

describe("V on a selected leg: bend handles (docs/course-editor.md §6.7)", () => {
  const legOpts = (over: Partial<NonNullable<Parameters<typeof selectBinding>[0]["leg"]>> = {}) => ({
    from: { x: 0, y: 0 }, to: { x: 40, y: 0 }, bends: [{ x: 20, y: 10 }], focused: null,
    onBendsChange: vi.fn(), onBendFocus: vi.fn(), snap: (p: { x: number; y: number }) => p, ...over,
  });

  it("draws the leg's outline through its bends and a handle per bend", () => {
    const leg = legOpts({ focused: 0 });
    const b = selectBinding(selectOpts({ leg }));
    expect(b.shapes!.find((s) => s.testId === "editor-leg-outline")).toMatchObject({ kind: "line", points: [{ x: 0, y: 0 }, { x: 20, y: 10 }, { x: 40, y: 0 }], dashed: true });
    expect(b.shapes!.filter((s) => s.testId === "editor-bend-handle")).toEqual([
      expect.objectContaining({ kind: "handle", x: 20, y: 10, active: true, data: { index: "0", focused: "true" } }),
    ]);
  });

  it("a drag moves the bend: the outline follows, one write on release with the moved bend", () => {
    const o = selectOpts({ leg: legOpts() });
    const b = selectBinding(o);
    // Within the handle's reach (7 px × 0.1 mm/px).
    expect(b.onPointerDown!(ptr(20.4, 10.3))).toBe(true);
    b.onPointerDrag!({ x: 22, y: 14 });
    expect(o.redraw).toHaveBeenCalled();
    expect(o.leg!.onBendsChange).not.toHaveBeenCalled();
    // The page re-renders with the gesture in flight: the outline follows.
    const mid = selectBinding(o);
    expect(mid.shapes!.find((s) => s.testId === "editor-leg-outline")).toMatchObject({ points: [{ x: 0, y: 0 }, { x: 22, y: 14 }, { x: 40, y: 0 }] });
    mid.onPointerUp!({ x: 22.5, y: 15 });
    expect(o.leg!.onBendsChange).toHaveBeenCalledTimes(1);
    expect(o.leg!.onBendsChange).toHaveBeenCalledWith([{ x: 22.5, y: 15 }]);
    expect(o.gesture.current).toBeNull();
  });

  it("a click on a handle focuses it; a cancelled drag writes nothing; off the handles it is the viewer's", () => {
    const o = selectOpts({ leg: legOpts() });
    const b = selectBinding(o);
    expect(b.onPointerDown!(ptr(20, 10))).toBe(true);
    b.onPointerUp!({ x: 20.05, y: 10 });
    expect(o.leg!.onBendFocus).toHaveBeenCalledWith(0);
    expect(o.leg!.onBendsChange).not.toHaveBeenCalled();
    expect(b.onPointerDown!(ptr(20, 10))).toBe(true);
    b.onPointerDrag!({ x: 25, y: 12 });
    b.onPointerUp!(null);
    expect(o.leg!.onBendsChange).not.toHaveBeenCalled();
    expect(b.onPointerDown!(ptr(30, 5))).toBe(false);
  });

  it("the drag snaps the bend", () => {
    const o = selectOpts({ leg: legOpts({ snap: () => ({ x: 50, y: 50 }) }) });
    const b = selectBinding(o);
    b.onPointerDown!(ptr(20, 10));
    b.onPointerDrag!({ x: 25, y: 12 });
    b.onPointerUp!({ x: 25, y: 12 });
    expect(o.leg!.onBendsChange).toHaveBeenCalledWith([{ x: 50, y: 50 }]);
  });

  it("a double-click on a handle inserts no control", () => {
    const o = selectOpts({ leg: legOpts() });
    const b = selectBinding(o);
    b.onDoubleClick!(ptr(20, 10, { target: { kind: "leg", courseId: "c", index: 0 } }));
    expect(o.onLegDoubleClick).not.toHaveBeenCalled();
    b.onDoubleClick!(ptr(10, 5, { target: { kind: "leg", courseId: "c", index: 0 } }));
    expect(o.onLegDoubleClick).toHaveBeenCalledTimes(1);
  });
});

describe("V on a selected leg: smooth bends, grips, Alt (docs/course-editor.md §6.7, §7; F16)", () => {
  // A smooth bend above the chord, its handles along the chord (2 mm each way).
  const SMOOTH = { x: 20, y: 10, hIn: { x: -2, y: 0 }, hOut: { x: 2, y: 0 } };
  const legOpts = (over: Partial<NonNullable<Parameters<typeof selectBinding>[0]["leg"]>> = {}) => ({
    from: { x: 0, y: 0 }, to: { x: 40, y: 0 }, bends: [SMOOTH], focused: null,
    onBendsChange: vi.fn(), onBendFocus: vi.fn(), snap: (p: { x: number; y: number }) => p, ...over,
  });
  const outline = (b: ReturnType<typeof selectBinding>) => b.shapes!.find((s) => s.testId === "editor-leg-outline") as Extract<ToolShape, { kind: "line" }>;

  it("the outline is the flattened curve (legPolyline); a grip per handle", () => {
    const b = selectBinding(selectOpts({ leg: legOpts() }));
    const pts = outline(b).points;
    expect(pts.length).toBeGreaterThan(3);
    expect(pts[0]).toEqual({ x: 0, y: 0 });
    expect(pts).toContainEqual({ x: 20, y: 10 });
    expect(pts[pts.length - 1]).toEqual({ x: 40, y: 0 });
    expect(b.shapes!.filter((s) => s.testId === "editor-bend-grip")).toEqual([
      { kind: "grip", x: 18, y: 10, from: SMOOTH, testId: "editor-bend-grip", data: { index: "0", which: "in" } },
      { kind: "grip", x: 22, y: 10, from: SMOOTH, testId: "editor-bend-grip", data: { index: "0", which: "out" } },
    ]);
    // A corner bend has none.
    expect(selectBinding(selectOpts({ leg: legOpts({ bends: [{ x: 20, y: 10 }] }) })).shapes!.some((s) => s.testId === "editor-bend-grip")).toBe(false);
  });

  it("a grip drag moves its handle by the pointer's offset, the pair mirrored; the outline follows; one write, the bend focused", () => {
    const o = selectOpts({ leg: legOpts() });
    const b = selectBinding(o);
    // Beside the out grip (22, 10), within reach: the press does not jump it.
    expect(b.onPointerDown!(ptr(22.3, 10.2))).toBe(true);
    b.onPointerDrag!({ x: 22.3, y: 14.2 }, { shift: false, alt: false });
    expect(o.redraw).toHaveBeenCalled();
    expect(o.leg!.onBendsChange).not.toHaveBeenCalled();
    const mid = selectBinding(o);
    expect(mid.shapes!.filter((s) => s.testId === "editor-bend-grip").map((s) => [(s as { x: number }).x, (s as { y: number }).y])).toEqual([[18, 6], [22, 14]]);
    expect(outline(mid).points).not.toEqual(outline(b).points);
    mid.onPointerUp!({ x: 22.3, y: 14.2 });
    expect(o.leg!.onBendsChange).toHaveBeenCalledTimes(1);
    expect(o.leg!.onBendsChange).toHaveBeenCalledWith([{ x: 20, y: 10, hIn: { x: -2, y: -4 }, hOut: { x: 2, y: 4 } }]);
    expect(o.leg!.onBendFocus).toHaveBeenCalledWith(0);
    expect(o.gesture.current).toBeNull();
  });

  it("Alt held on a grip (live) breaks the pair; Shift turns the handle to 45°", () => {
    const o = selectOpts({ leg: legOpts() });
    const b = selectBinding(o);
    b.onPointerDown!(ptr(22, 10));
    b.onPointerDrag!({ x: 22, y: 14 }, { shift: false, alt: true });
    b.onPointerUp!({ x: 22, y: 14 });
    expect(o.leg!.onBendsChange).toHaveBeenCalledWith([{ x: 20, y: 10, hIn: { x: -2, y: 0 }, hOut: { x: 2, y: 4 } }]);

    const s = selectOpts({ leg: legOpts() });
    const bs = selectBinding(s);
    bs.onPointerDown!(ptr(22, 10));
    bs.onPointerDrag!({ x: 24, y: 13.6 }, { shift: true, alt: false });
    bs.onPointerUp!({ x: 24, y: 13.6 });
    const [bend] = (s.leg!.onBendsChange as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(bend.hOut.x).toBeCloseTo(bend.hOut.y, 1);
    expect(bend.hIn).toEqual({ x: -bend.hOut.x, y: -bend.hOut.y });
  });

  it("a click on a grip or a cancelled grip drag writes nothing; a double-click on a grip inserts no control", () => {
    const o = selectOpts({ leg: legOpts() });
    const b = selectBinding(o);
    b.onPointerDown!(ptr(18, 10));
    b.onPointerUp!({ x: 18.05, y: 10 });
    b.onPointerDown!(ptr(18, 10));
    b.onPointerDrag!({ x: 15, y: 14 }, { shift: false, alt: false });
    b.onPointerUp!(null);
    expect(o.leg!.onBendsChange).not.toHaveBeenCalled();
    b.onDoubleClick!(ptr(18, 10, { target: { kind: "leg", courseId: "c", index: 0 } }));
    expect(o.onLegDoubleClick).not.toHaveBeenCalled();
  });

  it("pressing order: the bend handle before a grip on it", () => {
    // A short handle: its grip within the bend's reach.
    const o = selectOpts({ leg: legOpts({ bends: [{ x: 20, y: 10, hIn: { x: -0.3, y: 0 }, hOut: { x: 0.3, y: 0 } }] }) });
    const b = selectBinding(o);
    b.onPointerDown!(ptr(20.2, 10));
    expect(o.gesture.current).toMatchObject({ kind: "bend", index: 0 });
  });

  it("a bend drag moves the bend with its handles, Alt or not (F18: Alt-drag is a plain move)", () => {
    for (const alt of [false, true]) {
      const o = selectOpts({ leg: legOpts() });
      const b = selectBinding(o);
      b.onPointerDown!(ptr(20, 10, { alt }));
      b.onPointerDrag!({ x: 21, y: 13 }, { shift: false, alt });
      expect(outline(selectBinding(o)).points).toContainEqual({ x: 21, y: 13 });
      b.onPointerUp!({ x: 21, y: 13 });
      expect(o.leg!.onBendsChange).toHaveBeenCalledWith([{ ...SMOOTH, x: 21, y: 13 }]);
    }
  });

  it("Alt-click a bend toggles it: smooth → corner, corner → smooth from its neighbours; one write each", () => {
    const o = selectOpts({ leg: legOpts() });
    const b = selectBinding(o);
    b.onPointerDown!(ptr(20, 10, { alt: true }));
    b.onPointerUp!({ x: 20, y: 10 });
    expect(o.leg!.onBendsChange).toHaveBeenCalledWith([{ x: 20, y: 10 }]);
    expect(o.leg!.onBendFocus).toHaveBeenCalledWith(0);

    const c = selectOpts({ leg: legOpts({ bends: [{ x: 20, y: 10 }] }) });
    const bc = selectBinding(c);
    bc.onPointerDown!(ptr(20, 10, { alt: true }));
    bc.onPointerUp!({ x: 20, y: 10 });
    expect(c.leg!.onBendsChange).toHaveBeenCalledTimes(1);
    expect(c.leg!.onBendsChange).toHaveBeenCalledWith([{ x: 20, y: 10, hIn: { x: -6.67, y: 0 }, hOut: { x: 6.67, y: 0 } }]);
  });
});

describe("V on a selected leg: the live draft (docs/course-editor.md §6.7, F21)", () => {
  const SMOOTH = { x: 20, y: 10, hIn: { x: -2, y: 0 }, hOut: { x: 2, y: 0 } };
  const legOpts = (over: Partial<NonNullable<Parameters<typeof selectBinding>[0]["leg"]>> = {}) => ({
    from: { x: 0, y: 0 }, to: { x: 40, y: 0 }, bends: [SMOOTH], focused: null,
    onBendsChange: vi.fn(), onBendsDraft: vi.fn(), onBendFocus: vi.fn(), snap: (p: { x: number; y: number }) => p, ...over,
  });

  it("a bend drag reports its bends past 3 px, never before, snapped; the release writes once and reports no draft", () => {
    const o = selectOpts({ leg: legOpts({ snap: (p) => ({ x: Math.round(p.x), y: Math.round(p.y) }) }) });
    const b = selectBinding(o);
    b.onPointerDown!(ptr(20, 10));
    b.onPointerDrag!({ x: 20.2, y: 10.1 });
    expect(o.leg!.onBendsDraft).not.toHaveBeenCalled();
    b.onPointerDrag!({ x: 22.3, y: 14.4 });
    expect(o.leg!.onBendsDraft).toHaveBeenLastCalledWith([{ ...SMOOTH, x: 22, y: 14 }]);
    b.onPointerDrag!({ x: 25.4, y: 16.2 });
    expect(o.leg!.onBendsDraft).toHaveBeenLastCalledWith([{ ...SMOOTH, x: 25, y: 16 }]);
    expect(o.leg!.onBendsDraft).toHaveBeenCalledTimes(2);
    b.onPointerUp!({ x: 26, y: 17 });
    expect(o.leg!.onBendsChange).toHaveBeenCalledTimes(1);
    expect(o.leg!.onBendsChange).toHaveBeenCalledWith([{ ...SMOOTH, x: 26, y: 17 }]);
    // The page turns the draft pending on the write; the binding does not clear it.
    expect(o.leg!.onBendsDraft).toHaveBeenCalledTimes(2);
  });

  it("a cancelled drag (mouseleave) clears the draft and writes nothing", () => {
    const o = selectOpts({ leg: legOpts() });
    const b = selectBinding(o);
    b.onPointerDown!(ptr(20, 10));
    b.onPointerDrag!({ x: 25, y: 12 });
    b.onPointerUp!(null);
    expect(o.leg!.onBendsDraft).toHaveBeenLastCalledWith(null);
    expect(o.leg!.onBendsChange).not.toHaveBeenCalled();
    // A cancelled grip drag the same.
    b.onPointerDown!(ptr(22, 10));
    b.onPointerDrag!({ x: 22, y: 14 }, { shift: false, alt: false });
    b.onPointerUp!(null);
    expect(o.leg!.onBendsDraft).toHaveBeenLastCalledWith(null);
    expect(o.leg!.onBendsChange).not.toHaveBeenCalled();
  });

  it("a click gives no draft; an Alt-click toggles with one write and no draft", () => {
    const o = selectOpts({ leg: legOpts() });
    const b = selectBinding(o);
    b.onPointerDown!(ptr(20, 10));
    b.onPointerUp!({ x: 20.05, y: 10 });
    b.onPointerDown!(ptr(20, 10, { alt: true }));
    b.onPointerUp!({ x: 20, y: 10 });
    expect(o.leg!.onBendsDraft).not.toHaveBeenCalledWith(expect.any(Array));
    expect(o.leg!.onBendsChange).toHaveBeenCalledTimes(1);
    expect(o.leg!.onBendsChange).toHaveBeenCalledWith([{ x: 20, y: 10 }]);
    // A click on a grip: nothing either.
    b.onPointerDown!(ptr(18, 10));
    b.onPointerUp!({ x: 18.05, y: 10 });
    expect(o.leg!.onBendsDraft).not.toHaveBeenCalledWith(expect.any(Array));
  });

  it("a grip drag reports its mirrored pair, Alt live (the pair broken), then writes the last once", () => {
    const o = selectOpts({ leg: legOpts() });
    const b = selectBinding(o);
    b.onPointerDown!(ptr(22, 10));
    b.onPointerDrag!({ x: 22, y: 14 }, { shift: false, alt: false });
    expect(o.leg!.onBendsDraft).toHaveBeenLastCalledWith([{ x: 20, y: 10, hIn: { x: -2, y: -4 }, hOut: { x: 2, y: 4 } }]);
    b.onPointerDrag!({ x: 22, y: 14 }, { shift: false, alt: true });
    expect(o.leg!.onBendsDraft).toHaveBeenLastCalledWith([{ x: 20, y: 10, hIn: { x: -2, y: 0 }, hOut: { x: 2, y: 4 } }]);
    b.onPointerUp!({ x: 22, y: 14 });
    expect(o.leg!.onBendsChange).toHaveBeenCalledTimes(1);
    expect(o.leg!.onBendsChange).toHaveBeenCalledWith([{ x: 20, y: 10, hIn: { x: -2, y: 0 }, hOut: { x: 2, y: 4 } }]);
  });

  it("without onBendsDraft (an older caller) the gestures work as before", () => {
    const o = selectOpts({ leg: legOpts({ onBendsDraft: undefined }) });
    const b = selectBinding(o);
    b.onPointerDown!(ptr(20, 10));
    b.onPointerDrag!({ x: 25, y: 12 });
    b.onPointerUp!(null);
    b.onPointerDown!(ptr(20, 10));
    b.onPointerDrag!({ x: 25, y: 12 });
    b.onPointerUp!({ x: 25, y: 12 });
    expect(o.leg!.onBendsChange).toHaveBeenCalledWith([{ ...SMOOTH, x: 25, y: 12 }]);
  });
});

describe("V on a selected leg: touch (docs/course-editor.md §6.7, §10; F23)", () => {
  const SMOOTH = { x: 20, y: 10, hIn: { x: -2, y: 0 }, hOut: { x: 2, y: 0 } };
  const legOpts = (over: Partial<NonNullable<Parameters<typeof selectBinding>[0]["leg"]>> = {}) => ({
    from: { x: 0, y: 0 }, to: { x: 40, y: 0 }, bends: [SMOOTH], focused: null,
    onBendsChange: vi.fn(), onBendsDraft: vi.fn(), onBendFocus: vi.fn(), snap: (p: { x: number; y: number }) => p, ...over,
  });
  // 0.1 mm per CSS px: the touch reach is 2 × HANDLE_PX = 14 px = 1.4 mm; the mouse's 7 px = 0.7 mm.
  const touch = (x: number, y: number, over: Partial<ToolPointer> = {}) => ptr(x, y, { touch: true, ...over });

  it("opts in to one-finger presses only with a selected leg", () => {
    expect(selectBinding(selectOpts({ leg: legOpts() })).touchPress).toBe(true);
    expect(selectBinding(selectOpts()).touchPress).toBeFalsy();
  });

  it("a touch press takes a bend at 10 px and declines it at 16 px; the mouse's reach stays 7 px", () => {
    const corner = legOpts({ bends: [{ x: 20, y: 10 }] });
    expect(selectBinding(selectOpts({ leg: corner })).onPointerDown!(touch(21, 10))).toBe(true);
    const o = selectOpts({ leg: corner });
    expect(selectBinding(o).onPointerDown!(touch(21.6, 10))).toBe(false);
    expect(o.gesture.current).toBeNull();
    expect(selectBinding(selectOpts({ leg: corner })).onPointerDown!(ptr(21, 10))).toBe(false);
  });

  it("a touch press takes a grip at 10 px (off the bend's reach)", () => {
    const o = selectOpts({ leg: legOpts({ bends: [{ x: 20, y: 10, hIn: { x: -4, y: 0 }, hOut: { x: 4, y: 0 } }] }) });
    expect(selectBinding(o).onPointerDown!(touch(24, 11))).toBe(true);
    expect(o.gesture.current).toMatchObject({ kind: "bend-grip", index: 0, which: "out" });
  });

  it("a touch press declines everything else: an object, a site, empty map (the viewer's targets and the tap path keep them)", () => {
    const o = selectOpts({ leg: legOpts(), selected: square(4) });
    const b = selectBinding(o);
    expect(b.onPointerDown!(touch(5, 5, { target: { kind: "object", id: 4 } }))).toBe(false);
    expect(b.onPointerDown!(touch(0, 0))).toBe(false);
    expect(b.onPointerDown!(touch(5, 5, { target: { kind: "site", id: "31" } }))).toBe(false);
    expect(o.gesture.current).toBeNull();
    expect(o.onSelectObject).not.toHaveBeenCalled();
  });

  it("onPointerDrag returns the placed point: the snapped bend, the dragged grip; nothing within the slop", () => {
    const o = selectOpts({ leg: legOpts({ snap: (p) => ({ x: Math.round(p.x), y: Math.round(p.y) }) }) });
    const b = selectBinding(o);
    b.onPointerDown!(touch(20.5, 10));
    expect(b.onPointerDrag!({ x: 20.6, y: 10 })).toBeUndefined();
    expect(b.onPointerDrag!({ x: 23.4, y: 5.2 })).toEqual({ x: 23, y: 5 });
    b.onPointerUp!({ x: 23.4, y: 5.2 });
    expect(o.leg!.onBendsChange).toHaveBeenCalledWith([{ ...SMOOTH, x: 23, y: 5 }]);

    const g = selectOpts({ leg: legOpts() });
    const bg = selectBinding(g);
    bg.onPointerDown!(touch(22, 10));
    expect(bg.onPointerDrag!({ x: 22, y: 14 }, { shift: false, alt: false })).toEqual({ x: 22, y: 14 });
  });

  it("onPointerDrag returns an object's dragged vertex or grip, and nothing for a body drag or a lasso", () => {
    const sel = square(4);
    const o = selectOpts({ selected: sel, objects: [sel] });
    const b = selectBinding(o);
    b.onPointerDown!(ptr(10, 10));
    expect(b.onPointerDrag!({ x: 12, y: 13 }, { shift: false, alt: false })).toEqual({ x: 12, y: 13 });
    b.onPointerUp!(null);
    b.onPointerDown!(ptr(5, 5, { target: { kind: "object", id: 4 } }));
    expect(b.onPointerDrag!({ x: 7, y: 7 }, { shift: false, alt: false })).toBeUndefined();
    b.onPointerUp!(null);
    b.onPointerDown!(ptr(60, 60, { shift: true }));
    expect(b.onPointerDrag!({ x: 61, y: 61 })).toBeUndefined();
    b.onPointerUp!(null);

    const curved = { ...square(5, "oob_line"), geometry: [{ x: 0, y: 0, hOut: { x: 3, y: 0 } }, { x: 10, y: 0 }] } as course.CourseObject;
    const c = selectOpts({ selected: curved, objects: [curved] });
    const bc = selectBinding(c);
    bc.onPointerDown!(ptr(3, 0));
    expect(c.gesture.current).toMatchObject({ kind: "grip" });
    expect(bc.onPointerDrag!({ x: 3, y: 2 }, { shift: false, alt: false })).toEqual({ x: 3, y: 2 });
  });

  it("a tap focuses the bend and writes nothing; a cancel (a second finger) drops the draft with no write", () => {
    const o = selectOpts({ leg: legOpts() });
    const b = selectBinding(o);
    b.onPointerDown!(touch(20.8, 10));
    b.onPointerUp!({ x: 20.8, y: 10 });
    expect(o.leg!.onBendFocus).toHaveBeenCalledWith(0);
    expect(o.leg!.onBendsChange).not.toHaveBeenCalled();
    b.onPointerDown!(touch(20.8, 10));
    b.onPointerDrag!({ x: 20, y: 5 });
    expect(o.leg!.onBendsDraft).toHaveBeenLastCalledWith([{ ...SMOOTH, x: 20, y: 5 }]);
    b.onPointerUp!(null);
    expect(o.leg!.onBendsDraft).toHaveBeenLastCalledWith(null);
    expect(o.leg!.onBendsChange).not.toHaveBeenCalled();
  });
});

describe("corridor guides (docs/course-editor.md §6.7, F14)", () => {
  const guides = [
    { course: "A", index: 0, points: [{ x: 0, y: 0 }, { x: 20, y: 0 }] },
    { course: "A", index: 2, points: [{ x: 20, y: 0 }, { x: 25, y: 5 }, { x: 40, y: 10 }] },
  ];

  it("one blue dashed line per corridor leg, along its derived points, under the tool's own shapes", () => {
    const base = selectBinding(selectOpts({ selected: square(4) }));
    const b = withCorridorGuides(base, guides)!;
    const drawn = b.shapes!.filter((s) => s.testId === "editor-corridor-guide");
    expect(drawn).toEqual([
      { kind: "line", points: guides[0].points, dashed: true, color: "#2563eb", testId: "editor-corridor-guide", data: { course: "A", leg: "0" } },
      { kind: "line", points: guides[1].points, dashed: true, color: "#2563eb", testId: "editor-corridor-guide", data: { course: "A", leg: "2" } },
    ]);
    expect(b.shapes!.slice(0, 2)).toEqual(drawn);
    expect(b.shapes!.slice(2)).toEqual(base.shapes);
  });

  it("keeps the tool's hooks; a press on a guide is the viewer's (the leg click through the UI legs)", () => {
    const o = selectOpts();
    const b = withCorridorGuides(selectBinding(o), guides)!;
    expect(b.onPointerDown!(ptr(10, 0, { target: { kind: "leg", courseId: "A", index: 0 } }))).toBe(false);
    const area = areaBinding({ gesture: { current: null }, poly: { kind: "oob_area" as const, vertices: [] }, hover: null, onHover: vi.fn(), snap: (p) => p, onPoly: vi.fn(), onDone: vi.fn(), onCancel: vi.fn() });
    const armed = withCorridorGuides(area, guides)!;
    expect(armed.exclusive).toBe(area.exclusive);
    expect(armed.onClick).toBe(area.onClick);
  });

  it("no guides: the binding unchanged; no binding: the guides alone", () => {
    const base = selectBinding(selectOpts());
    expect(withCorridorGuides(base, [])).toBe(base);
    expect(withCorridorGuides(null, [])).toBeNull();
    expect(withCorridorGuides(null, guides)!.shapes).toHaveLength(2);
    expect(withCorridorGuides(null, guides)!.onPointerDown).toBeUndefined();
  });
});
