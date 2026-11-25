/**
 * When the event queue drains by itself.
 *
 * A drain starts when work arrives (the device-wide pending count grows),
 * when the device comes back online, or when the open competition changes,
 * never while one is already running: work that arrives meanwhile is
 * picked up by one more run right after. Entries another competition left
 * blocked (auth, event, server) keep the total above zero without growing
 * it, so they do not retrigger on every poll, and a new entry still does.
 */
export interface AutoDrainState {
  online: boolean;
  /** Pending entries on this device, every competition. */
  total: number;
  /** Anything else that should start a drain when it changes. */
  scope: string | undefined;
}

export function createAutoDrain(run: () => Promise<void>) {
  let inFlight = false;
  let again = false;
  let stopped = false;
  let lastTotal = 0;
  let lastKey: string | null = null;

  function start(): void {
    if (stopped) return;
    if (inFlight) {
      again = true;
      return;
    }
    inFlight = true;
    void run()
      .catch(() => {})
      .finally(() => {
        inFlight = false;
        if (again) {
          again = false;
          start();
        }
      });
  }

  return {
    update({ online, total, scope }: AutoDrainState): void {
      const key = `${online}|${scope ?? ""}`;
      const fire = total > lastTotal || key !== lastKey;
      lastTotal = total;
      lastKey = key;
      if (online && total > 0 && fire) start();
    },
    stop(): void {
      stopped = true;
    },
    /** Undo `stop` (React StrictMode runs an effect's cleanup and body again). */
    resume(): void {
      stopped = false;
    },
  };
}
