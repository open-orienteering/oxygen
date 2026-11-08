import { describe, expect, it } from "vitest";
import { isClosedKind, minVertices, step, type PolygonState } from "../tools/polygon";
import { vertexRule } from "../../../lib/editor/geometry-edit";

const area: PolygonState = { kind: "oob_area", vertices: [] };
const click = (s: PolygonState, x: number, y: number, onFirst = false) => step(s, { type: "click", pt: { x, y }, onFirst });

const near = (a: { x: number; y: number } | undefined, x: number, y: number) => {
  expect(a).toBeDefined();
  expect(a!.x).toBeCloseTo(x, 9);
  expect(a!.y).toBeCloseTo(y, 9);
};
/** Alt at the press: a corner (F18). */
const corner = (s: PolygonState, x: number, y: number, onFirst = false) => step(s, { type: "click", pt: { x, y }, onFirst, corner: true });
const noFlags = (done: readonly object[]) => done.forEach((v) => {
  expect(v).not.toHaveProperty("corner");
  expect(v).not.toHaveProperty("pulled");
  expect(v).not.toHaveProperty("smooth");
});

describe("polygon flow (docs/course-editor.md §6.4)", () => {
  it("click per vertex, a click on the first vertex closes from three", () => {
    let s = click(area, 0, 0).state;
    s = click(s, 10, 0).state;
    expect(click(s, 0, 0, true).done).toBeNull(); // two vertices: not closable, the click adds one
    s = click(s, 10, 10).state;
    const closed = click(s, 0, 0, true);
    expect(closed.done!.map(({ x, y }) => ({ x, y }))).toEqual([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }]);
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

describe("curve vertices while drawing: click-drag (docs/course-editor.md §6.4)", () => {
  const pull = (s: PolygonState, index: number, x: number, y: number, shift = false) => step(s, { type: "pull-handles", index, vec: { x, y }, shift }).state;

  it("click-drag pulls symmetric handles on the vertex: hOut the drag, hIn its negation", () => {
    let s = click(click(area, 0, 0).state, 10, 0).state;
    s = pull(s, 1, 3, 4);
    expect(s.vertices[1]).toEqual({ x: 10, y: 0, hOut: { x: 3, y: 4 }, hIn: { x: -3, y: -4 }, pulled: true });
    s = click(s, 10, 10).state;
    const done = click(s, 0, 0, true).done!;
    expect(done[1]).toEqual({ x: 10, y: 0, hOut: { x: 3, y: 4 }, hIn: { x: -3, y: -4 } });
  });

  it("Shift constrains the handle to 45°; back to zero restores the press's kind", () => {
    let s = click(area, 0, 0).state;
    s = pull(s, 0, 10, 1, true);
    expect(s.vertices[0].hOut!.y).toBeCloseTo(0);
    expect(pull(s, 0, 0, 0).vertices[0]).toEqual({ x: 0, y: 0 });
    // A plain press is smooth again once its neighbours land; an Alt press a corner.
    const back = (s0: PolygonState) => click(pull(pull(s0, 1, 3, 4), 1, 0, 0), 10, 10).state.vertices[1];
    near(back(click(click(area, 0, 0).state, 10, 0).state).hOut, 10 / 6, 10 / 6);
    expect(back(corner(click(area, 0, 0).state, 10, 0).state)).toEqual({ x: 10, y: 0, corner: true });
  });

  it("a filter region stays a polygon", () => {
    const s = click({ kind: "filter_region", vertices: [] }, 0, 0).state;
    expect(pull(s, 0, 3, 4)).toBe(s);
  });

  it("moving a curve vertex keeps its handles", () => {
    let s = pull(click(area, 0, 0).state, 0, 1, 1);
    s = step(s, { type: "move-vertex", index: 0, pt: { x: 2, y: 2 } }).state;
    expect(s.vertices[0]).toEqual({ x: 2, y: 2, hOut: { x: 1, y: 1 }, hIn: { x: -1, y: -1 }, pulled: true });
  });
});

describe("smooth by default, Alt for a corner (F18, docs/course-editor.md §6.4)", () => {
  it("a placed vertex gains its handles when the next one lands: hOut = (next − prev) / 6", () => {
    let s = click(click(area, 0, 0).state, 10, 0).state;
    expect(s.vertices[1]).toEqual({ x: 10, y: 0 }); // no next yet: a corner for now
    s = click(s, 10, 10).state;
    near(s.vertices[1].hOut, 10 / 6, 10 / 6);
    near(s.vertices[1].hIn, -10 / 6, -10 / 6);
  });

  it("moving a neighbour or the vertex itself recomputes its handles", () => {
    let s = click(click(click(area, 0, 0).state, 10, 0).state, 10, 10).state;
    s = step(s, { type: "move-vertex", index: 2, pt: { x: 16, y: 10 } }).state;
    near(s.vertices[1].hOut, 16 / 6, 10 / 6);
    s = step(s, { type: "move-vertex", index: 0, pt: { x: -6, y: 0 } }).state;
    near(s.vertices[1].hOut, 22 / 6, 10 / 6);
    s = step(s, { type: "move-vertex", index: 1, pt: { x: 50, y: 50 } }).state;
    expect(s.vertices[1]).toMatchObject({ x: 50, y: 50 });
    near(s.vertices[1].hOut, 22 / 6, 10 / 6);
  });

  it("a manual pull wins: the pulled handles survive a neighbour move", () => {
    let s = click(click(area, 0, 0).state, 10, 0).state;
    s = step(s, { type: "pull-handles", index: 1, vec: { x: 3, y: 4 }, shift: false }).state;
    s = click(s, 10, 10).state;
    s = step(s, { type: "move-vertex", index: 0, pt: { x: -5, y: 0 } }).state;
    expect(s.vertices[1].hOut).toEqual({ x: 3, y: 4 });
  });

  it("Alt at the press places a corner: no handles when its neighbours land or move", () => {
    let s = corner(click(area, 0, 0).state, 10, 0).state;
    expect(s.vertices[1]).toEqual({ x: 10, y: 0, corner: true });
    s = click(s, 10, 10).state;
    s = step(s, { type: "move-vertex", index: 2, pt: { x: 16, y: 10 } }).state;
    expect(s.vertices[1]).toEqual({ x: 10, y: 0, corner: true });
    expect(click(s, 0, 0, true).done![1]).toEqual({ x: 10, y: 0 });
  });

  it("a filter region is a polygon: no handles, Alt ignored", () => {
    const fr: PolygonState = { kind: "filter_region", vertices: [] };
    let s = corner(click(fr, 0, 0).state, 10, 0).state;
    s = click(s, 10, 10).state;
    expect(s.vertices.map(({ x, y }) => ({ x, y }))).toEqual([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }]);
    expect(click(s, 0, 0, true).done).toEqual([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }]);
    expect(corner(s, 0, 0, true).done).toEqual([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }]);
  });

  it("closed kinds wrap at close; Alt on the closing click makes the first vertex a corner", () => {
    const s = click(click(click(area, 0, 0).state, 10, 0).state, 10, 10).state;
    expect(s.vertices[2]).toEqual({ x: 10, y: 10 }); // the last vertex: no next while drawing
    const smooth = click(s, 0, 0, true).done!;
    near(smooth[0].hOut, (10 - 10) / 6, (0 - 10) / 6); // next g1, prev g2 (the wrap)
    near(smooth[1].hOut, 10 / 6, 10 / 6);
    near(smooth[2].hOut, (0 - 10) / 6, (0 - 0) / 6); // next g0 (the wrap), prev g1
    noFlags(smooth);
    const sharp = corner(s, 0, 0, true).done!;
    expect(sharp[0]).toEqual({ x: 0, y: 0 });
    near(sharp[2].hOut, (0 - 10) / 6, 0);
    noFlags(sharp);
  });

  it("an open line's ends stay corners, its middle vertices curve", () => {
    const line: PolygonState = { kind: "marked_route", vertices: [] };
    const s = click(click(click(line, 0, 0).state, 10, 0).state, 10, 10).state;
    const done = step(s, { type: "enter" }).done!;
    expect(done[0]).toEqual({ x: 0, y: 0 });
    expect(done[2]).toEqual({ x: 10, y: 10 });
    near(done[1].hOut, 10 / 6, 10 / 6);
    noFlags(done);
  });

  it("every finishing path strips the flags; the state keeps them until then", () => {
    let s = corner(corner(click(area, 0, 0).state, 10, 0).state, 10, 10).state;
    s = step(s, { type: "pull-handles", index: 0, vec: { x: 1, y: 1 }, shift: false }).state;
    expect(s.vertices.map((v) => [v.corner, v.pulled])).toEqual([[undefined, true], [true, undefined], [true, undefined]]);
    noFlags(click(s, 0, 0, true).done!);
    noFlags(step(s, { type: "enter" }).done!);
    noFlags(step(s, { type: "double-click", pt: { x: 10, y: 10 } }).done!);
  });

  it("Alt on a double-click makes its new point a corner; its first click is not added twice", () => {
    let s = click(click(area, 0, 0).state, 10, 0).state;
    const r = step(s, { type: "double-click", pt: { x: 10, y: 10 }, corner: true });
    expect(r.state.vertices[2].corner).toBe(true);
    expect(r.done![2]).toEqual({ x: 10, y: 10 });
    near(r.done![0].hOut, 0, -10 / 6); // the others smooth, the ring wrapped
    s = corner(s, 10, 10).state; // the double-click's first press, with Alt
    expect(step(s, { type: "double-click", pt: { x: 10, y: 10 } }).state.vertices).toHaveLength(3);
  });

  it("the drawing state stores no flag for a plain click (smooth is the default)", () => {
    const s = click(click(click(area, 0, 0).state, 10, 0).state, 10, 10).state;
    expect(s.vertices.map(({ x, y }) => ({ x, y }))).toEqual([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }]);
    noFlags(s.vertices);
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
