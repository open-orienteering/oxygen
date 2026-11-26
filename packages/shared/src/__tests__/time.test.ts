import { describe, expect, it } from "vitest";
import {
  dateInZone,
  isValidTimeZone,
  parseClockTime,
  parseDuration,
  runningTimeDs,
  timeOfDayDs,
} from "../time.js";

describe("timeOfDayDs", () => {
  // 2026-07-01T08:00:00.500Z — summer: Stockholm is UTC+2, Helsinki UTC+3.
  const summer = Date.UTC(2026, 6, 1, 8, 0, 0, 500);
  // 2026-01-15T08:00:00Z — winter: Stockholm UTC+1.
  const winter = Date.UTC(2026, 0, 15, 8, 0, 0);

  it("follows the zone, not the process", () => {
    expect(timeOfDayDs(summer, "UTC")).toBe(8 * 36000 + 5);
    expect(timeOfDayDs(summer, "Europe/Stockholm")).toBe(10 * 36000 + 5);
    expect(timeOfDayDs(summer, "Europe/Helsinki")).toBe(11 * 36000 + 5);
    expect(timeOfDayDs(winter, "Europe/Stockholm")).toBe(9 * 36000);
  });

  it("gives 0 at local midnight", () => {
    expect(timeOfDayDs(Date.UTC(2026, 6, 1, 22, 0, 0), "Europe/Stockholm")).toBe(0);
  });

  it("dateInZone rolls the date at local midnight", () => {
    const t = Date.UTC(2026, 6, 1, 22, 30, 0); // 00:30 on 2 July in Stockholm
    expect(dateInZone(t, "UTC")).toBe(20260701);
    expect(dateInZone(t, "Europe/Stockholm")).toBe(20260702);
  });

  it("validates zone names", () => {
    expect(isValidTimeZone("Europe/Stockholm")).toBe(true);
    expect(isValidTimeZone("Mars/Olympus")).toBe(false);
    expect(isValidTimeZone("")).toBe(false);
  });
});

describe("runningTimeDs", () => {
  it("subtracts normally", () => {
    expect(runningTimeDs(360000, 378000)).toBe(18000);
  });
  it("crosses midnight", () => {
    // 23:30 → 00:20 is 50 minutes.
    expect(runningTimeDs(23.5 * 36000, 20 * 600)).toBe(50 * 600);
  });
  it("is 0 without a start or finish", () => {
    expect(runningTimeDs(0, 378000)).toBe(0);
    expect(runningTimeDs(360000, 0)).toBe(0);
  });
});

describe("parseClockTime", () => {
  it.each([
    ["10:30", 10 * 36000 + 30 * 600],
    ["9:05", 9 * 36000 + 5 * 600],
    ["12:45:30", (12 * 3600 + 45 * 60 + 30) * 10],
    ["12.45.30", (12 * 3600 + 45 * 60 + 30) * 10],
    ["124530", (12 * 3600 + 45 * 60 + 30) * 10],
    ["1030", 10 * 36000 + 30 * 600],
    ["00:00", 0],
    [" 08:15 ", 8 * 36000 + 15 * 600],
  ])("%s", (input, expected) => {
    expect(parseClockTime(input)).toBe(expected);
  });

  it.each(["", "1", "10", "10:4", "10:", "abc", "12.45.3x", "25:00", "10:60", "10:30:61", "1:2:3"])(
    "rejects %j",
    (input) => {
      expect(parseClockTime(input)).toBeNull();
    },
  );
});

describe("parseDuration", () => {
  it("reads a bare number as minutes", () => {
    expect(parseDuration("150", "hm")).toBe(150 * 600);
    expect(parseDuration("2", "ms")).toBe(2 * 600);
  });
  it("reads two parts as H:MM for max time", () => {
    expect(parseDuration("2:30", "hm")).toBe(150 * 600);
  });
  it("reads two parts as M:SS for intervals", () => {
    expect(parseDuration("1:30", "ms")).toBe(900);
  });
  it("reads three parts as H:MM:SS", () => {
    expect(parseDuration("1:15:00", "ms")).toBe(75 * 600);
  });
  it.each(["", "2h", "abc", "1:75", "1:2", "-5"])("rejects %j", (input) => {
    expect(parseDuration(input, "hm")).toBeNull();
  });
});
