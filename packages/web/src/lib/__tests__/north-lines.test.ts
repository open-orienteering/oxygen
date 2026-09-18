import { describe, expect, it } from "vitest";
import {
  formatStalenessDeg,
  isMeridianStale,
  northLinesState,
} from "../north-lines";

describe("north-lines", () => {
  it("flags |staleness| ≥ 1° and nothing below", () => {
    expect(isMeridianStale(1.7)).toBe(true);
    expect(isMeridianStale(-1.0)).toBe(true);
    expect(isMeridianStale(0.9)).toBe(false);
    expect(isMeridianStale(0)).toBe(false);
    expect(isMeridianStale(null)).toBe(false);
    expect(isMeridianStale(undefined)).toBe(false);
    expect(isMeridianStale(Number.NaN)).toBe(false);
  });

  it("formats the magnitude with one decimal", () => {
    expect(formatStalenessDeg(1.7)).toBe("1.7");
    expect(formatStalenessDeg(-0.25)).toBe("0.3");
  });

  it("maps to a UI state", () => {
    expect(northLinesState(null)).toEqual({ kind: "none" });
    expect(northLinesState(0.4)).toEqual({ kind: "current", degrees: "0.4" });
    expect(northLinesState(-2.3)).toEqual({ kind: "stale", degrees: "2.3" });
  });
});
