/**
 * Pure helpers for the MapViewer "my location" control.
 *
 * Modes mirror Google Maps:
 * - off: GPS watch stopped, no marker
 * - following: watch active, viewport recenters on each fix
 * - located: watch active, marker visible, but user panned/zoomed away
 */

export type LocateMode = "off" | "following" | "located";

export type LocateEvent = "toggle" | "userGesture" | "error";

export function nextLocateMode(current: LocateMode, event: LocateEvent): LocateMode {
  if (event === "error") return "off";
  if (event === "userGesture") {
    return current === "following" ? "located" : current;
  }
  // toggle
  if (current === "off") return "following";
  if (current === "following") return "off";
  return "following"; // located → re-enable follow
}

/** Pixel radius of the accuracy circle given meters and meters-per-pixel. */
export function accuracyRadiusPx(accuracyMeters: number, metersPerPx: number): number {
  if (!Number.isFinite(accuracyMeters) || accuracyMeters <= 0) return 0;
  if (!Number.isFinite(metersPerPx) || metersPerPx <= 0) return 0;
  return accuracyMeters / metersPerPx;
}
