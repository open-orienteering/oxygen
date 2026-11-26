import { describe, expect, it } from "vitest";
import { createAutoDrain } from "../offline/auto-drain";

function harness() {
  const releases: Array<() => void> = [];
  let runs = 0;
  const drain = createAutoDrain(
    () =>
      new Promise<void>((resolve) => {
        runs++;
        releases.push(resolve);
      }),
  );
  return { drain, runs: () => runs, finish: async () => { releases.shift()?.(); await Promise.resolve(); await Promise.resolve(); } };
}
const st = (total: number, over = {}) => ({ online: true, total, scope: "a", ...over });

describe("auto drain", () => {
  it("drains once on mount with pending work, not again while the count stays", () => {
    const h = harness();
    h.drain.update(st(3));
    h.drain.update(st(3));
    expect(h.runs()).toBe(1);
  });

  it("a new entry drains even when other entries are stuck pending, and stuck entries alone never retrigger", async () => {
    const h = harness();
    h.drain.update(st(2)); // 2 stuck behind auth / event / server
    await h.finish();
    h.drain.update(st(2)); // poll, nothing new
    h.drain.update(st(2));
    expect(h.runs()).toBe(1);
    h.drain.update(st(2)); // the operator queues one: the signal fires before the poll sees it
    h.drain.enqueued();
    expect(h.runs()).toBe(2);
  });

  it("one entry synced, a new one queued before the next poll (same count): it still drains", async () => {
    const h = harness();
    h.drain.update(st(1)); // poll sees entry 1
    expect(h.runs()).toBe(1);
    await h.finish(); // entry 1 syncs
    h.drain.enqueued(); // entry 2 queued; the polled count is still 1
    expect(h.runs()).toBe(2);
    await h.finish();
    h.drain.update(st(1)); // the poll now sees entry 2 alone: same count, no new trigger
    expect(h.runs()).toBe(2);
  });

  it("a signal while a drain runs asks for one more run right after; offline or stopped it does nothing", async () => {
    const h = harness();
    h.drain.update(st(1));
    h.drain.enqueued();
    h.drain.enqueued();
    expect(h.runs()).toBe(1);
    await h.finish();
    expect(h.runs()).toBe(2);
    await h.finish();
    h.drain.update(st(1, { online: false }));
    h.drain.enqueued();
    expect(h.runs()).toBe(2);
    h.drain.update(st(1));
    await h.finish();
    h.drain.stop();
    h.drain.enqueued();
    expect(h.runs()).toBe(3);
  });

  it("a count that grows without a signal (another tab queued it) still drains", async () => {
    const h = harness();
    h.drain.update(st(2));
    await h.finish();
    h.drain.update(st(3));
    expect(h.runs()).toBe(2);
  });

  it("does not pile up: work arriving mid-drain runs once after it", async () => {
    const h = harness();
    h.drain.update(st(1));
    h.drain.update(st(2));
    h.drain.update(st(3));
    expect(h.runs()).toBe(1);
    await h.finish();
    expect(h.runs()).toBe(2);
    await h.finish();
    expect(h.runs()).toBe(2);
  });

  it("drains when coming back online or when the open competition changes; never offline or empty", async () => {
    const h = harness();
    h.drain.update(st(2, { online: false }));
    expect(h.runs()).toBe(0);
    h.drain.update(st(2));
    expect(h.runs()).toBe(1);
    await h.finish();
    h.drain.update(st(2, { scope: "b" }));
    expect(h.runs()).toBe(2);
    await h.finish();
    h.drain.update(st(0));
    expect(h.runs()).toBe(2);
  });

  it("stop() ends it", () => {
    const h = harness();
    h.drain.stop();
    h.drain.update(st(1));
    expect(h.runs()).toBe(0);
  });
});

