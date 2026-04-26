import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { liveResultsPusher, type SyncFn, type SyncStats } from "../liveresults.js";

const NO_OP_STATS: SyncStats = { runners: 0, results: 0, splitcontrols: 0 };
const noopSync: SyncFn = async () => NO_OP_STATS;

describe("liveResultsPusher (multi-tenant)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    liveResultsPusher.stopAll();
  });

  afterEach(() => {
    liveResultsPusher.stopAll();
    vi.useRealTimers();
  });

  it("reports running=false for unknown competitions", () => {
    expect(liveResultsPusher.getStatus("nope").running).toBe(false);
    expect(liveResultsPusher.isRunning("nope")).toBe(false);
    expect(liveResultsPusher.activeNameIds()).toEqual([]);
  });

  it("starts a per-competition timer and tracks status independently", async () => {
    const syncA = vi.fn<SyncFn>().mockResolvedValue(NO_OP_STATS);
    const syncB = vi.fn<SyncFn>().mockResolvedValue(NO_OP_STATS);

    liveResultsPusher.start("compA", 100, 30, syncA);
    liveResultsPusher.start("compB", 200, 30, syncB);

    expect(liveResultsPusher.activeNameIds().sort()).toEqual(["compA", "compB"]);
    expect(liveResultsPusher.getStatus("compA").tavid).toBe(100);
    expect(liveResultsPusher.getStatus("compB").tavid).toBe(200);

    // Drain the immediate-run microtasks queued by start()
    await vi.advanceTimersByTimeAsync(0);
    expect(syncA).toHaveBeenCalledExactlyOnceWith(100, "compA");
    expect(syncB).toHaveBeenCalledExactlyOnceWith(200, "compB");
    expect(liveResultsPusher.getStatus("compA").pushCount).toBe(1);
    expect(liveResultsPusher.getStatus("compB").pushCount).toBe(1);

    // After 30s a second tick should fire for each tenant
    await vi.advanceTimersByTimeAsync(30_000);
    expect(syncA).toHaveBeenCalledTimes(2);
    expect(syncB).toHaveBeenCalledTimes(2);
  });

  it("stop(nameId) only affects that competition", async () => {
    const syncA = vi.fn<SyncFn>().mockResolvedValue(NO_OP_STATS);
    const syncB = vi.fn<SyncFn>().mockResolvedValue(NO_OP_STATS);

    liveResultsPusher.start("compA", 1, 10, syncA);
    liveResultsPusher.start("compB", 2, 10, syncB);
    await vi.advanceTimersByTimeAsync(0);

    liveResultsPusher.stop("compA");
    expect(liveResultsPusher.isRunning("compA")).toBe(false);
    expect(liveResultsPusher.isRunning("compB")).toBe(true);

    await vi.advanceTimersByTimeAsync(10_000);
    // syncA: 1 immediate call only; syncB: 1 immediate + 1 interval = 2
    expect(syncA).toHaveBeenCalledTimes(1);
    expect(syncB).toHaveBeenCalledTimes(2);
  });

  it("start() replaces an existing timer for the same nameId", async () => {
    const first = vi.fn<SyncFn>().mockResolvedValue(NO_OP_STATS);
    const second = vi.fn<SyncFn>().mockResolvedValue(NO_OP_STATS);

    liveResultsPusher.start("comp", 1, 30, first);
    await vi.advanceTimersByTimeAsync(0);
    expect(first).toHaveBeenCalledTimes(1);

    liveResultsPusher.start("comp", 1, 30, second);
    await vi.advanceTimersByTimeAsync(0);

    // pushCount resets on restart
    expect(liveResultsPusher.getStatus("comp").pushCount).toBe(1);

    // After the next interval, only `second` should be called — `first`'s
    // timer was cleared
    await vi.advanceTimersByTimeAsync(30_000);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(2);
  });

  it("captures sync errors into lastError without crashing the timer", async () => {
    const err = new Error("LR unreachable");
    const failingSync = vi.fn<SyncFn>().mockRejectedValue(err);
    // Silence the manager's console.error noise during the failing sync
    const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});

    liveResultsPusher.start("comp", 1, 30, failingSync);
    await vi.advanceTimersByTimeAsync(0);

    const status = liveResultsPusher.getStatus("comp");
    expect(status.running).toBe(true);
    expect(status.lastError).toBe("LR unreachable");
    expect(status.lastPush).toBeNull();
    expect(status.pushCount).toBe(0);

    consoleErr.mockRestore();
  });

  it("stopAll() clears every active competition", async () => {
    liveResultsPusher.start("compA", 1, 30, noopSync);
    liveResultsPusher.start("compB", 2, 30, noopSync);
    expect(liveResultsPusher.activeNameIds()).toHaveLength(2);

    liveResultsPusher.stopAll();
    expect(liveResultsPusher.activeNameIds()).toHaveLength(0);
    expect(liveResultsPusher.getStatus("compA").running).toBe(false);
    expect(liveResultsPusher.getStatus("compB").running).toBe(false);
  });
});
