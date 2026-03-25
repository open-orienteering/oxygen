import { describe, it, expect } from "vitest";
import { toRelative, toAbsolute } from "../timeConvert.js";

const ZT = 324000; // 09:00:00 in deciseconds (default ZeroTime)

describe("toRelative", () => {
  it("subtracts ZeroTime from absolute time", () => {
    // 10:00:00 absolute = 360000 ds → relative to 09:00 = 36000 ds (1 hour)
    expect(toRelative(360000, ZT)).toBe(36000);
  });

  it("preserves sentinel 0 (no time set)", () => {
    expect(toRelative(0, ZT)).toBe(0);
  });

  it("preserves negative-or-zero sentinel", () => {
    expect(toRelative(-1, ZT)).toBe(0);
  });

  it("produces negative for times before ZeroTime", () => {
    // 08:50:00 = 318000 ds → relative = 318000 - 324000 = -6000
    expect(toRelative(318000, ZT)).toBe(-6000);
  });

  it("works with ZeroTime = 0 (identity)", () => {
    expect(toRelative(360000, 0)).toBe(360000);
  });
});

describe("toAbsolute", () => {
  it("adds ZeroTime to relative time", () => {
    // 36000 relative + 324000 ZT = 360000 = 10:00:00
    expect(toAbsolute(36000, ZT)).toBe(360000);
  });

  it("preserves sentinel 0", () => {
    expect(toAbsolute(0, ZT)).toBe(0);
  });

  it("handles negative relative times (before ZeroTime)", () => {
    // -6000 + 324000 = 318000 = 08:50:00
    expect(toAbsolute(-6000, ZT)).toBe(318000);
  });

  it("handles midnight wraparound (event crossing midnight)", () => {
    // ZeroTime = 23:00 (828000), relative = 72000 (2 hours after ZT)
    // Absolute = 828000 + 72000 = 900000 → mod 864000 = 36000 (01:00:00)
    expect(toAbsolute(72000, 828000)).toBe(36000);
  });

  it("works with ZeroTime = 0 (identity)", () => {
    expect(toAbsolute(360000, 0)).toBe(360000);
  });
});

describe("round-trip", () => {
  it("toAbsolute(toRelative(x)) === x for normal times", () => {
    const abs = 360000; // 10:00:00
    expect(toAbsolute(toRelative(abs, ZT), ZT)).toBe(abs);
  });

  it("round-trips times before ZeroTime", () => {
    const abs = 318000; // 08:50:00
    expect(toAbsolute(toRelative(abs, ZT), ZT)).toBe(abs);
  });

  it("round-trips midnight-crossing events", () => {
    const zt = 828000; // 23:00
    const abs = 36000; // 01:00 next day
    // toRelative: 36000 - 828000 = -792000
    // toAbsolute: (-792000 + 828000) % 864000 = 36000
    expect(toAbsolute(toRelative(abs, zt), zt)).toBe(abs);
  });

  it("preserves sentinel 0 through round-trip", () => {
    expect(toAbsolute(toRelative(0, ZT), ZT)).toBe(0);
  });
});
