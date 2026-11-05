import { describe, expect, it } from "vitest";
import {
  dragGeometry, geometryShapes, insertAtEdge, pressGeometry, releaseGeometry, type GeometryShapeIds,
} from "../geometry-gestures";
import { vertexRule, type Vertex } from "../geometry-edit";

// The gestures are in the path's own units (D16): the course editor's paper mm, Layout's page mm. The caller
// converts the pointer and the reach; `selectBinding`'s cases in bindings.test.ts are the behaviour net.
const square: Vertex[] = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }];
const area = vertexRule("layout_path");
const ids: GeometryShapeIds = { outline: "o", handle: "h", grip: "g" };

describe("geometry gestures (docs/course-editor.md §7 \"Editing geometry\")", () => {
  it("pressing order: vertex, grip, edge within reach; the inside is no press (it pans)", () => {
    const curved: Vertex[] = [{ x: 0, y: 0, hOut: { x: 3, y: 0 } }, ...square.slice(1)];
    expect(pressGeometry(curved, area, { pt: { x: 0.2, y: 0 }, reach: 0.5, shift: false }, false)).toMatchObject({ kind: "object", vertex: 0 });
    expect(pressGeometry(curved, area, { pt: { x: 3, y: 0.1 }, reach: 0.5, shift: false }, false)).toMatchObject({ kind: "grip", index: 0, which: "out" });
    expect(pressGeometry(curved, area, { pt: { x: 6, y: 9.8 }, reach: 0.5, shift: false }, false)).toMatchObject({ kind: "object", vertex: null });
    expect(pressGeometry(curved, area, { pt: { x: 5, y: 5 }, reach: 0.5, shift: false }, false)).toBeNull();
    // The caller's hit-test said "on the body" (an open line, a text): the whole path.
    expect(pressGeometry(curved, area, { pt: { x: 5, y: 5 }, reach: 0.5, shift: false }, true)).toMatchObject({ vertex: null });
    // Alt on a vertex pulls handles only for kinds that curve.
    expect(pressGeometry(square, vertexRule("filter_region"), { pt: { x: 0, y: 0 }, reach: 0.5, alt: true, shift: false }, false)).toMatchObject({ alt: false });
  });

  it("a vertex drag moves it by the whole offset, in the caller's units; until it moves, no geometry", () => {
    const d = pressGeometry(square, area, { pt: { x: 10, y: 10 }, reach: 0.5, shift: false }, false)!;
    expect(dragGeometry(d, { x: 10.01, y: 10 })).toBeNull();
    expect(dragGeometry(d, { x: 12, y: 13 })![2]).toEqual({ x: 12, y: 13 });
    expect(releaseGeometry(d, { x: 12, y: 13 }, area)).toEqual({ kind: "commit", geometry: [square[0], square[1], { x: 12, y: 13 }, square[3]] });
  });

  it("Alt-drag on a vertex pulls symmetric handles (Shift: 45°); Alt-click retracts", () => {
    const d = pressGeometry(square, area, { pt: { x: 10, y: 0 }, reach: 0.5, alt: true, shift: false }, false)!;
    const g = dragGeometry(d, { x: 14, y: 1 }, { shift: true, alt: true })!;
    expect(g[1].hOut!.y).toBeCloseTo(0, 9);
    expect(g[1].hIn!.x).toBeLessThan(0);
    const curved = releaseGeometry(d, { x: 14, y: 1 }, area);
    expect(curved?.kind).toBe("commit");
    const geometry = (curved as { geometry: Vertex[] }).geometry;
    const click = pressGeometry(geometry, area, { pt: { x: 10, y: 0 }, reach: 0.5, alt: true, shift: false }, false)!;
    expect(releaseGeometry(click, { x: 10, y: 0 }, area)).toEqual({ kind: "commit", geometry: square });
  });

  it("a click focuses a vertex (none for fixed kinds), on the body unfocuses; a cancelled drag drops its draft", () => {
    const click = pressGeometry(square, area, { pt: { x: 0, y: 10 }, reach: 0.5, shift: false }, false)!;
    expect(releaseGeometry(click, { x: 0, y: 10 }, area)).toEqual({ kind: "focus", index: 3 });
    const fixed = pressGeometry(square.slice(0, 2), vertexRule("image"), { pt: { x: 0, y: 0 }, reach: 0.5, shift: false }, false)!;
    expect(releaseGeometry(fixed, { x: 0, y: 0 }, vertexRule("image"))).toEqual({ kind: "focus", index: null });
    const body = pressGeometry(square, area, { pt: { x: 5, y: 0.1 }, reach: 0.5, shift: false }, false)!;
    expect(releaseGeometry(body, { x: 5, y: 0.1 }, area)).toEqual({ kind: "focus", index: null });
    const drag = pressGeometry(square, area, { pt: { x: 5, y: 0.1 }, reach: 0.5, shift: false }, false)!;
    dragGeometry(drag, { x: 8, y: 2 });
    expect(releaseGeometry(drag, null, area)).toEqual({ kind: "cancel" });
  });

  it("a double-click on an edge inserts there, off the vertices; the new index is returned", () => {
    expect(insertAtEdge(square, area, { x: 5, y: 10.2 }, 0.5)).toEqual({ geometry: [...square.slice(0, 3), { x: 5, y: 10 }, square[3]], index: 3 });
    expect(insertAtEdge(square, area, { x: 0.1, y: 0 }, 0.5)).toBeNull();
    expect(insertAtEdge(square, area, { x: 5, y: 5 }, 0.5)).toBeNull();
    expect(insertAtEdge(square.slice(0, 2), vertexRule("image"), { x: 5, y: 0 }, 0.5)).toBeNull();
  });

  it("shapes: the outline, a handle per vertex (focused marked), a grip per handle, with the caller's ids", () => {
    const g: Vertex[] = [{ x: 0, y: 0, hOut: { x: 3, y: 0 }, hIn: { x: -3, y: 0 } }, ...square.slice(1)];
    const shapes = geometryShapes(g, true, { selected: true, focused: 1, ids });
    expect(shapes.filter((s) => "testId" in s && s.testId === "o")).toHaveLength(1);
    expect(shapes.filter((s) => s.kind === "handle")).toHaveLength(4);
    expect(shapes.filter((s) => s.kind === "grip")).toHaveLength(2);
    expect(shapes.find((s) => s.kind === "handle" && s.active)).toMatchObject({ data: { index: "1", focused: "true" } });
    expect(geometryShapes(g, true, { selected: false, ids }).map((s) => s.kind)).toEqual(["line"]);
  });
});
