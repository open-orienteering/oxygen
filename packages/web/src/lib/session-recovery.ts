/**
 * Helpers for recovering from expired Google IAP sessions in the PWA.
 *
 * When the IAP cookie expires, same-origin `/trpc` fetches redirect to
 * accounts.google.com and fail as CORS `TypeError: Failed to fetch` —
 * a network-class error with no tRPC `data.code`. A full document
 * navigation refreshes the cookie; these helpers classify the failure
 * and guard against reload loops.
 */

const RELOAD_KEY = "oxygen.sessionRecovery.lastReloadAt";
const DEFAULT_MIN_INTERVAL_MS = 15_000;

export function isNetworkClassError(err: unknown): boolean {
  if (err == null) return false;

  // tRPC client errors expose `data.code` for real procedure failures.
  const data = (err as { data?: { code?: string } | null }).data;
  if (data && typeof data.code === "string" && data.code.length > 0) {
    return false;
  }

  const message =
    err instanceof Error
      ? err.message
      : typeof err === "string"
        ? err
        : String((err as { message?: unknown }).message ?? "");

  return /failed to fetch|networkerror|load failed|network request failed|fetch failed/i.test(
    message,
  );
}

export function isNotFoundError(err: unknown): boolean {
  const code = (err as { data?: { code?: string } | null } | null)?.data?.code;
  return code === "NOT_FOUND";
}

/**
 * Returns true once per `minIntervalMs` window so a genuine outage cannot
 * thrash `location.reload()`. Uses sessionStorage so a successful reload
 * still counts against the budget for the tab lifetime.
 */
export function canAttemptSessionReload(
  now = Date.now(),
  minIntervalMs = DEFAULT_MIN_INTERVAL_MS,
  storage: Pick<Storage, "getItem" | "setItem"> | null = typeof sessionStorage === "undefined"
    ? null
    : sessionStorage,
): boolean {
  if (!storage) return true;
  const raw = storage.getItem(RELOAD_KEY);
  // Missing key ⇒ never reloaded in this tab; do not treat as epoch 0
  // (that would block any `now < minIntervalMs`).
  if (raw) {
    const last = Number(raw);
    if (Number.isFinite(last) && now - last < minIntervalMs) {
      return false;
    }
  }
  storage.setItem(RELOAD_KEY, String(now));
  return true;
}

/** Test helper — clears the reload guard. */
export function clearSessionReloadGuard(
  storage: Pick<Storage, "removeItem"> | null = typeof sessionStorage === "undefined"
    ? null
    : sessionStorage,
): void {
  storage?.removeItem(RELOAD_KEY);
}

export function attemptSessionReload(
  reload: () => void = () => {
    window.location.reload();
  },
  now = Date.now(),
  minIntervalMs = DEFAULT_MIN_INTERVAL_MS,
  storage: Pick<Storage, "getItem" | "setItem"> | null = typeof sessionStorage === "undefined"
    ? null
    : sessionStorage,
): boolean {
  if (!canAttemptSessionReload(now, minIntervalMs, storage)) return false;
  reload();
  return true;
}
