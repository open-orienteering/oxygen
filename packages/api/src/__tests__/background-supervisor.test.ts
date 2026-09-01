/**
 * The supervisor's contract: background jobs run only while this
 * instance holds the lease, configuration changes are picked up on a
 * timer so a change made on another instance still takes effect, and
 * losing the lease drops every local timer promptly.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  BackgroundSupervisor,
  type BackgroundJobs,
} from "../background/supervisor.js";
import type { LeaseStore } from "../leader.js";

function fakeJobs() {
  return {
    reconciles: 0,
    stops: 0,
    failNext: false,
    async reconcile() {
      this.reconciles++;
      if (this.failNext) {
        this.failNext = false;
        throw new Error("database went away");
      }
    },
    stopAll() {
      this.stops++;
    },
  } satisfies BackgroundJobs & Record<string, unknown>;
}

function fakeStore(granted = { value: true }): LeaseStore {
  return {
    async acquire() {
      return granted.value;
    },
    async release() {},
  };
}

let jobs: ReturnType<typeof fakeJobs>;
let granted: { value: boolean };

function build(reconcileIntervalMs = 5_000): BackgroundSupervisor {
  return new BackgroundSupervisor({
    jobs,
    reconcileIntervalMs,
    lease: {
      name: "test-jobs",
      holderId: "instance-1",
      ttlMs: 30_000,
      store: fakeStore(granted),
    },
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  jobs = fakeJobs();
  granted = { value: true };
});

afterEach(() => {
  vi.useRealTimers();
});

describe("BackgroundSupervisor", () => {
  it("reconciles once as soon as it becomes leader", async () => {
    const supervisor = build();
    await supervisor.start();

    expect(supervisor.isLeader()).toBe(true);
    expect(jobs.reconciles).toBe(1);
    expect(jobs.stops).toBe(0);

    await supervisor.stop();
  });

  it("keeps re-reading the configuration while it leads", async () => {
    const supervisor = build(5_000);
    await supervisor.start();

    await vi.advanceTimersByTimeAsync(15_000);

    // A change made on another instance has to reach the leader
    // somehow, and polling the config is the only channel there is.
    expect(jobs.reconciles).toBe(4);

    await supervisor.stop();
  });

  it("runs nothing at all when another instance holds the lease", async () => {
    granted.value = false;
    const supervisor = build();
    await supervisor.start();
    await vi.advanceTimersByTimeAsync(30_000);

    expect(supervisor.isLeader()).toBe(false);
    expect(jobs.reconciles).toBe(0);

    await supervisor.stop();
  });

  it("drops every timer when the lease is lost, and stops reconciling", async () => {
    const supervisor = build();
    await supervisor.start();
    expect(jobs.reconciles).toBe(1);

    granted.value = false;
    await vi.advanceTimersByTimeAsync(10_000);

    expect(supervisor.isLeader()).toBe(false);
    expect(jobs.stops).toBe(1);

    const after = jobs.reconciles;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(jobs.reconciles).toBe(after);

    await supervisor.stop();
  });

  it("picks the jobs back up when it regains the lease", async () => {
    const supervisor = build();
    await supervisor.start();

    granted.value = false;
    await vi.advanceTimersByTimeAsync(10_000);
    granted.value = true;
    await vi.advanceTimersByTimeAsync(10_000);

    expect(supervisor.isLeader()).toBe(true);
    expect(jobs.reconciles).toBeGreaterThan(1);

    await supervisor.stop();
  });

  it("applies a config change immediately on the leader", async () => {
    const supervisor = build();
    await supervisor.start();
    const before = jobs.reconciles;

    await supervisor.requestReconcile();

    expect(jobs.reconciles).toBe(before + 1);

    await supervisor.stop();
  });

  it("ignores a config change request on a follower", async () => {
    granted.value = false;
    const supervisor = build();
    await supervisor.start();

    await supervisor.requestReconcile();

    // The leader's own reconcile loop will find the change in the
    // database; a follower must not start a timer of its own.
    expect(jobs.reconciles).toBe(0);

    await supervisor.stop();
  });

  it("keeps leading when a reconcile pass throws", async () => {
    const supervisor = build();
    const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});
    await supervisor.start();

    jobs.failNext = true;
    await vi.advanceTimersByTimeAsync(5_000);

    expect(supervisor.isLeader()).toBe(true);

    // And the next pass still runs — a transient failure must not wedge
    // the loop.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(jobs.reconciles).toBeGreaterThanOrEqual(3);

    consoleErr.mockRestore();
    await supervisor.stop();
  });

  it("stops the jobs on shutdown", async () => {
    const supervisor = build();
    await supervisor.start();
    await supervisor.stop();

    expect(jobs.stops).toBe(1);
    expect(supervisor.isLeader()).toBe(false);
  });
});
