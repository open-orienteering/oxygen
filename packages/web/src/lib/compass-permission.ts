/**
 * Remembering the iOS motion-sensor grant across app starts.
 *
 * iOS is the only platform that gates `DeviceOrientationEvent` behind
 * `requestPermission()`, and WebKit exposes no way to *query* the current
 * state: `navigator.permissions.query({ name: "deviceorientation" })` is not
 * implemented, so a fresh page load cannot tell "never asked" from "already
 * granted". Calling `requestPermission()` is the only probe there is.
 *
 * What makes a silent restore possible is the asymmetry in that call:
 *
 *   - already granted → resolves "granted" with no prompt and no gesture
 *   - not granted yet  → rejects (NotAllowedError) unless it was called
 *                        from a user gesture, because it wants to prompt
 *
 * So we record locally that the user once granted, and on the next start we
 * probe without a gesture. If iOS still holds the grant the needle simply
 * comes alive; if it has been revoked the probe rejects and we fall back to
 * the tap target. The localStorage flag is a *hint*, never an authority —
 * the sensor stays shut until iOS itself says "granted".
 */

export type CompassApiShape = {
  /** `DeviceOrientationEvent` exists on `window`. */
  supported: boolean;
  /** `DeviceOrientationEvent.requestPermission` is a function (iOS 13+). */
  needsPermission: boolean;
};

export type CompassPermission =
  | "not-needed"
  | "prompt"
  | "restoring"
  | "granted"
  | "denied";

export const COMPASS_GRANT_KEY = "oxygen.compass.granted";

/** Permission state to start from, before any sensor call has been made. */
export function initialCompassPermission(
  api: CompassApiShape,
  remembered: boolean,
): CompassPermission {
  if (!api.supported) return "denied";
  if (!api.needsPermission) return "not-needed";
  return remembered ? "restoring" : "prompt";
}

export function compassGrantRemembered(): boolean {
  try {
    return localStorage.getItem(COMPASS_GRANT_KEY) === "1";
  } catch {
    return false;
  }
}

export function rememberCompassGrant(): void {
  try {
    localStorage.setItem(COMPASS_GRANT_KEY, "1");
  } catch {
    /* localStorage unavailable — the user taps once per session instead */
  }
}

export function forgetCompassGrant(): void {
  try {
    localStorage.removeItem(COMPASS_GRANT_KEY);
  } catch {
    /* see rememberCompassGrant */
  }
}
