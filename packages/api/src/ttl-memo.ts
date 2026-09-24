/**
 * Tiny time-bounded memo for values that are expensive to compute and
 * harmless to serve a little stale — the size of the database for a load
 * indicator, for instance. Concurrent callers during a refresh share the
 * in-flight promise, and a failed refresh is not cached.
 */
export function ttlMemo<T>(
  ttlMs: number,
  compute: () => Promise<T>,
  now: () => number = Date.now,
): { get(): Promise<T>; clear(): void } {
  let value: { at: number; result: T } | null = null;
  let inFlight: Promise<T> | null = null;

  return {
    async get() {
      const t = now();
      if (value && t - value.at < ttlMs) return value.result;
      if (inFlight) return inFlight;
      inFlight = compute()
        .then((result) => {
          value = { at: now(), result };
          return result;
        })
        .finally(() => {
          inFlight = null;
        });
      return inFlight;
    },
    clear() {
      value = null;
    },
  };
}
