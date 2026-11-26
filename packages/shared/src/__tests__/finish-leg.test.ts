import { describe, it, expect } from "vitest";
import { finishLegOf } from "../results.js";

// Course 31-32-33 starting 10:00:00 (360000 ds); legs into 31, 32, 33, finish.
const legs = [420, 310, 180, 240];
const ok = (punchTime: number) => ({ positionMode: "required", status: "ok", punchTime });
const missing = { positionMode: "required", status: "missing", punchTime: 0 };

describe("finishLegOf (CRS-013)", () => {
  it("is last control to finish, with the finish leg's length", () => {
    const leg = finishLegOf([ok(363000), ok(366000), ok(370000)], 360000, 370250, legs);
    expect(leg).toEqual({ splitTime: 250, legLength: 240 });
  });

  it("is unknown when the last control was missed", () => {
    expect(finishLegOf([ok(363000), ok(366000), missing], 360000, 370250, legs)).toEqual({ splitTime: 0, legLength: 0 });
  });

  it("ignores skipped positions after the last timed one", () => {
    const skipped = { positionMode: "skipped", status: "missing", punchTime: 0 };
    expect(finishLegOf([ok(363000), ok(370000), skipped], 360000, 370250, legs).splitTime).toBe(250);
  });

  it("free order: split from the latest punch, no length", () => {
    const leg = finishLegOf([ok(370000), ok(363000), missing], 360000, 370250, legs, "free_order");
    expect(leg).toEqual({ splitTime: 250, legLength: 0 });
  });

  it("no positions: the whole run; no finish: nothing", () => {
    expect(finishLegOf([], 360000, 370000, [500])).toEqual({ splitTime: 10000, legLength: 500 });
    expect(finishLegOf([ok(363000)], 360000, 0, legs)).toEqual({ splitTime: 0, legLength: 0 });
  });

  it("runs across midnight", () => {
    expect(finishLegOf([ok(863900)], 860000, 100, [0, 50]).splitTime).toBe(200);
  });
});
