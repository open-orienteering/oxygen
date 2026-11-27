import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  _resetUnhandledRejectionLogger,
  createShutdown,
  installUnhandledRejectionLogger,
  SHUTDOWN_DEADLINE_MS,
} from "../process-guards.js";

describe("installUnhandledRejectionLogger", () => {
  beforeEach(() => _resetUnhandledRejectionLogger());
  afterEach(() => {
    process.removeAllListeners("unhandledRejection");
    _resetUnhandledRejectionLogger();
  });

  it("registers once and logs reason with stack", () => {
    const before = process.listenerCount("unhandledRejection");
    const log = vi.fn();
    installUnhandledRejectionLogger(log);
    installUnhandledRejectionLogger(log);
    expect(process.listenerCount("unhandledRejection")).toBe(before + 1);
    const err = new Error("boom");
    process.emit("unhandledRejection", err, Promise.resolve());
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toBe("[process] unhandled rejection:");
    expect(String(log.mock.calls[0][2])).toContain("boom");
    expect(String(log.mock.calls[0][2])).toContain("at ");
  });
});

describe("createShutdown", () => {
  afterEach(() => vi.useRealTimers());

  it("runs steps in order then exits 0", async () => {
    const order: string[] = [];
    const exit = vi.fn();
    const sd = createShutdown({
      steps: [
        { name: "a", run: async () => void order.push("a") },
        { name: "b", run: () => void order.push("b") },
      ],
      exit,
      log: vi.fn(),
    });
    await sd();
    expect(order).toEqual(["a", "b"]);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("ignores a second call", async () => {
    const run = vi.fn();
    const log = vi.fn();
    const sd = createShutdown({ steps: [{ name: "a", run }], exit: vi.fn(), log });
    await sd();
    await sd();
    expect(run).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledTimes(1);
  });

  it("exits 1 at the deadline when a step never settles", async () => {
    vi.useFakeTimers();
    const exit = vi.fn();
    const sd = createShutdown({
      steps: [{ name: "hang", run: () => new Promise(() => {}) }],
      exit,
      log: vi.fn(),
    });
    void sd();
    await vi.advanceTimersByTimeAsync(SHUTDOWN_DEADLINE_MS - 1);
    expect(exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("a throwing step does not skip later ones", async () => {
    const later = vi.fn();
    const exit = vi.fn();
    const log = vi.fn();
    const sd = createShutdown({
      steps: [
        { name: "bad", run: () => { throw new Error("x"); } },
        { name: "good", run: later },
      ],
      exit,
      log,
    });
    await sd();
    expect(later).toHaveBeenCalled();
    expect(log).toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(0);
  });
});
