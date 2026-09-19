import { useCallback, useEffect, useRef, useState } from "react";
import { headingFromOrientation } from "../lib/compass-heading";
import {
  compassGrantRemembered,
  forgetCompassGrant,
  initialCompassPermission,
  rememberCompassGrant,
  type CompassApiShape,
  type CompassPermission,
} from "../lib/compass-permission";

export type { CompassPermission };

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

function describeApi(): CompassApiShape {
  const ctor = orientationCtor();
  return {
    supported: ctor != null,
    needsPermission: typeof ctor?.requestPermission === "function",
  };
}

/**
 * Live compass heading of the device (degrees clockwise from north that the
 * top of the screen points to), or `null` until a trustworthy reading
 * arrives. Desktop browsers have the API but never emit events, so `heading`
 * simply stays `null` there and callers keep north up.
 *
 * On iOS the sensor needs `requestPermission()`. A previous grant is
 * remembered (see `lib/compass-permission.ts`) and silently re-requested on
 * mount, so the user only has to tap the logo once — not on every app start.
 */
export function useCompassHeading() {
  const [heading, setHeading] = useState<number | null>(null);
  const [permission, setPermission] = useState<CompassPermission>(() =>
    initialCompassPermission(describeApi(), compassGrantRemembered()),
  );
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

  // Silent restore: the user granted in an earlier session, so probe without
  // a gesture. iOS resolves "granted" with no prompt while it still holds the
  // grant, and rejects once it has been revoked — in which case we drop the
  // stale memo and show the tap target again.
  useEffect(() => {
    if (permission !== "restoring") return;
    let cancelled = false;
    const probe = async () => {
      const ctor = orientationCtor();
      if (!ctor || typeof ctor.requestPermission !== "function") {
        // Unreachable: "restoring" is only chosen when the API asked for a
        // permission at mount. Rejecting funnels it into the same fallback.
        throw new Error("DeviceOrientationEvent.requestPermission unavailable");
      }
      return ctor.requestPermission();
    };
    void probe().then(
      (result) => {
        if (cancelled) return;
        if (result === "granted") {
          setPermission("granted");
        } else {
          forgetCompassGrant();
          setPermission("denied");
        }
      },
      () => {
        // NotAllowedError: iOS wants to prompt, which needs a user gesture.
        if (cancelled) return;
        forgetCompassGrant();
        setPermission("prompt");
      },
    );
    return () => {
      cancelled = true;
    };
  }, [permission]);

  const requestPermission = useCallback(async () => {
    const ctor = orientationCtor();
    if (!ctor || typeof ctor.requestPermission !== "function") return;
    try {
      const result = await ctor.requestPermission();
      if (result === "granted") {
        rememberCompassGrant();
        setPermission("granted");
      } else {
        forgetCompassGrant();
        setPermission("denied");
      }
    } catch (err) {
      // Thrown when not called from a user gesture, or on older WebKit.
      console.warn("DeviceOrientationEvent.requestPermission failed", err);
      forgetCompassGrant();
      setPermission("denied");
    }
  }, []);

  return { heading, permission, requestPermission };
}
