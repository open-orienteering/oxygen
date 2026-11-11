/**
 * The editor's one-finger touch rules on a site (docs/course-editor.md §10
 * "Gestures"; 08 §5.5), for coarse pointers on the shared hit-test path:
 *
 * - a selected control drags at once;
 * - on an unselected one the press is pending: moving past the slop pans the
 *   map, lifting selects it, holding still for `LONG_PRESS_MS` selects it and
 *   starts a move;
 * - a second finger cancels whatever the first one started (the map pinches).
 *
 * A touch-dragged control is drawn `HANDLE_LIFT_PX` above the finger and
 * dropped where it is drawn; the loupe shows it magnified above that (and,
 * F24, above the cursor during a mouse drag).
 */

export const LONG_PRESS_MS = 500;
/** Finger travel that turns a pending press into a pan, CSS px. */
export const TOUCH_SLOP_PX = 10;
/** How far above the finger a touch-dragged control is drawn, CSS px. */
export const HANDLE_LIFT_PX = 48;
/** Hit tolerance on coarse pointers, CSS px (fine pointers: `HIT_TOLERANCE_PX`). */
export const COARSE_HIT_TOLERANCE_PX = 12;
/** The touch-drag loupe (§10 "Loupe"): its diameter in CSS px, its magnification, its gap above the handle. */
export const LOUPE_DIAMETER_PX = 120;
export const LOUPE_SCALE = 2.5;
export const LOUPE_GAP_PX = 16;
/** How far the loupe's edge stays inside the map box sideways, CSS px. */
const LOUPE_INSET_PX = 4;

export type SiteTouch =
  | { kind: "idle" }
  | { kind: "pending"; id: string; x0: number; y0: number; t0: number }
  | { kind: "drag"; id: string }
  | { kind: "pan" };

export type SiteTouchEvent =
  | { type: "down"; id: string; selected: boolean; x: number; y: number; t: number }
  | { type: "move"; x: number; y: number; t: number }
  | { type: "tick"; t: number }
  | { type: "second-finger" }
  | { type: "up" };

/** What the viewer does on the transition: start a drag of `id` (selecting it first if `select`), select only, or nothing. */
export type SiteTouchEffect = { kind: "drag"; id: string; select: boolean } | { kind: "select"; id: string } | null;

export const IDLE: SiteTouch = { kind: "idle" };

export function siteTouch(s: SiteTouch, e: SiteTouchEvent): { state: SiteTouch; effect: SiteTouchEffect } {
  switch (e.type) {
    case "down":
      return e.selected
        ? { state: { kind: "drag", id: e.id }, effect: { kind: "drag", id: e.id, select: false } }
        : { state: { kind: "pending", id: e.id, x0: e.x, y0: e.y, t0: e.t }, effect: null };
    case "move":
      if (s.kind !== "pending") return { state: s, effect: null };
      if (Math.hypot(e.x - s.x0, e.y - s.y0) > TOUCH_SLOP_PX) return { state: { kind: "pan" }, effect: null };
      return e.t - s.t0 >= LONG_PRESS_MS ? fire(s) : { state: s, effect: null };
    case "tick":
      return s.kind === "pending" && e.t - s.t0 >= LONG_PRESS_MS ? fire(s) : { state: s, effect: null };
    case "second-finger":
      return { state: IDLE, effect: null };
    case "up":
      return { state: IDLE, effect: s.kind === "pending" ? { kind: "select", id: s.id } : null };
  }
}

function fire(s: Extract<SiteTouch, { kind: "pending" }>): { state: SiteTouch; effect: SiteTouchEffect } {
  return { state: { kind: "drag", id: s.id }, effect: { kind: "drag", id: s.id, select: true } };
}

/** The client point a touch-dragged control is drawn at: above the finger. */
export const liftedPoint = (x: number, y: number): { x: number; y: number } => ({ x, y: y - HANDLE_LIFT_PX });

/**
 * The loupe's centre in the map box's CSS px for a pointer at `at` (box-relative): `LOUPE_GAP_PX`
 * above the dragged point, which is `liftPx` above the pointer (a finger's handle, `HANDLE_LIFT_PX`;
 * 0 for a mouse drag, F24), so the 1× control stays visible; below the pointer when that would leave
 * the box at the top; kept inside the box sideways.
 */
export function loupePlacement(
  at: { x: number; y: number },
  box: { width: number; height: number },
  liftPx: number = HANDLE_LIFT_PX,
): { x: number; y: number } {
  const r = LOUPE_DIAMETER_PX / 2;
  const above = at.y - liftPx - LOUPE_GAP_PX - r;
  const y = above - r < 0 ? at.y + LOUPE_GAP_PX + r : above;
  const x = Math.min(Math.max(at.x, r + LOUPE_INSET_PX), box.width - r - LOUPE_INSET_PX);
  return { x, y };
}
