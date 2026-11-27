/**
 * The marks of courses awaiting their computed climb belong to the request
 * that made them (docs/course-elevation.md §6 "When").
 */

import { describe, it, expect } from "vitest";
import { markClimbPending, withClimbMarks } from "../course-climb-pending.js";

const tick = () => new Promise((r) => setTimeout(r, 1));

describe("climb marks (docs/course-elevation.md §6)", () => {
  it("a scope collects its own marks per event, across awaits", async () => {
    const { result, marks } = await withClimbMarks(async () => {
      markClimbPending(1n, ["a"]);
      await tick();
      markClimbPending(1n, ["b", "a"]);
      markClimbPending(2n, ["c"]);
      markClimbPending(2n, []);
      return "done";
    });
    expect(result).toBe("done");
    expect(marks).toEqual(new Map([[1n, new Set(["a", "b"])], [2n, new Set(["c"])]]));
  });

  it("concurrent scopes never see each other's marks", async () => {
    const [x, y] = await Promise.all([
      withClimbMarks(async () => { markClimbPending(1n, ["x"]); await tick(); }),
      withClimbMarks(async () => { await tick(); markClimbPending(1n, ["y"]); }),
    ]);
    expect(x.marks.get(1n)).toEqual(new Set(["x"]));
    expect(y.marks.get(1n)).toEqual(new Set(["y"]));
  });

  it("'all' covers the event and absorbs later marks", async () => {
    const { marks } = await withClimbMarks(async () => {
      markClimbPending(1n, ["a"]);
      markClimbPending(1n, "all");
      markClimbPending(1n, ["b"]);
    });
    expect(marks.get(1n)).toBe("all");
  });

  it("a mark outside a scope is dropped", async () => {
    markClimbPending(1n, ["lost"]);
    const { marks } = await withClimbMarks(async () => {});
    expect(marks.size).toBe(0);
  });

  it("a failing scope throws and hands nothing on", async () => {
    await expect(withClimbMarks(async () => { markClimbPending(1n, ["a"]); throw new Error("rolled back"); })).rejects.toThrow("rolled back");
  });
});
