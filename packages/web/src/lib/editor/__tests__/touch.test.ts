import { describe, expect, it } from "vitest";
import { HANDLE_LIFT_PX, IDLE, LONG_PRESS_MS, TOUCH_SLOP_PX, liftedPoint, siteTouch, type SiteTouch, type SiteTouchEvent } from "../touch";

function run(events: SiteTouchEvent[]) {
  let s: SiteTouch = IDLE;
  const effects = [];
  for (const e of events) {
    const out = siteTouch(s, e);
    s = out.state;
    if (out.effect) effects.push(out.effect);
  }
  return { state: s, effects };
}

const down = (selected: boolean, t = 0): SiteTouchEvent => ({ type: "down", id: "31", selected, x: 100, y: 100, t });

describe("one-finger touch on a site (docs/course-editor.md §10)", () => {
  it("a selected control drags at once", () => {
    expect(run([down(true)])).toEqual({ state: { kind: "drag", id: "31" }, effects: [{ kind: "drag", id: "31", select: false }] });
  });

  it("an unselected control: a tap selects it, nothing moves", () => {
    expect(run([down(false), { type: "move", x: 103, y: 102, t: 80 }, { type: "up" }]).effects).toEqual([{ kind: "select", id: "31" }]);
  });

  it("an unselected control: a drag past the slop pans, never selects or moves", () => {
    const r = run([down(false), { type: "move", x: 100, y: 100 + TOUCH_SLOP_PX + 1, t: 50 }, { type: "tick", t: LONG_PRESS_MS + 10 }, { type: "up" }]);
    expect(r.effects).toEqual([]);
  });

  it("an unselected control: a long press selects it and starts a move", () => {
    const r = run([down(false), { type: "move", x: 104, y: 103, t: 200 }, { type: "tick", t: LONG_PRESS_MS }]);
    expect(r.state).toEqual({ kind: "drag", id: "31" });
    expect(r.effects).toEqual([{ kind: "drag", id: "31", select: true }]);
    // A move arriving late still fires the press.
    expect(run([down(false), { type: "move", x: 101, y: 101, t: LONG_PRESS_MS + 5 }]).effects).toEqual([{ kind: "drag", id: "31", select: true }]);
  });

  it("a second finger cancels the press: the map pinches", () => {
    const r = run([down(false), { type: "second-finger" }, { type: "tick", t: LONG_PRESS_MS + 1 }, { type: "up" }]);
    expect(r).toEqual({ state: IDLE, effects: [] });
  });

  it("the dragged control is drawn above the finger", () => {
    expect(liftedPoint(10, 200)).toEqual({ x: 10, y: 200 - HANDLE_LIFT_PX });
  });
});
