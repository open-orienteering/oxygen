import { describe, it, expect } from "vitest";
import {
  compareByControlNumber,
  sortByControlNumber,
} from "../control-order";

describe("compareByControlNumber", () => {
  it("orders numerically, not lexicographically", () => {
    expect(compareByControlNumber({ id: 50 }, { id: 100 })).toBeLessThan(0);
    expect(compareByControlNumber({ id: 100 }, { id: 50 })).toBeGreaterThan(0);
    expect(compareByControlNumber({ id: 50 }, { id: 50 })).toBe(0);
  });
});

describe("sortByControlNumber", () => {
  it("sorts import order into control-number order", () => {
    const controls = [
      { id: 100, name: "Finish" },
      { id: 50, name: "Radio 1" },
      { id: 9, name: "Start" },
      { id: 250, name: "Spare" },
    ];
    expect(sortByControlNumber(controls).map((c) => c.id)).toEqual([
      9, 50, 100, 250,
    ]);
  });

  it("leaves the input array untouched", () => {
    const controls = [{ id: 100 }, { id: 50 }];
    sortByControlNumber(controls);
    expect(controls.map((c) => c.id)).toEqual([100, 50]);
  });

  it("handles empty and single-element lists", () => {
    expect(sortByControlNumber([])).toEqual([]);
    expect(sortByControlNumber([{ id: 31 }])).toEqual([{ id: 31 }]);
  });
});
