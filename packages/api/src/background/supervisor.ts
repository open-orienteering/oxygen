/**
 * Supervisor for the background jobs that must run exactly once across
 * the deployment.
 *
 * Two jobs qualify: the LiveResults pusher (two instances would write
 * the same results to the same remote competition) and the online-input
 * puller (two instances would consume the same ROC punches). Both are
 * configured per event in the database, so the supervisor's job is to
 * hold the lease and keep this instance's timers in line with that
 * configuration — start what should run, stop what shouldn't, and drop
 * everything the moment the lease is lost.
 *
 * The journal shipper is included for completeness. It is inert unless
 * `SYNC_PEER_URL` is set, which today means a venue box running a single
 * instance, but shipping the same journal entries from two processes is
 * exactly as unwelcome as double-pushing results.
 *
 * Nothing here is required in a single-instance deployment; it just
 * elects that instance leader and behaves as before.
 */

import { LeaderLease, type LeaderLeaseOptions } from "../leader.js";
import {
  liveResultsPusherManager,
  reconcileEnabledPushers,
} from "../liveresults.js";
import {
  reconcileEnabledPullers,
  stopAllPullers,
} from "../online-input/puller.js";
import { startShipper, stopShipper } from "../sync/shipper.js";

/** How often the leader re-reads the configuration, in ms. */
const DEFAULT_RECONCILE_MS = 5_000;

export interface BackgroundJobs {
  /** Make local timers match the database. Must be idempotent. */
  reconcile(): Promise<void>;
  /** Drop every local timer. */
  stopAll(): void;
}

export const defaultJobs: BackgroundJobs = {
  async reconcile() {
    await reconcileEnabledPushers();
    await reconcileEnabledPullers();
    // Idempotent: returns early when a timer is already armed.
    startShipper();
  },
  stopAll() {
    liveResultsPusherManager.stopAll();
    stopAllPullers();
    stopShipper();
  },
};

export interface BackgroundSupervisorOptions {
  jobs?: BackgroundJobs;
  reconcileIntervalMs?: number;
  /**
   * Lease settings. The callbacks are the supervisor's own, so tests
   * inject a store rather than a whole lease and exercise the real
   * wiring.
   */
  lease?: Omit<LeaderLeaseOptions, "onAcquire" | "onLose">;
}

export class BackgroundSupervisor {
  private readonly jobs: BackgroundJobs;
  private readonly reconcileMs: number;
  private readonly lease: LeaderLease;
  private reconcileTimer: NodeJS.Timeout | null = null;
  private reconciling = false;

  constructor(opts: BackgroundSupervisorOptions = {}) {
    this.jobs = opts.jobs ?? defaultJobs;
    this.reconcileMs = opts.reconcileIntervalMs ?? reconcileIntervalFromEnv();
    this.lease = new LeaderLease({
      ...opts.lease,
      onAcquire: () => this.onBecomeLeader(),
      onLose: () => this.onLoseLeadership(),
    });
  }

  isLeader(): boolean {
    return this.lease.isLeader();
  }

  async start(): Promise<void> {
    await this.lease.start();
  }

  async stop(): Promise<void> {
    // Releases the lease, which fires `onLose` and stops the timers.
    await this.lease.stop();
  }

  /**
   * Apply a configuration change now. Called by the routers after they
   * write config: it takes effect immediately when the request happened
   * to land on the leader, and otherwise within one reconcile interval.
   */
  async requestReconcile(): Promise<void> {
    if (!this.lease.isLeader()) return;
    await this.reconcileOnce();
  }

  private async onBecomeLeader(): Promise<void> {
    await this.reconcileOnce();
    this.reconcileTimer ??= setInterval(
      () => void this.reconcileOnce(),
      this.reconcileMs,
    );
  }

  private onLoseLeadership(): void {
    if (this.reconcileTimer) {
      clearInterval(this.reconcileTimer);
      this.reconcileTimer = null;
    }
    this.jobs.stopAll();
  }

  private async reconcileOnce(): Promise<void> {
    if (this.reconciling) return;
    this.reconciling = true;
    try {
      await this.jobs.reconcile();
    } catch (err) {
      console.error("[background] reconcile failed:", err);
    } finally {
      this.reconciling = false;
    }
  }
}

function reconcileIntervalFromEnv(): number {
  const raw = parseInt(process.env.BACKGROUND_RECONCILE_MS ?? "", 10);
  return Number.isFinite(raw) && raw >= 1000 ? raw : DEFAULT_RECONCILE_MS;
}

let supervisor: BackgroundSupervisor | null = null;

/** Process-wide supervisor, created on first use. */
export function backgroundSupervisor(): BackgroundSupervisor {
  supervisor ??= new BackgroundSupervisor();
  return supervisor;
}

/**
 * Ask the supervisor to pick up a configuration change. Safe to call
 * from any instance: a no-op on the ones that do not hold the lease.
 */
export async function requestBackgroundReconcile(): Promise<void> {
  await backgroundSupervisor().requestReconcile();
}

/** Test seam — drops the process-wide instance. */
export function _resetBackgroundSupervisor(): void {
  supervisor = null;
}
