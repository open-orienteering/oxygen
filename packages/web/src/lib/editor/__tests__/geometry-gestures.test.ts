import { describe, expect, it } from "vitest";
import {
  dragGeometry, geometryShapes, insertAtEdge, pressGeometry, releaseGeometry, type GeometryShapeIds,
} from "../geometry-gestures";
import { smoothHandles, vertexRule, type Vertex } from "../geometry-edit";

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
  });

  it("a vertex drag moves it by the whole offset, in the caller's units; until it moves, no geometry", () => {
    const d = pressGeometry(square, area, { pt: { x: 10, y: 10 }, reach: 0.5, shift: false }, false)!;
    expect(dragGeometry(d, { x: 10.01, y: 10 })).toBeNull();
    expect(dragGeometry(d, { x: 12, y: 13 })![2]).toEqual({ x: 12, y: 13 });
    expect(releaseGeometry(d, { x: 12, y: 13 }, area)).toEqual({ kind: "commit", geometry: [square[0], square[1], { x: 12, y: 13 }, square[3]] });
  });

  it("Alt-drag on a vertex moves it like a plain drag (F18: no handles pulled)", () => {
    const d = pressGeometry(square, area, { pt: { x: 10, y: 0 }, reach: 0.5, alt: true, shift: false }, false)!;
    expect(dragGeometry(d, { x: 14, y: 1 }, { shift: false, alt: true })![1]).toEqual({ x: 14, y: 1 });
    expect(releaseGeometry(d, { x: 14, y: 1 }, area)).toEqual({ kind: "commit", geometry: [square[0], { x: 14, y: 1 }, ...square.slice(2)] });
  });

  it("Alt-click toggles a vertex corner ⇄ smooth; an open end and kinds without curves write nothing", () => {
    const altClick = (g: Vertex[], rule: typeof area, at: { x: number; y: number }) =>
      releaseGeometry(pressGeometry(g, rule, { pt: at, reach: 0.5, alt: true, shift: false }, false)!, at, rule);
    const smooth = altClick(square, area, { x: 10, y: 0 });
    expect(smooth).toEqual({ kind: "commit", geometry: smoothHandles(square, 1, true) });
    expect(altClick((smooth as { geometry: Vertex[] }).geometry, area, { x: 10, y: 0 })).toEqual({ kind: "commit", geometry: square });
    // A closed area wraps at vertex 0; an open line's end has no smooth form.
    expect(altClick(square, area, { x: 0, y: 0 })).toEqual({ kind: "commit", geometry: smoothHandles(square, 0, true) });
    expect(altClick(square.slice(0, 3), vertexRule("oob_line"), { x: 0, y: 0 })).toBeNull();
    expect(altClick(square, vertexRule("filter_region"), { x: 10, y: 0 })).toBeNull();
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

  it("a double-click on an edge inserts a smooth vertex there, off the vertices; Alt a corner; the new index is returned", () => {
    const withNew = [...square.slice(0, 3), { x: 5, y: 10 }, square[3]];
    // Smooth on a straight edge: collinear handles, so the shape stays until the vertex moves.
    const smooth = insertAtEdge(square, area, { x: 5, y: 10.2 }, 0.5)!;
    expect(smooth).toEqual({ geometry: smoothHandles(withNew, 3, true), index: 3 });
    expect(smooth.geometry[3].hOut!.y).toBeCloseTo(0, 9);
    expect(insertAtEdge(square, area, { x: 5, y: 10.2 }, 0.5, true)).toEqual({ geometry: withNew, index: 3 });
    // A filter region is a polygon: a corner, Alt or not.
    expect(insertAtEdge(square, vertexRule("filter_region"), { x: 5, y: 10.2 }, 0.5)).toEqual({ geometry: withNew, index: 3 });
    expect(insertAtEdge(square, area, { x: 0.1, y: 0 }, 0.5)).toBeNull();
    expect(insertAtEdge(square, area, { x: 5, y: 5 }, 0.5)).toBeNull();
    expect(insertAtEdge(square.slice(0, 2), vertexRule("image"), { x: 5, y: 0 }, 0.5)).toBeNull();
  });

  it("on a curve the split keeps the shape (the new vertex smooth); Alt retracts the new vertex's handles", () => {
    const curved: Vertex[] = [{ x: 0, y: 0, hOut: { x: 4, y: -4 } }, { x: 10, y: 0, hIn: { x: -4, y: -4 } }, square[2], square[3]];
    const split = insertAtEdge(curved, area, { x: 5, y: -3 }, 0.5)!;
    expect(split.index).toBe(1);
    expect(split.geometry[1].hIn && split.geometry[1].hOut).toBeTruthy();
    const corner = insertAtEdge(curved, area, { x: 5, y: -3 }, 0.5, true)!;
    expect(corner.geometry[1]).toEqual({ x: split.geometry[1].x, y: split.geometry[1].y });
    expect(corner.geometry[0]).toEqual(split.geometry[0]);
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