describe("auto drain retry after a failed drain (SYNC-11)", () => {
  function retryHarness() {
    const outcomes: Array<"ok" | "retry" | "blocked"> = [];
    let runs = 0;
    const timers: Array<{ fn: () => void; ms: number; live: boolean }> = [];
    const drain = createAutoDrain(
      async () => {
        runs++;
        return outcomes.shift() ?? "ok";
      },
      {
        setTimer: (fn, ms) => {
          const t = { fn, ms, live: true };
          timers.push(t);
          return t;
        },
        clearTimer: (t) => {
          (t as { live: boolean }).live = false;
        },
      },
    );
    const settle = async () => {
      for (let i = 0; i < 5; i++) await Promise.resolve();
    };
    const live = () => timers.filter((t) => t.live);
    const fire = async () => {
      const t = live()[0];
      t.live = false;
      t.fn();
      await settle();
    };
    return { drain, outcomes, runs: () => runs, live, fire, settle };
  }

  it("retries on its own with 2 s doubling to 30 s while the node stays unreachable", async () => {
    const h = retryHarness();
    h.outcomes.push(...Array(8).fill("retry"));
    h.drain.update(st(6));
    await h.settle();
    const delays: number[] = [];
    for (let i = 0; i < 6; i++) {
      expect(h.live()).toHaveLength(1);
      delays.push(h.live()[0].ms);
      await h.fire();
    }
    expect(delays).toEqual([2000, 4000, 8000, 16000, 30000, 30000]);
    expect(h.runs()).toBe(7);
  });

  it("a successful run resets the delay; an ok run schedules nothing", async () => {
    const h = retryHarness();
    h.outcomes.push("retry", "retry", "ok", "retry");
    h.drain.update(st(1));
    await h.settle();
    await h.fire(); // 2 s
    await h.fire(); // 4 s -> ok
    expect(h.live()).toHaveLength(0);
    h.drain.enqueued(); // -> retry
    await h.settle();
    expect(h.live()[0].ms).toBe(2000);
  });

  it("a queued entry mid-backoff drains at once but does not reset the delay", async () => {
    const h = retryHarness();
    h.outcomes.push("retry", "retry", "retry");
    h.drain.update(st(1));
    await h.settle();
    expect(h.live()[0].ms).toBe(2000);
    h.drain.enqueued();
    await h.settle();
    expect(h.runs()).toBe(2);
    expect(h.live()).toHaveLength(1);
    expect(h.live()[0].ms).toBe(4000);
  });

  it("'blocked' (auth, unknown event) schedules nothing", async () => {
    const h = retryHarness();
    h.outcomes.push("blocked");
    h.drain.update(st(1));
    await h.settle();
    expect(h.live()).toHaveLength(0);
  });

  it("going offline, an empty queue, or stop() cancel the retry", async () => {
    const h = retryHarness();
    h.outcomes.push("retry", "retry", "retry");
    h.drain.update(st(1));
    await h.settle();
    h.drain.update(st(1, { online: false }));
    expect(h.live()).toHaveLength(0);
    h.drain.update(st(1));
    await h.settle();
    expect(h.live()).toHaveLength(1);
    h.drain.update(st(0));
    expect(h.live()).toHaveLength(0);
    h.drain.update(st(1));
    await h.settle();
    h.drain.stop();
    expect(h.live()).toHaveLength(0);
  });

  it("kick() runs at once when there is work, and not when there is none", async () => {
    const h = retryHarness();
    h.drain.kick();
    expect(h.runs()).toBe(0);
    h.outcomes.push("retry", "ok");
    h.drain.update(st(1));
    await h.settle();
    expect(h.runs()).toBe(1);
    h.drain.kick();
    await h.settle();
    expect(h.runs()).toBe(2);
    expect(h.live()).toHaveLength(0);
  });

  it("a run that throws counts as retry", async () => {
    const timers: number[] = [];
    const drain = createAutoDrain(async () => { throw new Error("x"); }, {
      setTimer: (_fn, ms) => { timers.push(ms); return ms; },
      clearTimer: () => {},
    });
    drain.update(st(1));
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(timers).toEqual([2000]);
  });

  it("a failed drain started by the first enqueue schedules its retry before any poll", async () => {
    const h = retryHarness();
    h.outcomes.push("retry");
    h.drain.update(st(0)); // the poll saw nothing yet
    h.drain.enqueued();
    await h.settle();
    expect(h.runs()).toBe(1);
    expect(h.live()).toHaveLength(1);
  });

  it("an entry queued offline in a hidden tab drains when the device is back online, though the poll never saw it", async () => {
    const h = retryHarness();
    h.drain.update(st(0, { online: false }));
    h.drain.enqueued(); // offline: nothing runs
    expect(h.runs()).toBe(0);
    h.drain.update(st(0)); // online again, the paused poll still says 0
    await h.settle();
    expect(h.runs()).toBe(1);
  });

  it("after a clean drain the count is forgotten, so growth seen by the poll drains again", async () => {
    const h = retryHarness();
    h.outcomes.push("ok", "ok");
    h.drain.update(st(0));
    h.drain.enqueued();
    await h.settle();
    expect(h.runs()).toBe(1);
    h.drain.update(st(1)); // another tab queued one
    await h.settle();
    expect(h.runs()).toBe(2);
  });
});
