/**
 * Pure helpers for classifying a touch gesture as a measure-mode tap
 * vs a pan (or a synthesized mouse click after touch).
 */

/** Ignore mouse-up measure placement within this window after any touch. */
export const SYNTHETIC_MOUSE_SUPPRESS_MS = 800;

/** Max viewport-center drift (CSS px) for a touchend to still count as a tap. */
export const MEASURE_TAP_MAX_PAN_PX = 8;

export function shouldSuppressSyntheticMouse(
  nowMs: number,
  lastTouchEndAtMs: number | null,
  suppressMs = SYNTHETIC_MOUSE_SUPPRESS_MS,
): boolean {
  if (lastTouchEndAtMs == null) return false;
  return nowMs - lastTouchEndAtMs < suppressMs;
}

/**
 * Decide whether a one-finger touchend should place a measure point.
 * Returns false when the viewport moved (real pan) or the finger
 * wandered beyond the movement threshold.
 */
export function isMeasureTap(opts: {
  /** Distance the finger moved between touchstart and touchend (CSS px). */
  fingerMovementPx: number;
  /** Distance the map viewport center moved during the gesture (CSS px). */
  viewportCenterDeltaPx: number;
  maxPanPx?: number;
}): boolean {
  const max = opts.maxPanPx ?? MEASURE_TAP_MAX_PAN_PX;
  return (
    opts.fingerMovementPx <= max && opts.viewportCenterDeltaPx <= max
  );
}

export function dist2d(
  a: { x: number; y: number },
  b: { x: number; y: number },
): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}
