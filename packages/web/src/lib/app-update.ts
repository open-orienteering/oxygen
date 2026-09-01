/**
 * Staleness detection for the running app.
 *
 * Two things go stale independently. The API process is caught by a new
 * `startedAt` from `/api/version`, and the web bundle by a service worker
 * waiting to take over. Only the first is fixed by reloading: while a
 * worker is waiting, the active one keeps serving the cached bundle, so a
 * soft reload leaves the operator on the old code. That is how a web-only
 * deploy used to strand a tab that had been open since before it.
 */

export type UpdateAction = "activate-service-worker" | "reload";

/**
 * The identity the version poller compares between checks.
 *
 * Deployments that bake a build id into the image (Cloud Run) report it in
 * `/api/version`; the process there restarts all the time without a code
 * change (scale-to-zero, instance swaps), so `startedAt` alone would show
 * a false "update available" prompt on every cold start. Dev and compose
 * servers have no build id and keep the restart-based behavior, where a
 * process restart really does imply new code.
 */
export function versionIdentity(payload: {
  startedAt: string;
  buildId?: string | null;
}): string {
  return payload.buildId || payload.startedAt;
}

export function resolveUpdateAction(sources: {
  apiRestarted: boolean;
  bundleWaiting: boolean;
}): { updateAvailable: boolean; action: UpdateAction | null } {
  if (sources.bundleWaiting) {
    return { updateAvailable: true, action: "activate-service-worker" };
  }
  if (sources.apiRestarted) {
    return { updateAvailable: true, action: "reload" };
  }
  return { updateAvailable: false, action: null };
}

/**
 * Wrap the service-worker activation with a hard-reload fallback.
 *
 * `updateServiceWorker(true)` reloads via the `controlling` event — which
 * never fires when the tab isn't controlled by a service worker (first
 * visit, hard reload, DevTools bypass) or when the waiting worker has
 * already been consumed by another tab. In those cases the button appeared
 * to do nothing. If the SW-driven reload hasn't torn the page down within
 * `fallbackMs`, force a plain reload; the page dies on reload, so a timer
 * that became redundant never fires.
 */
export function createUpdateActivator(opts: {
  activate: () => void;
  reload: () => void;
  fallbackMs?: number;
}): () => void {
  let fallbackScheduled = false;
  return () => {
    opts.activate();
    if (fallbackScheduled) return;
    fallbackScheduled = true;
    setTimeout(opts.reload, opts.fallbackMs ?? 2500);
  };
}

/**
 * Render the injected build timestamp as a compact local `YYYY-MM-DD HH:MM`.
 *
 * Non-date values (a placeholder in a dev build, say) are passed through so
 * the display never turns into "Invalid Date".
 */
export function formatBuildVersion(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    ` ${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
}
