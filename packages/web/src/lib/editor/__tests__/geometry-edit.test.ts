import { describe, expect, it } from "vitest";
import { course } from "@oxygen/shared";
import {
  CURVE_STEPS, constrain45, deleteVertex, dragGrip, hasHandles, insertVertex, nearestEdge, outlinePoints, retractHandles,
  sampleSegment, symmetricHandles, vertexRule, type Vertex,
} from "../geometry-edit";

const square: Vertex[] = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }];
const close = (a: { x: number; y: number }, b: { x: number; y: number }, eps = 1e-9) => Math.hypot(a.x - b.x, a.y - b.y) < eps;

describe("outline sampling (docs/course-editor.md §7 \"Editing geometry\")", () => {
  it("a straight segment is its end point", () => {
    expect(sampleSegment({ x: 0, y: 0 }, { x: 10, y: 0 })).toEqual([{ x: 10, y: 0 }]);
  });

  it("a curved segment is 8 samples ending on its end point, on the cubic", () => {
    const a: Vertex = { x: 0, y: 0, hOut: { x: 0, y: 10 } };
    const b: Vertex = { x: 10, y: 0, hIn: { x: 0, y: 10 } };
    const s = sampleSegment(a, b);
    expect(s).toHaveLength(CURVE_STEPS);
    expect(s[CURVE_STEPS - 1]).toEqual({ x: 10, y: 0 });
    // t = 0.5 of (0,0) (0,10) (10,10) (10,0): (5, 7.5)
    expect(close(s[CURVE_STEPS / 2 - 1], { x: 5, y: 7.5 })).toBe(true);
  });

  it("the outline of a closed path includes a curved closing segment; a straight one closes by itself", () => {
    expect(outlinePoints(square, true)).toEqual(square);
    const curved = square.map((v, i) => (i === 0 ? { ...v, hIn: { x: 0, y: 5 } } : v));
    const ring = outlinePoints(curved, true);
    expect(ring).toHaveLength(4 + CURVE_STEPS);
    expect(ring[ring.length - 1]).toEqual({ x: 0, y: 0 });
  });

  it("an open path never closes", () => {
    const line: Vertex[] = [{ x: 0, y: 0, hIn: { x: 0, y: 3 } }, { x: 10, y: 0 }];
    expect(outlinePoints(line, false)).toEqual([{ x: 0, y: 0 }, { x: 10, y: 0 }]);
  });
});

describe("nearest edge", () => {
  it("finds the segment and its parameter, the closing one on a closed path", () => {
    expect(nearestEdge(square, true, { x: 5, y: -0.2 })).toMatchObject({ index: 0, t: 0.5 });
    const e = nearestEdge(square, true, { x: -0.1, y: 2.5 })!;
    expect(e.index).toBe(3);
    expect(e.t).toBeCloseTo(0.75);
    expect(nearestEdge(square, false, { x: -0.1, y: 2.5 })!.index).not.toBe(3);
  });

  it("follows a curve, not its chord", () => {
    const g: Vertex[] = [{ x: 0, y: 0, hOut: { x: 0, y: 10 } }, { x: 10, y: 0, hIn: { x: 0, y: 10 } }];
    const e = nearestEdge(g, false, { x: 5, y: 7.5 })!;
    expect(e.dist).toBeLessThan(0.05);
    expect(e.t).toBeCloseTo(0.5, 1);
  });
});

describe("insert a vertex", () => {
  it("on a straight edge: a corner at the point", () => {
    const g = insertVertex(square, true, 0, 0.5);
    expect(g).toHaveLength(5);
    expect(g[1]).toEqual({ x: 5, y: 0 });
  });

  it("on the closing edge it goes last", () => {
    const g = insertVertex(square, true, 3, 0.5);
    expect(g[4]).toEqual({ x: 0, y: 5 });
  });

  it("on a curved closing edge: appended, the first vertex's hIn shortened", () => {
    const g: Vertex[] = [{ x: 0, y: 0, hIn: { x: -4, y: 0 } }, { x: 10, y: 0 }, { x: 10, y: 10 }];
    const out = insertVertex(g, true, 2, 0.5);
    expect(out).toHaveLength(4);
    expect(out[3].hIn && out[3].hOut).toBeTruthy();
    expect(out[0].hIn!.x).toBeCloseTo(-2);
    const before = sampleSegment(g[2], g[0], 2)[0];
    expect(close(out[3], before)).toBe(true);
  });

  it("on a curve: split so the shape is unchanged (de Casteljau)", () => {
    const g: Vertex[] = [{ x: 0, y: 0, hOut: { x: 0, y: 10 } }, { x: 10, y: 0, hIn: { x: 0, y: 10 } }];
    const out = insertVertex(g, false, 0, 0.5);
    expect(out).toHaveLength(3);
    expect(close(out[1], { x: 5, y: 7.5 })).toBe(true);
    // The two halves trace the original: their midpoints are the original's t = 0.25 / 0.75.
    const before = sampleSegment(g[0], g[1], 4);
    const left = sampleSegment(out[0], out[1], 2);
    const right = sampleSegment(out[1], out[2], 2);
    expect(close(left[0], before[0], 1e-9)).toBe(true);
    expect(close(right[0], before[2], 1e-9)).toBe(true);
    // The new vertex is smooth: its handles are opposite.
    const v = out[1];
    expect(v.hIn!.x * v.hOut!.y - v.hIn!.y * v.hOut!.x).toBeCloseTo(0);
  });
});

