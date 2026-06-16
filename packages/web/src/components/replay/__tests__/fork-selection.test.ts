import { describe, it, expect } from "vitest";
import type { ReplayCourse } from "@oxygen/shared";
import { selectForks } from "../fork-selection";

function course(id: string): ReplayCourse {
  return { id, name: `F${id}`, controls: [] };
}

const A = course("A");
const B = course("B");
const C = course("C");
const forks = [A, B, C];

// participant -> fork: p1,p2 ran A; p3 ran B; p4 ran C
const forkByParticipant = new Map<string, string>([
  ["p1", "A"],
  ["p2", "A"],
  ["p3", "B"],
  ["p4", "C"],
]);

describe("selectForks", () => {
  it("non-forked event: the single course is always the primary", () => {
    const sel = selectForks([A], new Map(), new Set(["p1"]), false);
    expect(sel.primaryFork).toBe(A);
    expect(sel.unionForks).toEqual([]);
    expect(sel.unionFaint).toBe(false);
  });

  it("single visible fork: that fork is the primary, no union", () => {
    const sel = selectForks(forks, forkByParticipant, new Set(["p1", "p2"]), false);
    expect(sel.primaryFork).toBe(A);
    expect(sel.unionForks).toEqual([]);
    expect(sel.unionFaint).toBe(false);
  });

  it("runners spanning multiple forks: union of the active forks, no primary", () => {
    const sel = selectForks(forks, forkByParticipant, new Set(["p1", "p3"]), false);
    expect(sel.primaryFork).toBeNull();
    expect(sel.unionForks).toEqual([A, B]);
    expect(sel.unionFaint).toBe(false);
  });

  it("show-all overlays every other fork faint behind a single primary", () => {
    const sel = selectForks(forks, forkByParticipant, new Set(["p1"]), true);
    expect(sel.primaryFork).toBe(A);
    expect(sel.unionForks).toEqual([B, C]);
    expect(sel.unionFaint).toBe(true);
  });

  it("show-all with multiple active forks draws the full union, no primary", () => {
    const sel = selectForks(forks, forkByParticipant, new Set(["p1", "p3"]), true);
    expect(sel.primaryFork).toBeNull();
    expect(sel.unionForks).toEqual([A, B, C]);
    expect(sel.unionFaint).toBe(false);
  });

  it("no visible runners falls back to the full union", () => {
    const sel = selectForks(forks, forkByParticipant, new Set(), false);
    expect(sel.primaryFork).toBeNull();
    expect(sel.unionForks).toEqual([A, B, C]);
    expect(sel.unionFaint).toBe(false);
  });
});
