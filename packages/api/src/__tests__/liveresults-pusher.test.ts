/**
 * Behavioural tests for `liveResultsPusherManager`.
 *
 * The manager owns one `setInterval` per enabled event, runs the
 * provided `SyncFn` immediately on start, and reschedules at
 * `intervalSeconds` cadence. These tests drive the manager with
 * fake timers + injected sync stubs so we can pin:
 *
 *   - the immediate first push + the steady-state interval
 *   - per-event isolation (stopping one doesn't stop another)
 *   - `start()` is idempotent for the same eventId — the old timer
 *     is cleared before the new one is armed
 *   - sync errors land in `lastError` but the timer keeps ticking
 *   - `stopAll()` is the canonical "shut down" hook used at process
 *     teardown
 *
 * Multi-tenancy here is keyed by BigInt eventId (the new schema's
 * `events.id`), not by nameId — that's the only meaningful change
 * vs the pre-PG version.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  liveResultsPusherManager,
  type SyncFn,
  type SyncStats,
} from "../liveresults.js";

const NO_OP_STATS: SyncStats = { runners: 0, results: 0, splitcontrols: 0 };
const noopSync: SyncFn = async () => NO_OP_STATS;

const A = 1001n;
const B = 1002n;

describe("liveResultsPusherManager (multi-tenant)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    liveResultsPusherManager.stopAll();
  });

  afterEach(() => {
    liveResultsPusherManager.stopAll();
    vi.useRealTimers();
  });

  it("reports running=false for unknown events", () => {
    expect(liveResultsPusherManager.getStatus(9999n).running).toBe(false);
    expect(liveResultsPusherManager.isRunning(9999n)).toBe(false);
    expect(liveResultsPusherManager.activeEventIds()).toEqual([]);
  });

  it("starts a per-event timer and tracks status independently", async () => {
    const syncA = vi.fn<SyncFn>().mockResolvedValue(NO_OP_STATS);
    const syncB = vi.fn<SyncFn>().mockResolvedValue(NO_OP_STATS);

    liveResultsPusherManager.start(A, 100, 30, syncA);
    liveResultsPusherManager.start(B, 200, 30, syncB);

    const active = liveResultsPusherManager.activeEventIds().sort();
    expect(active).toEqual([A, B]);
    expect(liveResultsPusherManager.getStatus(A).tavid).toBe(100);
    expect(liveResultsPusherManager.getStatus(B).tavid).toBe(200);

    // Drain the immediate-run microtasks queued by `start()`.
    await vi.advanceTimersByTimeAsync(0);
    expect(syncA).toHaveBeenCalledExactlyOnceWith(100, A);
    expect(syncB).toHaveBeenCalledExactlyOnceWith(200, B);
    expect(liveResultsPusherManager.getStatus(A).pushCount).toBe(1);
    expect(liveResultsPusherManager.getStatus(B).pushCount).toBe(1);

    // After 30s a second tick should fire for each tenant.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(syncA).toHaveBeenCalledTimes(2);
    expect(syncB).toHaveBeenCalledTimes(2);
  });

  it("stop(eventId) only affects that event", async () => {
    const syncA = vi.fn<SyncFn>().mockResolvedValue(NO_OP_STATS);
    const syncB = vi.fn<SyncFn>().mockResolvedValue(NO_OP_STATS);

    liveResultsPusherManager.start(A, 1, 10, syncA);
    liveResultsPusherManager.start(B, 2, 10, syncB);
    await vi.advanceTimersByTimeAsync(0);

    liveResultsPusherManager.stop(A);
    expect(liveResultsPusherManager.isRunning(A)).toBe(false);
    expect(liveResultsPusherManager.isRunning(B)).toBe(true);

    await vi.advanceTimersByTimeAsync(10_000);
    // syncA: 1 immediate only; syncB: 1 immediate + 1 interval = 2
    expect(syncA).toHaveBeenCalledTimes(1);
    expect(syncB).toHaveBeenCalledTimes(2);
  });

  it("start() replaces an existing timer for the same eventId", async () => {
    const first = vi.fn<SyncFn>().mockResolvedValue(NO_OP_STATS);
    const second = vi.fn<SyncFn>().mockResolvedValue(NO_OP_STATS);

    liveResultsPusherManager.start(A, 1, 30, first);
    await vi.advanceTimersByTimeAsync(0);
    expect(first).toHaveBeenCalledTimes(1);

    liveResultsPusherManager.start(A, 1, 30, second);
    await vi.advanceTimersByTimeAsync(0);

    // pushCount resets on restart.
    expect(liveResultsPusherManager.getStatus(A).pushCount).toBe(1);

    // After the next interval, only `second` should be called —
    // `first`'s timer was cleared by the restart.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(2);
  });

  it("captures sync errors into lastError without crashing the timer", async () => {
    const err = new Error("LR unreachable");
    const failingSync = vi.fn<SyncFn>().mockRejectedValue(err);
    // Silence the manager's console.error noise for the failing sync.
    const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});

    liveResultsPusherManager.start(A, 1, 30, failingSync);
    await vi.advanceTimersByTimeAsync(0);

    const status = liveResultsPusherManager.getStatus(A);
    expect(status.running).toBe(true);
    expect(status.lastError).toBe("LR unreachable");
    expect(status.lastPush).toBeNull();
    expect(status.pushCount).toBe(0);

    // Timer keeps ticking — a recovered sync on the next tick should
    // clear the error state.
    failingSync.mockResolvedValueOnce(NO_OP_STATS);
    await vi.advanceTimersByTimeAsync(30_000);
    const status2 = liveResultsPusherManager.getStatus(A);
    expect(status2.lastError).toBeNull();
    expect(status2.pushCount).toBe(1);

    consoleErr.mockRestore();
  });

  it("stopAll() clears every active event", async () => {
    liveResultsPusherManager.start(A, 1, 30, noopSync);
    liveResultsPusherManager.start(B, 2, 30, noopSync);
    expect(liveResultsPusherManager.activeEventIds()).toHaveLength(2);

    liveResultsPusherManager.stopAll();
    expect(liveResultsPusherManager.activeEventIds()).toHaveLength(0);
    expect(liveResultsPusherManager.getStatus(A).running).toBe(false);
    expect(liveResultsPusherManager.getStatus(B).running).toBe(false);
  });
});
