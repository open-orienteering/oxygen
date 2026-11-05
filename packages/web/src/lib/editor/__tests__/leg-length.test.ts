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
});
