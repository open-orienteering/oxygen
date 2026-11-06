import { describe, it, expect, afterEach } from "vitest";
import { Semaphore, intSetting, renderConcurrency } from "../map-render-limits.js";

describe("intSetting", () => {
  it("falls back to the default when unset or empty", () => {
    expect(intSetting(undefined, 4, 1)).toBe(4);
    expect(intSetting("", 4, 1)).toBe(4);
  });

  it("accepts a valid override", () => {
    expect(intSetting("8", 4, 1)).toBe(8);
  });

  it("rejects garbage, fractions and values below the minimum", () => {
    expect(intSetting("lots", 4, 1)).toBe(4);
    expect(intSetting("0", 4, 1)).toBe(4);
    expect(intSetting("-2", 4, 1)).toBe(4);
    expect(intSetting("2.5", 4, 1)).toBe(4);
  });

  it("allows a minimum of zero when the setting permits it", () => {
    expect(intSetting("0", 4, 0)).toBe(0);
  });
});

describe("renderConcurrency", () => {
  const saved = process.env.MAP_RENDER_CONCURRENCY;
  afterEach(() => {
    if (saved === undefined) delete process.env.MAP_RENDER_CONCURRENCY;
    else process.env.MAP_RENDER_CONCURRENCY = saved;
  });

  it("defaults to 2 and reads MAP_RENDER_CONCURRENCY", () => {
    delete process.env.MAP_RENDER_CONCURRENCY;
    expect(renderConcurrency()).toBe(2);
    process.env.MAP_RENDER_CONCURRENCY = "3";
    expect(renderConcurrency()).toBe(3);
  });
});

describe("Semaphore", () => {
  it("runs tasks immediately up to the limit", async () => {
    const sem = new Semaphore(2);
    let running = 0;
    let peak = 0;
    const task = async () => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 5));
      running--;
    };
    await Promise.all([sem.run(task), sem.run(task), sem.run(task), sem.run(task)]);
    expect(peak).toBe(2);
  });

  it("returns the task's value", async () => {
    const sem = new Semaphore(1);
    await expect(sem.run(async () => 42)).resolves.toBe(42);
  });

  // A throwing render must not leak a permit, or the gate wedges after
  // a handful of bad prints.
  it("releases the permit when a task throws", async () => {
    const sem = new Semaphore(1);
    await expect(sem.run(async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    await expect(sem.run(async () => "ok")).resolves.toBe("ok");
  });

  it("serialises when the limit is 1, in arrival order", async () => {
    const sem = new Semaphore(1);
    const order: string[] = [];
    const a = sem.run(async () => {
      order.push("a-start");
      await new Promise((r) => setTimeout(r, 10));
      order.push("a-end");
    });
    const b = sem.run(async () => {
      order.push("b-start");
    });
    const c = sem.run(async () => {
      order.push("c-start");
    });
    await Promise.all([a, b, c]);
    expect(order).toEqual(["a-start", "a-end", "b-start", "c-start"]);
  });

  it("waits without limit: twenty waiters all run", async () => {
    const sem = new Semaphore(1);
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const blocker = sem.run(() => held);
    const many = Array.from({ length: 20 }, (_, i) => sem.run(async () => i));
    release();
    await expect(Promise.all(many)).resolves.toHaveLength(20);
    await blocker;
  });
});
