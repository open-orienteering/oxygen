/**
 * Pure helpers for turning `DeviceOrientationEvent` data into a compass
 * heading and a needle rotation. Kept free of DOM access so the maths can
 * be unit-tested; `useCompassHeading` owns the event wiring.
 *
 * Two platform flavours feed this:
 *
 *   - Android / Chromium: `deviceorientationabsolute` events with
 *     `absolute: true`. `alpha` is the rotation around the z-axis measured
 *     *counter-clockwise* from north, so heading = 360 − alpha.
 *   - iOS / WebKit: `deviceorientation` events carry a non-standard
 *     `webkitCompassHeading` that is already clockwise-from-north. Its
 *     `alpha` is relative to an arbitrary frame and must be ignored.
 *
 * Both are relative to the *device* frame (portrait top edge). When the
 * screen is rotated the heading has to be shifted by
 * `screen.orientation.angle` so "up on the screen" still maps to north.
 */

export type OrientationReading = {
  alpha: number | null;
  absolute?: boolean;
  /** iOS-only, degrees clockwise from magnetic north. */
  webkitCompassHeading?: number;
};

export function normalizeHeading(deg: number): number {
  return ((deg % 360) + 360) % 360;
}

/**
 * Compass heading (degrees clockwise from north that the top of the
 * *screen* points to), or `null` when the event carries nothing trustworthy.
 */
export function headingFromOrientation(
  reading: OrientationReading,
  screenAngle = 0,
): number | null {
  const webkit = reading.webkitCompassHeading;
  if (typeof webkit === "number" && Number.isFinite(webkit)) {
    return normalizeHeading(webkit + screenAngle);
  }
  if (!reading.absolute) return null;
  if (reading.alpha == null || !Number.isFinite(reading.alpha)) return null;
  return normalizeHeading(360 - reading.alpha + screenAngle);
}

/**
 * The needle must point at real north, i.e. rotate by −heading on screen.
 * To keep a CSS `transition: transform` from spinning the long way round
 * when the heading crosses the 0/360 seam, the returned angle is
 * *continuous*: it takes the shortest step from `prev` and is allowed to
 * grow beyond ±360.
 */
export function nextNeedleAngle(prev: number, heading: number): number {
  const target = -heading;
  const delta = normalizeHeading(target - prev + 180) - 180;
  return prev + delta;
}
