import { describe, expect, it } from "vitest";
import { HANDLE_LIFT_PX, IDLE, LONG_PRESS_MS, LOUPE_DIAMETER_PX, LOUPE_GAP_PX, LOUPE_SCALE, TOUCH_SLOP_PX, PLACEMENT_LOUPE_KEY, liftedPoint, loupePlacement, placementLoupe, siteTouch, type SiteTouch, type SiteTouchEvent } from "../touch";

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

describe("the loupe's place (docs/course-editor.md §10 \"Loupe\")", () => {
  const box = { width: 400, height: 800 };
  const r = LOUPE_DIAMETER_PX / 2;

  it("120 px at ×2.5, 16 px above the handle", () => {
    expect([LOUPE_DIAMETER_PX, LOUPE_SCALE, LOUPE_GAP_PX]).toEqual([120, 2.5, 16]);
    const finger = { x: 200, y: 500 };
    expect(loupePlacement(finger, box)).toEqual({ x: 200, y: 500 - HANDLE_LIFT_PX - LOUPE_GAP_PX - r });
  });

  it("flips below the finger when it would leave the box at the top", () => {
    const y = HANDLE_LIFT_PX + LOUPE_GAP_PX + 2 * r;
    expect(loupePlacement({ x: 200, y }, box).y).toBe(y - HANDLE_LIFT_PX - LOUPE_GAP_PX - r);
    expect(loupePlacement({ x: 200, y: y - 1 }, box)).toEqual({ x: 200, y: y - 1 + LOUPE_GAP_PX + r });
  });

  it("stays 4 px inside the box sideways", () => {
    expect(loupePlacement({ x: 3, y: 500 }, box).x).toBe(r + 4);
    expect(loupePlacement({ x: 399, y: 500 }, box).x).toBe(400 - r - 4);
  });
  // F24: a mouse drag has no lift — the loupe sits 16 px above the cursor, the cursor's point is the dragged one.
  it("with no lift (a mouse drag): 16 px above the cursor, flipped 16 px below it at the top, clamped sideways", () => {
    expect(loupePlacement({ x: 200, y: 500 }, box, 0)).toEqual({ x: 200, y: 500 - LOUPE_GAP_PX - r });
    const y = LOUPE_GAP_PX + 2 * r;
    expect(loupePlacement({ x: 200, y }, box, 0).y).toBe(y - LOUPE_GAP_PX - r);
    expect(loupePlacement({ x: 200, y: y - 1 }, box, 0)).toEqual({ x: 200, y: y - 1 + LOUPE_GAP_PX + r });
    expect(loupePlacement({ x: 3, y: 500 }, box, 0).x).toBe(r + 4);
    expect(loupePlacement({ x: 399, y: 500 }, box, 0).x).toBe(400 - r - 4);
    // The touch call is unchanged: the default lift is the handle's.
    expect(loupePlacement({ x: 200, y: 500 }, box)).toEqual(loupePlacement({ x: 200, y: 500 }, box, HANDLE_LIFT_PX));
  });
});

// F27: the placement loupe toggle — a hover with a placing tool armed (feedback 2026-11-11).
describe("the placement loupe (docs/course-editor.md §10 \"Loupe\", F27)", () => {
  const point = { x: 12.5, y: 30 };
  const cursor = { x: 210, y: 400 };
  const crosshair = { x: 200, y: 300 };
  const base = { on: true, point, cursor, crosshair: null, dragging: false };

  it("is stored per browser under oxygen.editor.placementLoupe", () => {
    expect(PLACEMENT_LOUPE_KEY).toBe("oxygen.editor.placementLoupe");
  });

  it("off: no loupe", () => {
    expect(placementLoupe({ ...base, on: false })).toBeNull();
    expect(placementLoupe({ ...base, on: false, cursor: null, crosshair })).toBeNull();
  });

  it("on with a cursor: hangs off the cursor, magnifies the point the click would place", () => {
    expect(placementLoupe(base)).toEqual({ anchor: cursor, at: point, pointer: "mouse" });
  });

  it("on the pin-drop flow: hangs off the centre crosshair, magnifies the point Place would drop", () => {
    expect(placementLoupe({ ...base, cursor: null, crosshair })).toEqual({ anchor: crosshair, at: point, pointer: "touch" });
    // The crosshair is the placement point while it shows: a stray (synthetic) mouse position never moves the loupe off it.
    expect(placementLoupe({ ...base, crosshair })).toEqual({ anchor: crosshair, at: point, pointer: "touch" });
  });

  it("no placing tool (no point), no pointer, or a drag in flight (F24's loupe wins): none", () => {
    expect(placementLoupe({ ...base, point: null })).toBeNull();
    expect(placementLoupe({ ...base, point: undefined })).toBeNull();
    expect(placementLoupe({ ...base, cursor: null })).toBeNull();
    expect(placementLoupe({ ...base, dragging: true })).toBeNull();
  });
});
