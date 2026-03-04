import { useEffect, useRef, useState } from "react";

const API_BASE = import.meta.env.VITE_API_URL ?? "";
const CHECK_INTERVAL_MS = 30_000; // Check every 30 seconds

/**
 * Periodically checks the API server version.
 * If the server has restarted (new startedAt), shows an "update available" state.
 * Build version is baked in at compile time so the user sees stale UI if
 * the dev server recompiled but the browser tab wasn't refreshed.
 */
export function useVersionCheck() {
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const knownStartedAt = useRef<string | null>(null);

  useEffect(() => {
    let active = true;

    async function check() {
      try {
        const resp = await fetch(`${API_BASE}/api/version`, { cache: "no-store" });
        if (!resp.ok) return;
        const data = await resp.json() as { startedAt: string };
        if (!active) return;

        if (knownStartedAt.current === null) {
          // First check — record the server start time
          knownStartedAt.current = data.startedAt;
        } else if (data.startedAt !== knownStartedAt.current) {
          // Server restarted → new code is available
          setUpdateAvailable(true);
        }
      } catch {
        // Network error — ignore silently
      }
    }

    // Check immediately, then on interval
    check();
    const timer = setInterval(check, CHECK_INTERVAL_MS);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, []);

  const reload = () => window.location.reload();

  return { updateAvailable, reload };
}
