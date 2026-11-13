import { describe, expect, it } from "vitest";
import { dragLegShapes, legLengthLabel, legLengthM, legMidpoint } from "../leg-length";

describe("leg length label (docs/course-editor.md §6.1)", () => {
  it("metres on the ground from paper mm at the map scale", () => {
    expect(legLengthM(20, 10000)).toBe(200);
    expect(legLengthM(4, 4000)).toBe(16);
  });

  it("reads '<n> m', rounded to the metre; nothing without a scale", () => {
    expect(legLengthLabel({ x: 0, y: 0 }, { x: 30, y: 40 }, 10000)).toBe("500 m");
    expect(legLengthLabel({ x: 0, y: 0 }, { x: 1.234, y: 0 }, 15000)).toBe("19 m");
    expect(legLengthLabel({ x: 0, y: 0 }, { x: 1, y: 0 }, null)).toBeNull();
  });

  it("sits at the leg's midpoint", () => {
    expect(legMidpoint({ x: 2, y: 4 }, { x: 6, y: 10 })).toEqual({ x: 4, y: 7 });
  });

  it("a dragged control: both legs of every visit, between drawn neighbours", () => {
    const pos = new Map(Object.entries({ S: { x: 0, y: 0 }, 1: { x: 10, y: 0 }, 2: { x: 10, y: 10 }, F: { x: 0, y: 10 } }));
    const texts = (seq: string[], id: string) => dragLegShapes(seq, pos, id, 10000).map((s) => (s.kind === "text" ? [s.text, s.x, s.y] : null));
    expect(texts(["S", "1", "2", "F"], "1")).toEqual([["100 m", 5, 0], ["100 m", 10, 5]]);
    // A start has one leg; an undrawn item is skipped; a repeated control labels each visit.
    expect(texts(["S", "1", "F"], "S")).toEqual([["100 m", 5, 0]]);
    expect(texts(["S", "9", "2", "F"], "2")).toEqual([["141 m", 5, 5], ["100 m", 5, 10]]);
    expect(texts(["S", "1", "2", "1", "F"], "1")).toHaveLength(4);
    expect(dragLegShapes(["S", "1"], pos, "1", null)).toEqual([]);
    expect(dragLegShapes(["S", "1"], pos, "7", 10000)).toEqual([]);
    expect(dragLegShapes(["S", "1"], pos, "1", 10000)[0]).toMatchObject({ testId: "editor-leg-length" });
  });

  it("measures and labels a bent leg along its bends (course-layer.md §10.1, F1)", () => {
    // (0,0) → (0,30) → (40,30): 30 + 40 mm = 700 m at 1:10 000; half way is 5 mm past the bend.
    const via = [{ x: 0, y: 30 }];
    expect(legLengthLabel({ x: 0, y: 0 }, { x: 40, y: 30 }, 10000, via)).toBe("700 m");
    expect(legMidpoint({ x: 0, y: 0 }, { x: 40, y: 30 }, via)).toEqual({ x: 5, y: 30 });
    const pos = new Map(Object.entries({ S: { x: 0, y: 0 }, 1: { x: 40, y: 30 }, F: { x: 40, y: 0 } }));
    const bendsInto = [undefined, via, [{ x: 60, y: 30 }, { x: 60, y: 0 }]];
    const texts = dragLegShapes(["S", "1", "F"], pos, "1", 10000, bendsInto).map((s) => (s.kind === "text" ? [s.text, s.x, s.y] : null));
    // In: 700 m; out: 1 → (60,30) → (60,0) → F = 20 + 30 + 20 mm = 700 m, half way at (60, 15).
    expect(texts).toEqual([["700 m", 5, 30], ["700 m", 60, 15]]);
    expect(dragLegShapes(["S", "1", "F"], pos, "1", 10000)).toHaveLength(2);
  });
});

describe("curved legs (course-layer.md §10.1, F13)", () => {
  const K = 0.5522847498 * 20;
  const A = { x: 30, y: 0 }, B = { x: 0, y: 30 };
  const QUARTER = [{ x: 20, y: 0, hOut: { x: 0, y: K } }, { x: 0, y: 20, hIn: { x: K, y: 0 } }];

  it("labels the length along the curve, at the curve's midpoint", () => {
    expect(legLengthLabel(A, B, 10000, QUARTER)).toBe(`${Math.round((20 + 10 * Math.PI) * 10)} m`);
    const m = legMidpoint(A, B, QUARTER);
    expect(Math.hypot(m.x, m.y)).toBeCloseTo(20, 2);
    expect(m.x).toBeCloseTo(m.y, 2);
  });

  it("a dragged control's leg out reads its bends backwards, handles swapped: the same length and midpoint", () => {
    const pos = new Map(Object.entries({ S: A, 1: B, F: { x: 0, y: 60 } }));
    // Dragging S: its leg out to 1 runs along QUARTER; the label is from the far end as before.
    const [out] = dragLegShapes(["S", "1", "F"], pos, "S", 10000, [undefined, QUARTER, undefined]);
    expect(out).toMatchObject({ kind: "text", text: legLengthLabel(A, B, 10000, QUARTER) });
    if (out.kind !== "text") throw new Error("text");
    const m = legMidpoint(A, B, QUARTER);
    expect(out.x).toBeCloseTo(m.x, 3);
    expect(out.y).toBeCloseTo(m.y, 3);
  });
});

