import { describe, it, expect } from "vitest";
import {
  toRelative,
  toAbsolute,
  nowMeosDate,
  nowMeosTime,
  meosEntryToDate,
} from "../timeConvert.js";

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

describe("nowMeosDate", () => {
  it("packs a date as YYYYMMDD", () => {
    expect(nowMeosDate(new Date(2026, 4, 12))).toBe(20260512);
  });

  it("zero-pads single-digit month and day", () => {
    expect(nowMeosDate(new Date(2026, 0, 3))).toBe(20260103);
  });

  it("uses local time, not UTC", () => {
    // Construct via local-time constructor: midnight on 2026-12-31 local
    expect(nowMeosDate(new Date(2026, 11, 31, 0, 0, 0))).toBe(20261231);
  });
});

describe("nowMeosTime", () => {
  it("packs HH:MM:SS as deciseconds", () => {
    // 10:00:00 = 36000s = 360000 ds
    expect(nowMeosTime(new Date(2026, 4, 12, 10, 0, 0))).toBe(360000);
  });

  it("handles midnight (zero)", () => {
    expect(nowMeosTime(new Date(2026, 4, 12, 0, 0, 0))).toBe(0);
  });

  it("packs the last second of the day", () => {
    // 23:59:59 = 86399s = 863990 ds
    expect(nowMeosTime(new Date(2026, 4, 12, 23, 59, 59))).toBe(863990);
  });
});

describe("meosEntryToDate", () => {
  it("returns null for sentinel 0 entry date", () => {
    expect(meosEntryToDate(0, 0)).toBeNull();
    expect(meosEntryToDate(0, 360000)).toBeNull();
  });

  it("decodes a date and time-of-day to a local Date", () => {
    const d = meosEntryToDate(20260512, 360000);
    expect(d).not.toBeNull();
    expect(d!.getFullYear()).toBe(2026);
    expect(d!.getMonth()).toBe(4);
    expect(d!.getDate()).toBe(12);
    expect(d!.getHours()).toBe(10);
    expect(d!.getMinutes()).toBe(0);
    expect(d!.getSeconds()).toBe(0);
  });

  it("round-trips through nowMeosDate / nowMeosTime", () => {
    const original = new Date(2026, 5, 15, 14, 27, 33);
    const date = nowMeosDate(original);
    const time = nowMeosTime(original);
    const decoded = meosEntryToDate(date, time);
    expect(decoded).not.toBeNull();
    expect(decoded!.getTime()).toBe(original.getTime());
  });

  it("rejects malformed YYYYMMDD ints", () => {
    expect(meosEntryToDate(20260000, 0)).toBeNull(); // month 00
    expect(meosEntryToDate(20261301, 0)).toBeNull(); // month 13
    expect(meosEntryToDate(18991231, 0)).toBeNull(); // year < 1900
  });
});
