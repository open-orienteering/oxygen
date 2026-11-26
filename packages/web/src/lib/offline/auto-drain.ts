import { retryDelayMs } from "../backoff";

/**
 * When the event queue drains by itself.
 *
 * A drain starts when an entry is queued (`enqueued()`, driven by the
 * enqueue signal in `events.ts`, not by a count: an entry queued while the
 * previous one drains leaves the polled count unchanged), when the device
 * comes back online, or when the open competition changes, never while one
 * is already running: work that arrives meanwhile is picked up by one more
 * run right after. Growth of the polled device-wide count still starts a
 * drain (entries queued by another tab raise no signal here). Entries
 * another competition left blocked (auth, event, server) keep the total
 * above zero without growing it and raise no signal, so they do not
 * retrigger on every poll, and a new entry still does.
 *
 * Retry (SYNC-11): a run that ends with outcome "retry" (node unreachable,
 * server error) schedules another run after `retryDelayMs` (2 s doubling to
 * 30 s) while the device is online and work is pending; only an "ok" run
 * resets the delay. "blocked" (auth, unknown event) waits for an operator.
 * `kick()` runs at once (the tab became visible, the active node changed).
 */
export interface AutoDrainState {
  online: boolean;
  /** Pending entries on this device, every competition. */
  total: number;
  /** Anything else that should start a drain when it changes. */
  scope: string | undefined;
}

export type AutoDrainOutcome = "ok" | "retry" | "blocked";

export interface AutoDrainTimers {
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
}

const defaultTimers: AutoDrainTimers = {
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export function createAutoDrain(
  run: () => Promise<AutoDrainOutcome | void>,
  timers: AutoDrainTimers = defaultTimers,
) {
  let inFlight = false;
  let again = false;
  let stopped = false;
  let lastTotal = 0;
  let lastKey: string | null = null;
  let online = false;
  let failures = 0;
  let timer: unknown = null;

  function clearRetry(): void {
    if (timer !== null) timers.clearTimer(timer);
    timer = null;
  }

  function scheduleRetry(): void {
    clearRetry();
    if (stopped || !online || lastTotal <= 0) return;
    const delay = retryDelayMs(failures);
    failures++;
    timer = timers.setTimer(() => {
      timer = null;
      start();
    }, delay);
  }

  function start(): void {
    if (stopped) return;
    if (inFlight) {
      again = true;
      return;
    }
    clearRetry();
    inFlight = true;
    let outcome: AutoDrainOutcome | void = undefined;
    void run()
      .then((o) => { outcome = o; }, () => { outcome = "retry"; })
      .finally(() => {
        inFlight = false;
        if (outcome === "ok") failures = 0;
        if (again) {
          again = false;
          start();
          return;
        }
        if (outcome === "retry") scheduleRetry();
      });
  }

  return {
    /** An entry was queued on this page. */
    enqueued(): void {
      if (online) start();
    },
    /** Run now if there is work (tab visible again, active node changed). */
    kick(): void {
      if (online && lastTotal > 0) start();
    },
    update({ online: isOnline, total, scope }: AutoDrainState): void {
      online = isOnline;
      if (!isOnline || total <= 0) clearRetry();
      const key = `${isOnline}|${scope ?? ""}`;
      const fire = total > lastTotal || key !== lastKey;
      lastTotal = total;
      lastKey = key;
      if (isOnline && total > 0 && fire) start();
    },
    stop(): void {
      stopped = true;
      clearRetry();
    },
    /** Undo `stop` (React StrictMode runs an effect's cleanup and body again). */
    resume(): void {
      stopped = false;
    },
  };
}
