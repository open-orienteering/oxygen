import { useCallback, useEffect, useRef, useState } from "react";

export type GeolocationFix = {
  lat: number;
  lng: number;
  accuracy: number;
};

export type GeolocationWatchError =
  | "unsupported"
  | "insecure"
  | "denied"
  | "unavailable"
  | "timeout"
  | "unknown";

/**
 * Starts / stops `navigator.geolocation.watchPosition` with cleanup on
 * unmount. Position updates are forwarded as React state; callers decide
 * how to center the map.
 */
export function useGeolocationWatch() {
  const [watching, setWatching] = useState(false);
  const [position, setPosition] = useState<GeolocationFix | null>(null);
  const [error, setError] = useState<GeolocationWatchError | null>(null);
  const watchIdRef = useRef<number | null>(null);

  const stop = useCallback(() => {
    if (watchIdRef.current != null && typeof navigator !== "undefined" && navigator.geolocation) {
      navigator.geolocation.clearWatch(watchIdRef.current);
    }
    watchIdRef.current = null;
    setWatching(false);
  }, []);

  const start = useCallback(() => {
    setError(null);
    if (typeof window === "undefined" || typeof navigator === "undefined" || !navigator.geolocation) {
      setError("unsupported");
      setWatching(false);
      return;
    }
    if (!window.isSecureContext) {
      setError("insecure");
      setWatching(false);
      return;
    }
    if (watchIdRef.current != null) {
      navigator.geolocation.clearWatch(watchIdRef.current);
      watchIdRef.current = null;
    }
    setWatching(true);
    watchIdRef.current = navigator.geolocation.watchPosition(
      (pos) => {
        setPosition({
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          accuracy: pos.coords.accuracy,
        });
        setError(null);
      },
      (err) => {
        const code =
          err.code === err.PERMISSION_DENIED
            ? "denied"
            : err.code === err.POSITION_UNAVAILABLE
              ? "unavailable"
              : err.code === err.TIMEOUT
                ? "timeout"
                : "unknown";
        setError(code);
        setWatching(false);
        if (watchIdRef.current != null) {
          navigator.geolocation.clearWatch(watchIdRef.current);
          watchIdRef.current = null;
        }
      },
      {
        enableHighAccuracy: true,
        maximumAge: 5_000,
        timeout: 15_000,
      },
    );
  }, []);

  useEffect(() => () => stop(), [stop]);

  return { watching, position, error, start, stop };
}
