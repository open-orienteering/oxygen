import { describe, it, expect } from "vitest";
import { UndoStack } from "../undo-stack";
import { WriteGate } from "../editor/write-gate";

function entry(log: string[], name: string) {
  return {
    undo: async () => { log.push(`undo:${name}`); },
    redo: async () => { log.push(`redo:${name}`); },
  };
}

describe("UndoStack", () => {
  it("starts empty", () => {
    const s = new UndoStack();
    expect(s.canUndo).toBe(false);
    expect(s.canRedo).toBe(false);
  });

  it("undo runs the inverse of the last pushed entry", async () => {
    const log: string[] = [];
    const s = new UndoStack();
    s.push(entry(log, "a"));
    s.push(entry(log, "b"));
    expect(await s.undo()).toBe(true);
    expect(log).toEqual(["undo:b"]);
    expect(await s.undo()).toBe(true);
    expect(log).toEqual(["undo:b", "undo:a"]);
    expect(s.canUndo).toBe(false);
  });

  it("redo re-applies undone entries in order", async () => {
    const log: string[] = [];
    const s = new UndoStack();
    s.push(entry(log, "a"));
    s.push(entry(log, "b"));
    await s.undo();
    await s.undo();
    expect(s.canRedo).toBe(true);
    expect(await s.redo()).toBe(true);
    expect(await s.redo()).toBe(true);
    expect(log).toEqual(["undo:b", "undo:a", "redo:a", "redo:b"]);
    expect(s.canRedo).toBe(false);
    expect(s.canUndo).toBe(true);
  });

  it("undo/redo return false when there is nothing to do", async () => {
    const s = new UndoStack();
    expect(await s.undo()).toBe(false);
    expect(await s.redo()).toBe(false);
  });

  it("a new push clears the redo branch", async () => {
    const log: string[] = [];
    const s = new UndoStack();
    s.push(entry(log, "a"));
    await s.undo();
    expect(s.canRedo).toBe(true);
    s.push(entry(log, "b"));
    expect(s.canRedo).toBe(false);
    await s.undo();
    expect(log).toEqual(["undo:a", "undo:b"]);
  });

  it("drops the oldest entries beyond the cap", async () => {
    const log: string[] = [];
    const s = new UndoStack(3);
    for (const n of ["a", "b", "c", "d"]) s.push(entry(log, n));
    await s.undo();
    await s.undo();
    await s.undo();
    expect(s.canUndo).toBe(false); // "a" fell off
    expect(log).toEqual(["undo:d", "undo:c", "undo:b"]);
  });

  it("an entry whose undo throws is dropped (stack stays usable)", async () => {
    const log: string[] = [];
    const s = new UndoStack();
    s.push(entry(log, "a"));
    s.push({
      undo: async () => { throw new Error("server says no"); },
      redo: async () => {},
    });
    await expect(s.undo()).rejects.toThrow("server says no");
    expect(s.canRedo).toBe(false); // failed entry not moved to redo
    expect(await s.undo()).toBe(true); // next entry still works
    expect(log).toEqual(["undo:a"]);
  });
});

describe("UndoStack.top", () => {
  it("is the entry the next undo reverses", async () => {
    const s = new UndoStack(5);
    expect(s.top).toBeUndefined();
    const a = { undo: () => {}, redo: () => {} }, b = { undo: () => {}, redo: () => {} };
    s.push(a);
    s.push(b);
    expect(s.top).toBe(b);
    await s.undo();
    expect(s.top).toBe(a);
  });
});

describe("UndoStack.nextRedo", () => {
  it("is the entry the next redo re-applies (D9c: offline, only Field mode's queued writes undo / redo)", async () => {
    const s = new UndoStack(5);
    expect(s.nextRedo).toBeUndefined();
    const a = { undo: () => {}, redo: () => {} }, b = { undo: () => {}, redo: () => {} };
    s.push(a);
    s.push(b);
    await s.undo();
    expect(s.nextRedo).toBe(b);
    await s.undo();
    expect(s.nextRedo).toBe(a);
    s.push(b);
    expect(s.nextRedo).toBeUndefined();
  });
});

