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

  it("a new entry drains even when other entries are stuck pending", async () => {
    const h = harness();
    h.drain.update(st(2)); // 2 stuck behind auth / event / server
    await h.finish();
    h.drain.update(st(2)); // poll, nothing new
    expect(h.runs()).toBe(1);
    h.drain.update(st(3)); // the operator queues one for the open event
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
