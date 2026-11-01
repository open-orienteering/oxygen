import { describe, expect, it } from "vitest";
import type { DisplayRow } from "../../../lib/editor/sequence";
import { afterPlaced, afterUndo, armPlacement, ghostInfo, switchTool } from "../tools/placement";

const row = (kind: DisplayRow["kind"], id: number, x: number, seqIndex = -1): DisplayRow => ({ kind, id, code: String(id), pt: { x, y: 0 }, seqIndex });
// S(1) → 31 → 32 → 33 → F(2)
const rows: DisplayRow[] = [row("start", 1, 0), row("control", 31, 10, 0), row("control", 32, 20, 1), row("control", 33, 30, 2), row("finish", 2, 40)];
const ptOf = (id: number) => rows.find((r) => r.id === id)?.pt ?? null;
const ctx = { rows, course: true, selectedControlId: null, legInsertAt: null };

describe("armPlacement (docs/course-editor.md §6.1)", () => {
  it("defaults to the item before the finish", () => {
    expect(armPlacement("control", ctx)).toEqual({ tool: "control", insertAt: 3, anchorId: 33, placed: [] });
  });

  it("inserts after the selected control, anchored at it", () => {
    expect(armPlacement("control", { ...ctx, selectedControlId: 31 })).toMatchObject({ insertAt: 1, anchorId: 31 });
  });

  it("inserts at a leg's position, anchored at the row the leg starts from", () => {
    expect(armPlacement("control", { ...ctx, legInsertAt: 2 })).toMatchObject({ insertAt: 2, anchorId: 32 });
    expect(armPlacement("control", { ...ctx, legInsertAt: 0 })).toMatchObject({ insertAt: 0, anchorId: 1 });
  });

  it("a selected start puts the insertion point first", () => {
    expect(armPlacement("control", { ...ctx, selectedControlId: 1 })).toMatchObject({ insertAt: 0, anchorId: 1 });
  });

  it("without a course: no insertion point, no anchor", () => {
    expect(armPlacement("control", { ...ctx, course: false })).toEqual({ tool: "control", insertAt: null, anchorId: null, placed: [] });
  });

  it("S anchors at the start", () => {
    expect(armPlacement("start", ctx)).toMatchObject({ insertAt: 0, anchorId: 1 });
  });
});

describe("the chain", () => {
  it("a placed control advances the insertion point and becomes the anchor", () => {
    let s = armPlacement("control", ctx);
    s = afterPlaced(s, 50);
    expect(s).toMatchObject({ insertAt: 4, anchorId: 50 });
    s = afterPlaced(s, 51);
    expect(s).toMatchObject({ insertAt: 5, anchorId: 51 });
    expect(s.placed.map((p) => p.id)).toEqual([50, 51]);
  });

  it("Ctrl+Z steps the anchor back with the last placement", () => {
    let s = afterPlaced(afterPlaced(armPlacement("control", ctx), 50), 51);
    s = afterUndo(s);
    expect(s).toMatchObject({ insertAt: 4, anchorId: 50 });
    s = afterUndo(s);
    expect(s).toMatchObject({ insertAt: 3, anchorId: 33, placed: [] });
    expect(afterUndo(s)).toBe(s);
  });

  it("a placed start becomes the anchor and the tool continues with controls", () => {
    const s = afterPlaced(armPlacement("start", ctx), 7);
    expect(s).toMatchObject({ tool: "control", insertAt: 0, anchorId: 7 });
  });

  it("switching tools keeps the chain; S re-anchors at the start", () => {
    const s = afterPlaced(armPlacement("control", ctx), 50);
    expect(switchTool(s, "finish", ctx)).toMatchObject({ tool: "finish", insertAt: 4, anchorId: 50 });
    expect(switchTool(s, "start", ctx)).toMatchObject({ tool: "start", insertAt: 0, placed: s.placed });
  });

  it("without a course the chain only counts", () => {
    const s = afterPlaced(armPlacement("control", { ...ctx, course: false }), 50);
    expect(s).toMatchObject({ insertAt: null, anchorId: null });
  });
});

describe("ghostInfo", () => {
  it("number, the leg from the anchor and on to the next row, the pending length", () => {
    const g = ghostInfo(armPlacement("control", { ...ctx, selectedControlId: 31 }), rows, { x: 15, y: 4 }, ptOf);
    expect(g.number).toBe(2);
    expect(g.legs).toEqual([[{ x: 10, y: 0 }, { x: 15, y: 4 }], [{ x: 15, y: 4 }, { x: 20, y: 0 }]]);
    expect(g.legMm).toBeCloseTo(Math.hypot(5, 4));
  });

  it("before the finish: the second line runs to the finish", () => {
    const g = ghostInfo(armPlacement("control", ctx), rows, { x: 35, y: 0 }, ptOf);
    expect(g.legs[1]).toEqual([{ x: 35, y: 0 }, { x: 40, y: 0 }]);
  });

  it("no course: no number, no leg", () => {
    expect(ghostInfo(armPlacement("control", { ...ctx, course: false }), rows, { x: 1, y: 1 }, ptOf)).toEqual({ number: null, legs: [], legMm: null });
  });

  it("finish: one line from the anchor, no number", () => {
    const g = ghostInfo(armPlacement("finish", ctx), rows, { x: 50, y: 0 }, ptOf);
    expect(g).toMatchObject({ number: null, legs: [[{ x: 30, y: 0 }, { x: 50, y: 0 }]] });
  });
});
