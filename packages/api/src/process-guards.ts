/**
 * Process-level guards (SYNC-39): a logger for unhandled promise
 * rejections and a shutdown handler with a hard deadline.
 */

/** Upper bound for a graceful shutdown before the process is forced out. */
export const SHUTDOWN_DEADLINE_MS = 8_000;

let rejectionLoggerInstalled = false;

/**
 * Logs unhandled rejections (reason and stack) and keeps the process
 * running. Node's default is to crash; one stray rejected promise in a
 * background job should not take the venue server down mid-event.
 * `uncaughtException` keeps its default (crash): state is unknown then.
 * Registers once, further calls are no-ops.
 */
export function installUnhandledRejectionLogger(
  log: (...args: unknown[]) => void = console.error,
): void {
  if (rejectionLoggerInstalled) return;
  rejectionLoggerInstalled = true;
  process.on("unhandledRejection", (reason) => {
    const stack = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason);
    log("[process] unhandled rejection:", reason, stack);
  });
}

/** Test hook: lets a test register the logger again. */
export function _resetUnhandledRejectionLogger(): void {
  rejectionLoggerInstalled = false;
}

export interface ShutdownOptions {
  steps: Array<{ name: string; run: () => unknown | Promise<unknown> }>;
  deadlineMs?: number;
  exit?: (code: number) => void;
  log?: (...args: unknown[]) => void;
}

/**
 * Builds the SIGINT/SIGTERM handler. The deadline timer is armed first,
 * so a step that never settles (a hung DB, a stuck close) cannot keep
 * the process alive past the orchestrator's kill window. Steps run in
 * order and each failure is logged without skipping the later ones.
 * A second signal is ignored.
 */
export function createShutdown(opts: ShutdownOptions): () => Promise<void> {
  const {
    steps,
    deadlineMs = SHUTDOWN_DEADLINE_MS,
    exit = (code: number) => process.exit(code),
    log = console.error,
  } = opts;
  let started = false;
  return async () => {
    if (started) {
      log("[process] shutdown already in progress");
      return;
    }
    started = true;
    setTimeout(() => {
      log(`[process] shutdown exceeded ${deadlineMs} ms, forcing exit`);
      exit(1);
    }, deadlineMs).unref();
    for (const step of steps) {
      try {
        await step.run();
      } catch (err) {
        log(`[process] shutdown step "${step.name}" failed:`, err);
      }
    }
    exit(0);
  };
}
