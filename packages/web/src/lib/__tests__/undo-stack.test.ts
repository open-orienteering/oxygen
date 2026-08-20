import { describe, it, expect } from "vitest";
import { UndoStack } from "../undo-stack";

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
