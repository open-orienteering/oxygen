import { describe, it, expect } from "vitest";
import {
  CLOCK_SKEW_THRESHOLD_MS,
  recordClockSkew,
  getClockSkewMs,
  subscribeClockSkew,
} from "../offline/clock-skew";

describe("clock-skew store", () => {
  it("uses a 30s threshold", () => {
    expect(CLOCK_SKEW_THRESHOLD_MS).toBe(30_000);
  });

  it("computes skew as local - server", () => {
    recordClockSkew(1_000_000, 1_045_000);
    expect(getClockSkewMs()).toBe(45_000);
    recordClockSkew(1_000_000, 1_000_000 - 12_000);
    expect(getClockSkewMs()).toBe(-12_000);
  });

  it("notifies subscribers only when the skew value changes", () => {
    recordClockSkew(0, 1000); // baseline before subscribing
    let calls = 0;
    const unsub = subscribeClockSkew(() => {
      calls++;
    });
    recordClockSkew(0, 2000); // change → notify
    recordClockSkew(0, 2000); // unchanged → no notify
    recordClockSkew(0, 3000); // change → notify
    unsub();
    recordClockSkew(0, 9000); // after unsub → no notify
    expect(calls).toBe(2);
  });
});
