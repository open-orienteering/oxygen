import { describe, expect, it } from "vitest";
import { convexHull, pointInPolygon, step, tonerSaverHull, type PolygonState } from "../tools/polygon";

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

describe("hulls", () => {
  it("convexHull drops interior and collinear points", () => {
    const h = convexHull([{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }, { x: 5, y: 5 }]);
    expect(h).toHaveLength(4);
  });

  it("the toner saver hull keeps every site at least the margin inside", () => {
    const sites = [{ x: 0, y: 0 }, { x: 40, y: 10 }, { x: 20, y: 30 }];
    const hull = tonerSaverHull(sites, 8)!;
    const edgeDist = (p: { x: number; y: number }) => Math.min(...hull.map((a, i) => {
      const b = hull[(i + 1) % hull.length];
      const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
      const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2));
      return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
    }));
    for (const s of sites) {
      expect(pointInPolygon(s, hull)).toBe(true);
      expect(edgeDist(s)).toBeGreaterThanOrEqual(8 - 1e-3);
    }
    expect(tonerSaverHull([], 8)).toBeNull();
  });
});
