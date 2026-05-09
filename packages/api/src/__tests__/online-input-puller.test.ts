import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  onlineInputPuller,
  type PollFn,
  type PollStats,
} from "../online-input/puller.js";

const NO_OP_STATS: PollStats = { fetched: 0, inserted: 0, skipped: 0, newLastId: 0 };
const noopPoll: PollFn = async () => NO_OP_STATS;

describe("onlineInputPuller (multi-tenant)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    onlineInputPuller.stopAll();
  });

  afterEach(() => {
    onlineInputPuller.stopAll();
    vi.useRealTimers();
  });

  it("reports running=false for unknown competitions", () => {
    expect(onlineInputPuller.getStatus("nope").running).toBe(false);
    expect(onlineInputPuller.isRunning("nope")).toBe(false);
    expect(onlineInputPuller.activeNameIds()).toEqual([]);
  });

  it("starts a per-competition timer and tracks status independently", async () => {
    const pollA = vi.fn<PollFn>().mockResolvedValue({ ...NO_OP_STATS, inserted: 2 });
    const pollB = vi.fn<PollFn>().mockResolvedValue({ ...NO_OP_STATS, inserted: 5 });

    onlineInputPuller.start("compA", 10, pollA);
    onlineInputPuller.start("compB", 30, pollB);

    expect(onlineInputPuller.activeNameIds().sort()).toEqual(["compA", "compB"]);

    await vi.advanceTimersByTimeAsync(0);
    expect(pollA).toHaveBeenCalledExactlyOnceWith("compA");
    expect(pollB).toHaveBeenCalledExactlyOnceWith("compB");
    expect(onlineInputPuller.getStatus("compA").pollCount).toBe(1);
    expect(onlineInputPuller.getStatus("compA").punchesImported).toBe(2);
    expect(onlineInputPuller.getStatus("compB").punchesImported).toBe(5);

    // After 10s only compA ticks
    await vi.advanceTimersByTimeAsync(10_000);
    expect(pollA).toHaveBeenCalledTimes(2);
    expect(pollB).toHaveBeenCalledTimes(1);

    // After 30s total compB also ticks once more
    await vi.advanceTimersByTimeAsync(20_000);
    expect(pollB).toHaveBeenCalledTimes(2);
    // compA: 4 calls × 2 inserted = 8; compB: 2 × 5 = 10
    expect(onlineInputPuller.getStatus("compA").punchesImported).toBe(8);
    expect(onlineInputPuller.getStatus("compB").punchesImported).toBe(10);
  });

  it("stop(nameId) only affects that competition", async () => {
    const pollA = vi.fn<PollFn>().mockResolvedValue(NO_OP_STATS);
    const pollB = vi.fn<PollFn>().mockResolvedValue(NO_OP_STATS);

    onlineInputPuller.start("compA", 10, pollA);
    onlineInputPuller.start("compB", 10, pollB);
    await vi.advanceTimersByTimeAsync(0);

    onlineInputPuller.stop("compA");
    expect(onlineInputPuller.isRunning("compA")).toBe(false);
    expect(onlineInputPuller.isRunning("compB")).toBe(true);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(pollA).toHaveBeenCalledTimes(1);
    expect(pollB).toHaveBeenCalledTimes(2);
  });

  it("start() replaces an existing timer for the same nameId", async () => {
    const first = vi.fn<PollFn>().mockResolvedValue(NO_OP_STATS);
    const second = vi.fn<PollFn>().mockResolvedValue(NO_OP_STATS);

    onlineInputPuller.start("comp", 30, first);
    await vi.advanceTimersByTimeAsync(0);
    expect(first).toHaveBeenCalledTimes(1);

    onlineInputPuller.start("comp", 30, second);
    await vi.advanceTimersByTimeAsync(0);

    expect(onlineInputPuller.getStatus("comp").pollCount).toBe(1);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(2);
  });

  it("captures poll errors into lastError without crashing the timer", async () => {
    const err = new Error("ROC unreachable");
    const failingPoll = vi.fn<PollFn>().mockRejectedValue(err);
    const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});

    onlineInputPuller.start("comp", 30, failingPoll);
    await vi.advanceTimersByTimeAsync(0);

    const status = onlineInputPuller.getStatus("comp");
    expect(status.running).toBe(true);
    expect(status.lastError).toBe("ROC unreachable");
    expect(status.lastPoll).toBeNull();
    expect(status.pollCount).toBe(0);
    expect(status.punchesImported).toBe(0);

    // Recovery: the next tick succeeds and clears lastError
    failingPoll.mockResolvedValueOnce({ ...NO_OP_STATS, inserted: 3 });
    await vi.advanceTimersByTimeAsync(30_000);

    const recovered = onlineInputPuller.getStatus("comp");
    expect(recovered.lastError).toBeNull();
    expect(recovered.pollCount).toBe(1);
    expect(recovered.punchesImported).toBe(3);

    consoleErr.mockRestore();
  });

  it("stopAll() clears every active competition", async () => {
    onlineInputPuller.start("compA", 30, noopPoll);
    onlineInputPuller.start("compB", 30, noopPoll);
    expect(onlineInputPuller.activeNameIds()).toHaveLength(2);

    onlineInputPuller.stopAll();
    expect(onlineInputPuller.activeNameIds()).toHaveLength(0);
    expect(onlineInputPuller.getStatus("compA").running).toBe(false);
    expect(onlineInputPuller.getStatus("compB").running).toBe(false);
  });
});
