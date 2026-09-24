import { describe, expect, it } from "vitest";
import { ttlMemo } from "../ttl-memo.js";

describe("ttlMemo", () => {
  it("computes once within the ttl and again after it", async () => {
    let clock = 0;
    let calls = 0;
    const memo = ttlMemo(1000, async () => ++calls, () => clock);

    expect(await memo.get()).toBe(1);
    clock = 999;
    expect(await memo.get()).toBe(1);
    clock = 1000;
    expect(await memo.get()).toBe(2);
    expect(calls).toBe(2);
  });

  it("shares one in-flight computation between concurrent callers", async () => {
    let calls = 0;
    let release!: (v: number) => void;
    const memo = ttlMemo(1000, () => {
      calls++;
      return new Promise<number>((r) => (release = r));
    });
    const a = memo.get();
    const b = memo.get();
    release(42);
    expect(await Promise.all([a, b])).toEqual([42, 42]);
    expect(calls).toBe(1);
  });

  it("does not cache a failure", async () => {
    let calls = 0;
    const memo = ttlMemo(1000, async () => {
      calls++;
      if (calls === 1) throw new Error("boom");
      return "ok";
    });
    await expect(memo.get()).rejects.toThrow("boom");
    expect(await memo.get()).toBe("ok");
  });

  it("clear() forces a recompute", async () => {
    let calls = 0;
    const memo = ttlMemo(1000, async () => ++calls);
    await memo.get();
    memo.clear();
    expect(await memo.get()).toBe(2);
  });
});