describe("delete a vertex", () => {
  it("removes it down to the kind's minimum", () => {
    expect(deleteVertex(square, 1, 3)).toEqual([square[0], square[2], square[3]]);
    expect(deleteVertex(square.slice(0, 3), 0, 3)).toBeNull();
    expect(deleteVertex(square, 9, 3)).toBeNull();
  });
});

describe("handles", () => {
  it("Alt-drag pulls symmetric handles; a zero drag retracts", () => {
    const g = symmetricHandles(square, 1, { x: 2, y: 3 });
    expect(g[1]).toEqual({ x: 10, y: 0, hOut: { x: 2, y: 3 }, hIn: { x: -2, y: -3 } });
    expect(g[0]).toBe(square[0]);
    expect(hasHandles(g[1])).toBe(true);
    expect(symmetricHandles(g, 1, { x: 0, y: 0 })[1]).toEqual({ x: 10, y: 0 });
  });

  it("retract drops both handles", () => {
    expect(retractHandles(symmetricHandles(square, 2, { x: 1, y: 1 }), 2)[2]).toEqual({ x: 10, y: 10 });
  });

  it("a grip drag keeps mirrored handles mirrored", () => {
    const g = symmetricHandles(square, 1, { x: 2, y: 0 });
    expect(dragGrip(g, 1, "out", { x: 0, y: 4 }, false)[1]).toMatchObject({ hOut: { x: 0, y: 4 }, hIn: { x: -0, y: -4 } });
  });

  it("a grip drag keeps collinear handles collinear, the other's length kept", () => {
    const g: Vertex[] = [{ x: 0, y: 0, hIn: { x: -1, y: 0 }, hOut: { x: 3, y: 0 } }, { x: 10, y: 0 }];
    const v = dragGrip(g, 0, "out", { x: 0, y: 5 }, false)[0];
    expect(v.hOut).toEqual({ x: 0, y: 5 });
    expect(v.hIn!.x).toBeCloseTo(0);
    expect(v.hIn!.y).toBeCloseTo(-1);
  });

  it("Alt on a grip breaks the symmetry; broken handles move alone", () => {
    const g = symmetricHandles(square, 1, { x: 2, y: 0 });
    const broken = dragGrip(g, 1, "in", { x: 0, y: 3 }, true);
    expect(broken[1]).toMatchObject({ hIn: { x: 0, y: 3 }, hOut: { x: 2, y: 0 } });
    const again = dragGrip(broken, 1, "out", { x: 4, y: 0 }, false);
    expect(again[1]).toMatchObject({ hIn: { x: 0, y: 3 }, hOut: { x: 4, y: 0 } });
  });

  it("a grip pulled out of a corner (one handle only) moves alone", () => {
    const g: Vertex[] = [{ x: 0, y: 0, hOut: { x: 3, y: 0 } }, { x: 10, y: 0 }];
    expect(dragGrip(g, 0, "out", { x: 0, y: 2 }, false)[0]).toEqual({ x: 0, y: 0, hOut: { x: 0, y: 2 } });
  });

  it("Shift constrains a handle to 45°, its length kept", () => {
    const c = constrain45({ x: 10, y: 1 });
    expect(c.y).toBeCloseTo(0);
    expect(c.x).toBeCloseTo(Math.hypot(10, 1));
    const d = constrain45({ x: 3, y: 2.6 });
    expect(d.x).toBeCloseTo(d.y);
  });
});

describe("vertexRule agrees with the stored schema (course-layer.md §8.1)", () => {
  const props: Record<string, unknown> = {
    text: { text: "x", fontSizeMm: 4 }, image: { graphicId: 1 }, filter_region: { mode: "hide", symbols: [] },
  };
  const parse = (kind: string, geometry: Vertex[]) => course.courseObjectBodySchema.safeParse({ kind, geometry, props: props[kind] ?? {} }).success;
  const pts = (n: number, curved = false): Vertex[] =>
    Array.from({ length: n }, (_, i) => ({ x: i * 3, y: (i * i) % 5, ...(curved && i === 0 ? { hOut: { x: 1, y: 1 } } : {}) }));

  it.each(course.COURSE_OBJECT_KINDS.filter((k) => k !== "inset_frame"))("%s", (kind) => {
    const r = vertexRule(kind);
    expect(parse(kind, pts(r.min))).toBe(true);
    if (r.min > 1) expect(parse(kind, pts(r.min - 1))).toBe(false);
    if (Number.isFinite(r.max)) expect(parse(kind, pts(r.max + 1))).toBe(false);
    else expect(parse(kind, pts(r.min + 3))).toBe(true);
    // Fixed-count kinds (a text's anchor, an image's corners) are never curve-edited.
    if (Number.isFinite(r.max)) expect(r.curves).toBe(false);
    else expect(parse(kind, pts(r.min, true))).toBe(r.curves);
  });
});
