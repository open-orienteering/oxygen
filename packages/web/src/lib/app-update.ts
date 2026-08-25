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
