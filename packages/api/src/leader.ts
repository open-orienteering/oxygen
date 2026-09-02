/**
 * Cluster-wide leader lease.
 *
 * Most of the API is stateless and scales horizontally, but a handful of
 * background jobs must not run more than once: the LiveResults pusher
 * would write the same results twice, and the online-input puller would
 * consume the same ROC punches on two instances and insert duplicates.
 * Exactly one instance holds the lease at a time and runs them.
 *
 * Why a lease row rather than `pg_advisory_lock`: a session-level
 * advisory lock belongs to the connection that took it, and Prisma hands
 * out pooled connections per query. We could neither guarantee that the
 * renewal ran on the connection holding the lock nor notice when the
 * pool retired it — leadership would drop silently or leak forever. A
 * row with an expiry is pool-agnostic, and it has the side benefit of
 * being greppable in production: `SELECT * FROM oxygen.instance_lease`
 * answers "who is running the timers right now".
 *
 * Expiry is evaluated with the database's `now()`, never a local clock,
 * so instances with skewed clocks still agree on when a lease lapsed.
 */

import { randomUUID } from "crypto";
import { prisma } from "./db.js";
import type { PrismaClient } from "./generated/prisma/client.js";

export const DEFAULT_LEASE_NAME = "background-jobs";
export const DEFAULT_TTL_MS = 30_000;

/** Storage behind a lease. Faked in unit tests. */
export interface LeaseStore {
  /**
   * Take the lease, or renew it if we already hold it. Resolves true
   * when this holder owns the lease afterwards.
   */
  acquire(name: string, holderId: string, ttlMs: number): Promise<boolean>;
  /** Give up the lease. A no-op unless `holderId` currently holds it. */
  release(name: string, holderId: string): Promise<void>;
}

export interface LeaseHolderInfo {
  holderId: string;
  acquiredAt: Date;
  renewedAt: Date;
  expiresAt: Date;
}

/**
 * The Postgres-backed store. Acquire and renew are the same statement:
 * an upsert whose UPDATE is guarded by "we already hold it, or it has
 * lapsed". A conflicting insert serialises on the primary key, so two
 * instances starting at the same instant cannot both win.
 */
export function dbLeaseStore(getDb: () => PrismaClient): LeaseStore {
  return {
    async acquire(name, holderId, ttlMs) {
      const rows = await getDb().$queryRaw<Array<{ holder_id: string }>>`
        INSERT INTO oxygen.instance_lease AS l
               (name, holder_id, acquired_at, renewed_at, expires_at)
        VALUES (${name}, ${holderId}, now(), now(),
                now() + ${ttlMs}::double precision * interval '1 millisecond')
        ON CONFLICT (name) DO UPDATE
           SET holder_id   = EXCLUDED.holder_id,
               renewed_at  = now(),
               expires_at  = EXCLUDED.expires_at,
               acquired_at = CASE
                               WHEN l.holder_id = EXCLUDED.holder_id
                               THEN l.acquired_at
                               ELSE now()
                             END
         WHERE l.holder_id = EXCLUDED.holder_id
            OR l.expires_at <= now()
        RETURNING holder_id
      `;
      return rows.length > 0;
    },

    async release(name, holderId) {
      await getDb().instanceLease.deleteMany({ where: { name, holderId } });
    },
  };
}

/** Who holds `name`, for diagnostics and tests. */
export async function leaseHolder(
  db: PrismaClient,
  name: string,
): Promise<LeaseHolderInfo | null> {
  const row = await db.instanceLease.findUnique({ where: { name } });
  if (!row) return null;
  return {
    holderId: row.holderId,
    acquiredAt: row.acquiredAt,
    renewedAt: row.renewedAt,
    expiresAt: row.expiresAt,
  };
}

/**
 * Lease name for this deployment. The scope suffix exists because the
 * dev servers and the local Docker stack share one database (see
 * AGENTS.md §3): without it, starting Docker would silently steal the
 * timers from `pnpm dev`. Instances that are meant to elect a leader
 * among themselves — the Cloud Run revision — share a scope.
 */
export function scopedLeaseName(base: string = DEFAULT_LEASE_NAME): string {
  const scope = (process.env.LEADER_LEASE_SCOPE ?? "").trim();
  return scope ? `${base}:${scope}` : base;
}

export interface LeaderLeaseOptions {
  name?: string;
  holderId?: string;
  ttlMs?: number;
  renewIntervalMs?: number;
  store?: LeaseStore;
  /** Called when this instance becomes leader. */
  onAcquire?: () => void | Promise<void>;
  /**
   * Called when it stops being leader — lost, unreachable database, or
   * `stop()`. Callers use this as the single "drop background work" hook.
   */
  onLose?: () => void | Promise<void>;
}

export class LeaderLease {
  readonly name: string;
  readonly holderId: string;
  private readonly ttlMs: number;
  private readonly renewMs: number;
  private readonly store: LeaseStore;
  private readonly onAcquire?: () => void | Promise<void>;
  private readonly onLose?: () => void | Promise<void>;

  private timer: NodeJS.Timeout | null = null;
  private leader = false;
  private ticking = false;

  constructor(opts: LeaderLeaseOptions = {}) {
    this.name = opts.name ?? scopedLeaseName();
    this.holderId = opts.holderId ?? randomUUID();
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    // A third of the TTL: two consecutive failed renewals still leave
    // time to recover before another instance may take over.
    this.renewMs = opts.renewIntervalMs ?? Math.max(1000, Math.floor(this.ttlMs / 3));
    this.store = opts.store ?? dbLeaseStore(prisma);
    this.onAcquire = opts.onAcquire;
    this.onLose = opts.onLose;
  }

  isLeader(): boolean {
    return this.leader;
  }

  /** Try to take the lease now, then keep renewing it. */
  async start(): Promise<void> {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.renewMs);
    await this.tick();
  }

  /**
   * Stop renewing and hand the lease back, so a redeploy's replacement
   * instance picks up the background jobs immediately instead of waiting
   * out the TTL.
   */
  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (!this.leader) return;
    this.leader = false;
    await this.notify(this.onLose);
    try {
      await this.store.release(this.name, this.holderId);
    } catch (err) {
      console.error(`[leader] releasing ${this.name} failed:`, err);
    }
  }

  private async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      let granted: boolean;
      try {
        granted = await this.store.acquire(this.name, this.holderId, this.ttlMs);
      } catch (err) {
        // Can't prove we still hold it, so assume we don't: another
        // instance will take over once ours lapses, and two instances
        // running the same job is worse than none running it briefly.
        console.error(`[leader] renewing ${this.name} failed:`, err);
        granted = false;
      }

      if (granted && !this.leader) {
        this.leader = true;
        console.log(`[leader] ${this.name} acquired by ${this.holderId}`);
        await this.notify(this.onAcquire);
      } else if (!granted && this.leader) {
        this.leader = false;
        console.warn(`[leader] ${this.name} lost by ${this.holderId}`);
        await this.notify(this.onLose);
      }
    } finally {
      this.ticking = false;
    }
  }

  private async notify(cb?: () => void | Promise<void>): Promise<void> {
    if (!cb) return;
    try {
      await cb();
    } catch (err) {
      // A failing hook must not take the lease down with it — the next
      // reconcile pass gets another chance.
      console.error(`[leader] ${this.name} callback failed:`, err);
    }
  }
}
