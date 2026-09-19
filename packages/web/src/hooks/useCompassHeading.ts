import { useCallback, useEffect, useRef, useState } from "react";
import { headingFromOrientation } from "../lib/compass-heading";

/**
 * - `not-needed`: the platform hands out orientation events without a
 *   prompt (Android / desktop). We listen immediately.
 * - `prompt`: iOS 13+ — `DeviceOrientationEvent.requestPermission()` exists
 *   and must be called from a user gesture before any event fires.
 * - `granted` / `denied`: outcome of that call.
 */
export type CompassPermission = "not-needed" | "prompt" | "granted" | "denied";

// lib.dom does not know about the iOS-only additions.
type WebkitDeviceOrientationEvent = DeviceOrientationEvent & {
  webkitCompassHeading?: number;
};
type DeviceOrientationEventCtor = typeof DeviceOrientationEvent & {
  requestPermission?: () => Promise<"granted" | "denied">;
};

function orientationCtor(): DeviceOrientationEventCtor | null {
  if (typeof window === "undefined" || !("DeviceOrientationEvent" in window)) return null;
  return window.DeviceOrientationEvent as DeviceOrientationEventCtor;
}

function initialPermission(): CompassPermission {
  const ctor = orientationCtor();
  if (!ctor) return "denied";
  return typeof ctor.requestPermission === "function" ? "prompt" : "not-needed";
}

/**
 * Live compass heading of the device (degrees clockwise from north that the
 * top of the screen points to), or `null` until a trustworthy reading
 * arrives. Desktop browsers have the API but never emit events, so `heading`
 * simply stays `null` there and callers keep north up.
 */
export function useCompassHeading() {
  const [heading, setHeading] = useState<number | null>(null);
  const [permission, setPermission] = useState<CompassPermission>(initialPermission);
  const lastRounded = useRef<number | null>(null);

  useEffect(() => {
    if (permission !== "not-needed" && permission !== "granted") return;
    if (typeof window === "undefined") return;

    // Chromium exposes the absolute variant; WebKit only has the relative
    // event but decorates it with webkitCompassHeading.
    const eventName =
      "ondeviceorientationabsolute" in window ? "deviceorientationabsolute" : "deviceorientation";

    const onOrientation = (ev: Event) => {
      const e = ev as WebkitDeviceOrientationEvent;
      const screenAngle = window.screen?.orientation?.angle ?? 0;
      const h = headingFromOrientation(
        { alpha: e.alpha, absolute: e.absolute, webkitCompassHeading: e.webkitCompassHeading },
        screenAngle,
      );
      if (h == null) return;
      // Sensors tick at ~60 Hz; only re-render on whole-degree changes.
      const rounded = Math.round(h) % 360;
      if (rounded === lastRounded.current) return;
      lastRounded.current = rounded;
      setHeading(rounded);
    };

    window.addEventListener(eventName, onOrientation);
    return () => window.removeEventListener(eventName, onOrientation);
  }, [permission]);

  const requestPermission = useCallback(async () => {
    const ctor = orientationCtor();
    if (!ctor || typeof ctor.requestPermission !== "function") return;
    try {
      const result = await ctor.requestPermission();
      setPermission(result === "granted" ? "granted" : "denied");
    } catch (err) {
      // Thrown when not called from a user gesture, or on older WebKit.
      console.warn("DeviceOrientationEvent.requestPermission failed", err);
      setPermission("denied");
    }
  }, []);

  return { heading, permission, requestPermission };
}
