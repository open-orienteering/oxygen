import { describe, it, expect } from "vitest";
import { normalizeBirthYear } from "../routers/runner.js";

describe("normalizeBirthYear", () => {
  it("returns YYYY as-is for 4-digit year", () => {
    expect(normalizeBirthYear(1990)).toBe(1990);
  });

  it("returns YYYY as-is for year 2000", () => {
    expect(normalizeBirthYear(2000)).toBe(2000);
  });

  it("extracts YYYY from YYYYMMDD format", () => {
    expect(normalizeBirthYear(19900515)).toBe(1990);
  });

  it("extracts YYYY from 20001231", () => {
    expect(normalizeBirthYear(20001231)).toBe(2000);
  });

  it("returns 0 for 0", () => {
    expect(normalizeBirthYear(0)).toBe(0);
  });

  it("returns 9999 for boundary value", () => {
    expect(normalizeBirthYear(9999)).toBe(9999);
  });

  it("extracts year from boundary YYYYMMDD (10000)", () => {
    // 10000 = year 1, month 00, day 00 (edge case)
    expect(normalizeBirthYear(10000)).toBe(1);
  });

  it("handles large YYYYMMDD value", () => {
    expect(normalizeBirthYear(20260325)).toBe(2026);
  });
});