describe("UndoStack.remove", () => {
  it("drops matching entries from both branches and keeps the rest in order (G12b: a promote drops Map mode's)", async () => {
    const log: string[] = [];
    const s = new UndoStack(10);
    const [a, b, c, d] = ["a", "b", "c", "d"].map((n) => entry(log, n));
    for (const e of [a, b, c, d]) s.push(e);
    await s.undo(); // d → future
    const gone = new Set<object>([b, d]);
    expect(s.remove((e) => gone.has(e))).toBe(2);
    expect(s.canRedo).toBe(false);
    expect(s.top).toBe(c);
    await s.undo();
    await s.undo();
    expect(s.canUndo).toBe(false);
    expect(log).toEqual(["undo:d", "undo:c", "undo:a"]);
    expect(s.remove(() => true)).toBe(2);
    expect(s.canRedo).toBe(false);
  });
});

describe("UndoStack: one undo / redo at a time (CRS-050)", () => {
  const deferred = () => { let resolve!: () => void; const p = new Promise<void>((r) => { resolve = r; }); return { p, resolve }; };

  it("overlapping undos run in press order, each picking its entry once the one before has settled; redo is the reverse", async () => {
    const log: string[] = [];
    const slow = deferred();
    const s = new UndoStack();
    const a = { undo: async () => { log.push("undo:a"); }, redo: async () => { log.push("redo:a"); } };
    const b = { undo: async () => { log.push("undo:b:start"); await slow.p; log.push("undo:b:end"); }, redo: async () => { log.push("redo:b"); } };
    s.push(a);
    s.push(b);
    const first = s.undo();
    const second = s.undo(); // a held Ctrl+Z
    await Promise.resolve();
    expect(log).toEqual(["undo:b:start"]);
    slow.resolve();
    expect(await first).toBe(true);
    expect(await second).toBe(true);
    expect(log).toEqual(["undo:b:start", "undo:b:end", "undo:a"]);
    expect(s.nextRedo).toBe(a);
    await s.redo();
    await s.redo();
    expect(log.slice(-2)).toEqual(["redo:a", "redo:b"]);
  });

  it("a refused entry does not block the queue; a third press with nothing left answers false", async () => {
    const s = new UndoStack();
    s.push({ undo: async () => undefined, redo: async () => undefined });
    s.push({ undo: async () => { throw new Error("refused"); }, redo: async () => undefined });
    const r1 = s.undo();
    const r2 = s.undo();
    const r3 = s.undo();
    await expect(r1).rejects.toThrow("refused");
    expect(await r2).toBe(true);
    expect(await r3).toBe(false);
  });

  it("`allow` is asked when the entry is picked and leaves a refused one in place", async () => {
    const s = new UndoStack();
    const e = { undo: async () => undefined, redo: async () => undefined };
    s.push(e);
    expect(await s.undo(() => false)).toBe(false);
    expect(s.top).toBe(e);
  });

  it("the step runner wraps each step and renews the entry's rows (D6)", async () => {
    const seen: string[] = [];
    const s = new UndoStack(50, async (entry, step) => {
      seen.push(entry.rows?.[0]?.version ?? "-");
      await step();
      return [{ kind: "course", id: 1, version: String(Number(entry.rows![0].version) + 1) }];
    });
    s.push({ undo: async () => undefined, redo: async () => undefined, rows: [{ kind: "course", id: 1, version: "5" }] });
    await s.undo();
    await s.redo();
    expect(seen).toEqual(["5", "6"]);
    expect(s.top?.rows).toEqual([{ kind: "course", id: 1, version: "7" }]);
  });

  it("with the write gate as its lock, Ctrl+Z during a gesture undoes that gesture once it has settled (CRS-050)", async () => {
    const gate = new WriteGate();
    const log: string[] = [];
    const s = new UndoStack(50, undefined, (op) => gate.runStep(op));
    s.push(entry(log, "a"));
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    // Gesture b is in flight: like the page's `run(...)` then `record(...)`, its entry is pushed after the
    // gated write has returned, a few microtasks after the gate let go.
    const gesture = (async () => {
      await gate.runShared(async () => { await held; });
      await Promise.resolve();
      await Promise.resolve();
      s.push(entry(log, "b"));
    })();
    const undo = s.undo();
    await new Promise((r) => setTimeout(r, 0));
    expect(log).toEqual([]);
    release();
    await gesture;
    await undo;
    expect(log).toEqual(["undo:b"]);
  });
});
