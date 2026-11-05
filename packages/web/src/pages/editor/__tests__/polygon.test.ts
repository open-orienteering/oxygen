import { describe, expect, it } from "vitest";
import { isClosedKind, minVertices, step, type PolygonState } from "../tools/polygon";
import { vertexRule } from "../../../lib/editor/geometry-edit";

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

describe("smooth vertices while drawing: Alt (docs/course-editor.md §6.4)", () => {
  const alt = (s: PolygonState, x: number, y: number, onFirst = false) => step(s, { type: "click", pt: { x, y }, onFirst, smooth: true });
  const near = (a: { x: number; y: number } | undefined, x: number, y: number) => {
    expect(a).toBeDefined();
    expect(a!.x).toBeCloseTo(x, 9);
    expect(a!.y).toBeCloseTo(y, 9);
  };
  const noFlags = (done: readonly object[]) => done.forEach((v) => expect(v).not.toHaveProperty("smooth"));

  it("the flagged vertex gains its handles when the next one lands: hOut = (next − prev) / 6", () => {
    let s = alt(click(area, 0, 0).state, 10, 0).state;
    expect(s.vertices[1]).toEqual({ x: 10, y: 0, smooth: true }); // no next yet: a corner for now
    s = click(s, 10, 10).state;
    near(s.vertices[1].hOut, 10 / 6, 10 / 6);
    near(s.vertices[1].hIn, -10 / 6, -10 / 6);
    expect(s.vertices[1].smooth).toBe(true);
  });

  it("moving a neighbour or the vertex itself recomputes its handles", () => {
    let s = click(alt(click(area, 0, 0).state, 10, 0).state, 10, 10).state;
    s = step(s, { type: "move-vertex", index: 2, pt: { x: 16, y: 10 } }).state;
    near(s.vertices[1].hOut, 16 / 6, 10 / 6);
    s = step(s, { type: "move-vertex", index: 0, pt: { x: -6, y: 0 } }).state;
    near(s.vertices[1].hOut, 22 / 6, 10 / 6);
    s = step(s, { type: "move-vertex", index: 1, pt: { x: 50, y: 50 } }).state;
    expect(s.vertices[1]).toMatchObject({ x: 50, y: 50 });
    near(s.vertices[1].hOut, 22 / 6, 10 / 6);
  });

  it("a manual pull wins: the flag is cleared and the pulled handles survive a neighbour move", () => {
    let s = alt(click(area, 0, 0).state, 10, 0).state;
    s = step(s, { type: "pull-handles", index: 1, vec: { x: 3, y: 4 }, shift: false }).state;
    expect(s.vertices[1]).toEqual({ x: 10, y: 0, hOut: { x: 3, y: 4 }, hIn: { x: -3, y: -4 } });
    s = click(s, 10, 10).state;
    s = step(s, { type: "move-vertex", index: 0, pt: { x: -5, y: 0 } }).state;
    expect(s.vertices[1].hOut).toEqual({ x: 3, y: 4 });
    // A drag back within 3 px is a corner, not smooth again.
    const back = step(alt(click(area, 0, 0).state, 10, 0).state, { type: "pull-handles", index: 1, vec: { x: 0, y: 0 }, shift: false }).state;
    expect(click(back, 10, 10).state.vertices[1]).toEqual({ x: 10, y: 0 });
  });

  it("a filter region ignores Alt", () => {
    const fr: PolygonState = { kind: "filter_region", vertices: [] };
    let s = alt(click(fr, 0, 0).state, 10, 0).state;
    s = click(s, 10, 10).state;
    expect(s.vertices[1]).toEqual({ x: 10, y: 0 });
    expect(alt(s, 0, 0, true).done).toEqual([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }]);
  });

  it("closed kinds wrap at close; Alt on the closing click smooths the first vertex", () => {
    let s = click(area, 0, 0).state;
    s = click(s, 10, 0).state;
    s = alt(s, 10, 10).state; // the last vertex: smooth, no next while drawing
    expect(s.vertices[2]).toEqual({ x: 10, y: 10, smooth: true });
    const done = alt(s, 0, 0, true).done!;
    near(done[0].hOut, (10 - 10) / 6, (0 - 10) / 6); // next g1, prev g2 (the wrap)
    near(done[2].hOut, (0 - 10) / 6, (0 - 0) / 6); // next g0 (the wrap), prev g1
    expect(done[1]).toEqual({ x: 10, y: 0 });
    noFlags(done);
  });

  it("an open line's ends stay corners, a flagged middle vertex curves", () => {
    const line: PolygonState = { kind: "marked_route", vertices: [] };
    let s = alt(line, 0, 0).state;
    s = alt(s, 10, 0).state;
    s = alt(s, 10, 10).state;
    const done = step(s, { type: "enter" }).done!;
    expect(done[0]).toEqual({ x: 0, y: 0 });
    expect(done[2]).toEqual({ x: 10, y: 10 });
    near(done[1].hOut, 10 / 6, 10 / 6);
    noFlags(done);
  });

  it("every finishing path strips the flags; the state keeps them until then", () => {
    const s = alt(alt(alt(area, 0, 0).state, 10, 0).state, 10, 10).state;
    expect(s.vertices.every((v) => v.smooth)).toBe(true);
    noFlags(click(s, 0, 0, true).done!);
    noFlags(step(s, { type: "enter" }).done!);
    noFlags(step(s, { type: "double-click", pt: { x: 10, y: 10 } }).done!);
  });

  it("Alt on a double-click flags its new point; its first click is not added twice", () => {
    let s = click(click(area, 0, 0).state, 10, 0).state;
    const r = step(s, { type: "double-click", pt: { x: 10, y: 10 }, smooth: true });
    expect(r.state.vertices[2].smooth).toBe(true);
    near(r.done![2].hOut, (0 - 10) / 6, 0);
    s = alt(s, 10, 10).state; // the double-click's first press, with Alt
    expect(step(s, { type: "double-click", pt: { x: 10, y: 10 } }).state.vertices).toHaveLength(3);
  });

  it("without Alt nothing changes (touch never sets it)", () => {
    const s = click(click(click(area, 0, 0).state, 10, 0).state, 10, 10).state;
    expect(s.vertices).toEqual([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }]);
  });
});

describe("Layout's polygon (layout_path, D16)", () => {
  it("is a closed, curved kind of three or more vertices", () => {
    expect(isClosedKind("layout_path")).toBe(true);
    expect(minVertices("layout_path")).toBe(3);
    expect(vertexRule("layout_path")).toEqual({ min: 3, max: Infinity, curves: true, closed: true });
    const s: PolygonState = { kind: "layout_path", vertices: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }] };
    expect(step(s, { type: "click", pt: { x: 0, y: 0 }, onFirst: true }).done).toHaveLength(3);
  });
});
