import { describe, it, expect } from "vitest";
import { WriteGate, queuedEditAction, serialQueue } from "../write-gate";

const deferred = () => { let resolve!: () => void; const p = new Promise<void>((r) => { resolve = r; }); return { p, resolve }; };
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("WriteGate: ordinary writes side by side, an undo step alone (D6)", () => {
  it("a step waits for the ordinary writes before it, and holds back the ones asked after it", async () => {
    const g = new WriteGate();
    const log: string[] = [];
    const a = deferred();
    const w1 = g.runShared(async () => { log.push("w1"); await a.p; log.push("w1 end"); });
    const w2 = g.runShared(async () => { log.push("w2"); });
    const step = g.runExclusive(async () => { log.push("undo"); });
    const w3 = g.runShared(async () => { log.push("w3"); });
    await tick();
    expect(log).toEqual(["w1", "w2"]);
    a.resolve();
    await Promise.all([w1, w2, step, w3]);
    expect(log).toEqual(["w1", "w2", "w1 end", "undo", "w3"]);
  });

  it("a failing step frees the gate", async () => {
    const g = new WriteGate();
    await expect(g.runExclusive(async () => { throw new Error("x"); })).rejects.toThrow("x");
    expect(await g.runShared(async () => 1)).toBe(1);
  });
});

describe("serialQueue and queuedEditAction (CRS-018)", () => {
  it("a second edit asked while the first is in flight is built once the first has settled, on its result", async () => {
    const q = serialQueue();
    let structure = ["31", "32", "33"];
    const reply = deferred();
    const first = q(async () => { const next = structure.filter((c) => c !== "32"); await reply.p; structure = next; });
    const second = q(async () => { structure = [...structure, "34"]; });
    reply.resolve();
    await Promise.all([first, second]);
    expect(structure).toEqual(["31", "33", "34"]);
  });

  it("a refused op does not stop the queue", async () => {
    const q = serialQueue();
    await expect(q(async () => { throw new Error("refused"); })).rejects.toThrow();
    expect(await q(async () => "next")).toBe("next");
  });

  it("drops an edit of a course no longer selected; a positional one on a changed structure asks to do it again", () => {
    expect(queuedEditAction({ courseId: 1, version: "5" }, { courseId: 2, version: "9" }, false)).toBe("drop");
    expect(queuedEditAction({ courseId: 1, version: "5" }, { courseId: 1, version: "6" }, true)).toBe("again");
    expect(queuedEditAction({ courseId: 1, version: "5" }, { courseId: 1, version: "6" }, false)).toBe("apply");
    expect(queuedEditAction({ courseId: 1, version: "5" }, { courseId: 1, version: "5" }, true)).toBe("apply");
  });
});
