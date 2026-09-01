import { useEffect, useRef, useState } from "react";
import { usePageVisible } from "./usePageVisible";
import { usePerformanceSensitive } from "../lib/performance-mode";
import { versionIdentity } from "../lib/app-update";

const API_BASE = import.meta.env.VITE_API_URL ?? "";
const CHECK_INTERVAL_MS = 30_000; // Check every 30 seconds

/**
 * Periodically checks the API server version.
 * If the server's version identity changes (new build id, or new startedAt
 * for servers without one — see versionIdentity), shows an "update
 * available" state. Build version is baked in at compile time so the user
 * sees stale UI if the dev server recompiled but the browser tab wasn't
 * refreshed.
 */
export function useVersionCheck() {
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const knownIdentity = useRef<string | null>(null);
  const visible = usePageVisible();
  const performanceSensitive = usePerformanceSensitive();
  const pollingActive = visible && !performanceSensitive;

  useEffect(() => {
    let active = true;

    async function check() {
      try {
        const resp = await fetch(`${API_BASE}/api/version`, { cache: "no-store" });
        if (!resp.ok) return;
        const data = await resp.json() as { startedAt: string; buildId?: string | null };
        if (!active) return;

        const identity = versionIdentity(data);
        if (knownIdentity.current === null) {
          // First check — record the server's version identity
          knownIdentity.current = identity;
        } else if (identity !== knownIdentity.current) {
          // New build (or restart of a build-id-less server) → new code
          setUpdateAvailable(true);
        }
      } catch {
        // Network error — ignore silently
      }
    }

    // Check immediately whenever polling resumes (visible / not in perf
    // mode), then on an interval while it stays active. A hidden tab or a
    // performance-sensitive page sitting on a replay doesn't need to keep
    // pinging for restarts — checking on resume catches up just as fast.
    check();
    if (!pollingActive) {
      return () => { active = false; };
    }
    const timer = setInterval(check, CHECK_INTERVAL_MS);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [pollingActive]);

  const reload = () => window.location.reload();

  return { updateAvailable, reload };
}
