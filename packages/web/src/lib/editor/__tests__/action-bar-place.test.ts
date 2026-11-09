import { describe, expect, it } from "vitest";
import { actionBarMaxWidth, actionBarPlace } from "../action-bar-place";

const container = { w: 1000, h: 600 };
const place = (x: number, y: number, w: number, h: number, c = container) =>
  actionBarPlace({ anchor: { x, y }, anchorR: 20, size: { w, h }, container: c });

describe("actionBarPlace (docs/course-editor.md §2)", () => {
  it("centres the bar under the selection when it fits", () => {
    expect(place(500, 200, 200, 60)).toEqual({ left: 400, top: 230, above: false });
  });

  it("shifts a bar right of a selection near the left edge so its start stays inside the viewer", () => {
    // Regression (docs/bugfix-action-bar-off-viewer.md): thirteen courses in "Also in" made the bar as wide
    // as the viewer allows; centred on a control at x = 120 it began at −372, Add to … cut off.
    const w = actionBarMaxWidth(container.w);
    const { left } = place(120, 200, w, 60);
    expect(left).toBe(8);
    expect(left + w).toBeLessThanOrEqual(container.w - 8);
  });

  it("shifts a bar left of a selection near the right edge", () => {
    expect(place(980, 200, 300, 60).left).toBe(1000 - 8 - 300);
  });

  it("keeps the start in view when the viewer is narrower than the bar", () => {
    expect(place(50, 200, 400, 60, { w: 300, h: 600 }).left).toBe(8);
  });

  it("goes above a selection near the bottom when it does not fit below", () => {
    // Regression: below a control at y = 550 the bar hung past the viewer's bottom and reaching it scrolled the viewer.
    const p = place(500, 550, 300, 60);
    expect(p.above).toBe(true);
    expect(p.top).toBe(550 - 20 - 10 - 60);
    expect(p.top + 60).toBeLessThanOrEqual(550 - 20);
  });

  it("stays below when it just fits", () => {
    // Below at 502 + 20 + 10 = 532, its bottom at 592 = 600 − 8.
    expect(place(500, 502, 300, 60)).toEqual({ left: 350, top: 532, above: false });
  });

  it("when it fits neither below nor above, stays below and is shifted up into the viewer", () => {
    const p = place(500, 50, 300, 580, { w: 1000, h: 600 });
    expect(p.above).toBe(false);
    expect(p.top).toBe(600 - 8 - 580);
  });

  it("before the first measure (size 0) sits under the selection, clamped to the margins", () => {
    expect(place(500, 200, 0, 0)).toEqual({ left: 500, top: 230, above: false });
    expect(place(-30, 200, 0, 0).left).toBe(8);
    expect(place(1030, 200, 0, 0).left).toBe(992);
  });
});

describe("actionBarMaxWidth", () => {
  it("is the viewer less 8 px each side, at least 160 px", () => {
    expect(actionBarMaxWidth(1000)).toBe(984);
    expect(actionBarMaxWidth(100)).toBe(160);
  });
});
