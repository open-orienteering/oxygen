/**
 * Unit tests for the lease's timer and callback behaviour. Storage is
 * faked here; the database properties it relies on are covered by
 * `integration/leader-lease.test.ts`.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { LeaderLease, type LeaseStore } from "../leader.js";

interface FakeStore extends LeaseStore {
  granted: boolean;
  failWith: Error | null;
  acquireCalls: Array<{ holderId: string; ttlMs: number }>;
  released: string[];
}

function fakeStore(): FakeStore {
  return {
    granted: true,
    failWith: null,
    acquireCalls: [],
    released: [],
    async acquire(_name, holderId, ttlMs) {
      if (this.failWith) throw this.failWith;
      this.acquireCalls.push({ holderId, ttlMs });
      return this.granted;
    },
    async release(_name, holderId) {
      this.released.push(holderId);
    },
  };
}

let store: FakeStore;
let acquired: number;
let lost: number;

function makeLease(overrides: Record<string, unknown> = {}): LeaderLease {
  return new LeaderLease({
    name: "test-jobs",
    holderId: "instance-1",
    ttlMs: 30_000,
    store,
    onAcquire: () => {
      acquired++;
    },
    onLose: () => {
      lost++;
    },
    ...overrides,
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  store = fakeStore();
  acquired = 0;
  lost = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("LeaderLease", () => {
  it("becomes leader on start and announces it once", async () => {
    const lease = makeLease();
    await lease.start();

    expect(lease.isLeader()).toBe(true);
    expect(acquired).toBe(1);
    expect(lost).toBe(0);

    await lease.stop();
  });

  it("renews on a fraction of the TTL so a lapse needs several failures", async () => {
    const lease = makeLease({ ttlMs: 30_000 });
    await lease.start();

    await vi.advanceTimersByTimeAsync(30_000);

    // Renewing once per TTL would mean a single slow query loses the
    // lease; renewing at TTL/3 leaves room for two misses.
    expect(store.acquireCalls.length).toBeGreaterThanOrEqual(3);
    expect(acquired).toBe(1);

    await lease.stop();
  });

  it("stays quiet while it keeps the lease", async () => {
    const lease = makeLease();
    await lease.start();
    await vi.advanceTimersByTimeAsync(120_000);

    expect(lease.isLeader()).toBe(true);
    expect(acquired).toBe(1);
    expect(lost).toBe(0);

    await lease.stop();
  });

  it("stands down when the lease is taken and picks it up again later", async () => {
    const lease = makeLease();
    await lease.start();
    expect(acquired).toBe(1);

    store.granted = false;
    await vi.advanceTimersByTimeAsync(10_000);

    expect(lease.isLeader()).toBe(false);
    expect(lost).toBe(1);

    // Still asking — a lease lost to a restarting peer must come back.
    store.granted = true;
    await vi.advanceTimersByTimeAsync(10_000);

    expect(lease.isLeader()).toBe(true);
    expect(acquired).toBe(2);
    expect(lost).toBe(1);

    await lease.stop();
  });

  it("stands down when the database cannot be reached", async () => {
    const lease = makeLease();
    await lease.start();

    // An unreachable database means we can no longer prove we hold the
    // lease, and another instance will take it over once ours lapses.
    // Assuming we still lead would duplicate every background job.
    store.failWith = new Error("connection terminated");
    await vi.advanceTimersByTimeAsync(10_000);

    expect(lease.isLeader()).toBe(false);
    expect(lost).toBe(1);

    await lease.stop();
  });

  it("does not become leader when the lease is already held", async () => {
    store.granted = false;
    const lease = makeLease();
    await lease.start();

    expect(lease.isLeader()).toBe(false);
    expect(acquired).toBe(0);
    expect(lost).toBe(0);

    await lease.stop();
    expect(store.released).toHaveLength(0);
  });

  it("releases the lease on stop so a redeploy hands over immediately", async () => {
    const lease = makeLease();
    await lease.start();
    await lease.stop();

    expect(store.released).toEqual(["instance-1"]);
    expect(lease.isLeader()).toBe(false);
    expect(lost).toBe(1);

    // Timers are gone: no further renewals after stopping.
    const callsAfterStop = store.acquireCalls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(store.acquireCalls).toHaveLength(callsAfterStop);
  });

  it("asks for the configured TTL and mints a holder id when none is given", async () => {
    const lease = new LeaderLease({ name: "test-jobs", ttlMs: 12_000, store });
    await lease.start();

    expect(store.acquireCalls[0].ttlMs).toBe(12_000);
    expect(lease.holderId).toMatch(/\S/);

    await lease.stop();
  });

  it("survives a callback that throws", async () => {
    const lease = makeLease({
      onAcquire: () => {
        acquired++;
        throw new Error("reconcile blew up");
      },
    });

    await expect(lease.start()).resolves.toBeUndefined();
    expect(lease.isLeader()).toBe(true);
    expect(acquired).toBe(1);

    await lease.stop();
  });
});
