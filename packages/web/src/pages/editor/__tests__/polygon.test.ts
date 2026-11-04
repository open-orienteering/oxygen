import { describe, expect, it } from "vitest";
import { step, type PolygonState } from "../tools/polygon";

const area: PolygonState = { kind: "oob_area", vertices: [] };
const click = (s: PolygonState, x: number, y: number, onFirst = false) => step(s, { type: "click", pt: { x, y }, onFirst });

describe("polygon flow (docs/course-editor.md §6.4)", () => {
  it("click per vertex, a click on the first vertex closes from three", () => {
    let s = click(area, 0, 0).state;
    s = click(s, 10, 0).state;
    expect(click(s, 0, 0, true).done).toBeNull(); // two vertices: not closable, the click adds one
    s = click(s, 10, 10).state;
    const closed = click(s, 0, 0, true);
    expect(closed.done).toEqual([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }]);
  });

  it("double-click closes with its point; its first click is not added twice", () => {
    let s = click(area, 0, 0).state;
    s = click(s, 10, 0).state;
    s = click(s, 10, 10).state; // the double-click's first click
    const r = step(s, { type: "double-click", pt: { x: 10, y: 10 } });
    expect(r.done).toHaveLength(3);
  });

  it("a double-click short of the minimum keeps drawing", () => {
    const s = click(area, 0, 0).state;
    expect(step(s, { type: "double-click", pt: { x: 5, y: 5 } }).done).toBeNull();
  });

  it("line kinds end by double-click or Enter from two vertices and never close on the first vertex", () => {
    let s: PolygonState = { kind: "marked_route", vertices: [] };
    s = click(s, 0, 0).state;
    expect(step(s, { type: "enter" }).done).toBeNull();
    s = click(s, 5, 0).state;
    s = click(s, 0, 0, true).state; // not a close: a vertex
    expect(s.vertices).toHaveLength(3);
    expect(step(s, { type: "enter" }).done).toHaveLength(3);
  });

  it("a vertex can be dragged before closing", () => {
    let s = click(click(area, 0, 0).state, 10, 0).state;
    s = step(s, { type: "move-vertex", index: 1, pt: { x: 12, y: 1 } }).state;
    expect(s.vertices[1]).toEqual({ x: 12, y: 1 });
    expect(step(s, { type: "move-vertex", index: 5, pt: { x: 0, y: 0 } }).state).toBe(s);
  });
});

describe("curve vertices while drawing (docs/course-editor.md §6.4)", () => {
  const pull = (s: PolygonState, index: number, x: number, y: number, shift = false) => step(s, { type: "pull-handles", index, vec: { x, y }, shift }).state;

  it("click-drag pulls symmetric handles on the vertex: hOut the drag, hIn its negation", () => {
    let s = click(click(area, 0, 0).state, 10, 0).state;
    s = pull(s, 1, 3, 4);
    expect(s.vertices[1]).toEqual({ x: 10, y: 0, hOut: { x: 3, y: 4 }, hIn: { x: -3, y: -4 } });
    s = click(s, 10, 10).state;
    const done = click(s, 0, 0, true).done!;
    expect(done[1].hOut).toEqual({ x: 3, y: 4 });
  });

  it("Shift constrains the handle to 45°; back to zero is a corner again", () => {
    let s = click(area, 0, 0).state;
    s = pull(s, 0, 10, 1, true);
    expect(s.vertices[0].hOut!.y).toBeCloseTo(0);
    expect(pull(s, 0, 0, 0).vertices[0]).toEqual({ x: 0, y: 0 });
  });

  it("a filter region stays a polygon", () => {
    const s = click({ kind: "filter_region", vertices: [] }, 0, 0).state;
    expect(pull(s, 0, 3, 4)).toBe(s);
  });

  it("moving a curve vertex keeps its handles", () => {
    let s = pull(click(area, 0, 0).state, 0, 1, 1);
    s = step(s, { type: "move-vertex", index: 0, pt: { x: 2, y: 2 } }).state;
    expect(s.vertices[0]).toEqual({ x: 2, y: 2, hOut: { x: 1, y: 1 }, hIn: { x: -1, y: -1 } });
  });
});
