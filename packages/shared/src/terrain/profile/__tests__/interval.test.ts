import { describe, it, expect } from "vitest";
import { parseContourInterval, validContourInterval } from "../interval.js";

describe("the contour interval a person may confirm (§0.43)", () => {
  it("accepts above 0 up to 100 with at most two decimals", () => {
    for (const m of [0.01, 2, 2.5, 2.55, 5, 100]) expect(validContourInterval(m), String(m)).toBe(true);
    for (const m of [0, -5, 101, 2.555, Number.NaN, Number.POSITIVE_INFINITY]) expect(validContourInterval(m), String(m)).toBe(false);
  });

  it("reads a typed value, a comma being a decimal point", () => {
    expect(parseContourInterval("2,5")).toBe(2.5);
    expect(parseContourInterval(" 5 ")).toBe(5);
    expect(parseContourInterval("2.55")).toBe(2.55);
    for (const t of ["", "0", "-5", "101", "2.555", "abc", "NaN", "1e2x"]) expect(parseContourInterval(t), t).toBeNull();
    expect(parseContourInterval(Number.NaN)).toBeNull();
  });
});
