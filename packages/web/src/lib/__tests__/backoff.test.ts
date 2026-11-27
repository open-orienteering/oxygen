import { describe, expect, it } from "vitest";
import { retryDelayMs } from "../backoff";

describe("retryDelayMs", () => {
  it("doubles from 2 s and caps at 30 s", () => {
    expect([0, 1, 2, 3, 4, 5, 50].map(retryDelayMs)).toEqual([2000, 4000, 8000, 16000, 30000, 30000, 30000]);
  });
  it("treats a negative or fractional attempt as its floor, from 0", () => {
    expect(retryDelayMs(-3)).toBe(2000);
    expect(retryDelayMs(1.7)).toBe(4000);
  });
});
