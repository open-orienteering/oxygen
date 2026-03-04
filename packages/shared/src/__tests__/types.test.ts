import { describe, it, expect } from "vitest";
import {
  RunnerStatus,
  meosToSeconds,
  secondsToMeos,
  formatMeosTime,
  formatRunningTime,
  parseMeosTime,
  runnerStatusLabel,
  parseMultiCourse,
  encodeMultiCourse,
} from "../types.js";

// ─── meosToSeconds ────────────────────────────────────────────

describe("meosToSeconds", () => {
  it("converts deciseconds to seconds (floor)", () => {
    expect(meosToSeconds(3600)).toBe(360);
    expect(meosToSeconds(10)).toBe(1);
    expect(meosToSeconds(15)).toBe(1); // floor, not round
    expect(meosToSeconds(19)).toBe(1);
  });

  it("returns 0 for 0", () => {
    expect(meosToSeconds(0)).toBe(0);
  });
});

// ─── secondsToMeos ────────────────────────────────────────────

describe("secondsToMeos", () => {
  it("converts seconds to deciseconds", () => {
    expect(secondsToMeos(360)).toBe(3600);
    expect(secondsToMeos(1)).toBe(10);
    expect(secondsToMeos(0)).toBe(0);
  });

  it("round-trips with meosToSeconds", () => {
    // Only exact multiples of 10 deciseconds round-trip perfectly
    expect(meosToSeconds(secondsToMeos(100))).toBe(100);
    expect(secondsToMeos(meosToSeconds(3000))).toBe(3000);
  });
});

// ─── formatMeosTime ───────────────────────────────────────────

describe("formatMeosTime", () => {
  it("returns '-' for 0", () => {
    expect(formatMeosTime(0)).toBe("-");
  });

  it("returns '-' for negative values", () => {
    expect(formatMeosTime(-1)).toBe("-");
    expect(formatMeosTime(-1000)).toBe("-");
  });

  it("formats 09:00:00 correctly (324000 ds)", () => {
    expect(formatMeosTime(324000)).toBe("09:00:00");
  });

  it("formats 10:00:00 correctly (360000 ds)", () => {
    expect(formatMeosTime(360000)).toBe("10:00:00");
  });

  it("formats midnight-relative time with leading zeros", () => {
    // 1 minute and 5 seconds = 65 seconds = 650 ds
    expect(formatMeosTime(650)).toBe("00:01:05");
  });

  it("formats hours > 23 (rare but possible)", () => {
    // 24 hours = 864000 ds
    expect(formatMeosTime(864000)).toBe("24:00:00");
  });

  it("formats seconds component with leading zero", () => {
    // 09:00:09 = 324090 ds
    expect(formatMeosTime(324090)).toBe("09:00:09");
  });
});

// ─── formatRunningTime ────────────────────────────────────────

describe("formatRunningTime", () => {
  it("returns '-' for 0", () => {
    expect(formatRunningTime(0)).toBe("-");
  });

  it("returns '-' for negative values", () => {
    expect(formatRunningTime(-100)).toBe("-");
  });

  it("formats 1:00 (600 ds = 60 seconds)", () => {
    expect(formatRunningTime(600)).toBe("1:00");
  });

  it("formats 6:06 (3661 ds = 366.1s → 6 min 6 sec)", () => {
    // 366 seconds = 6 min 6 sec
    expect(formatRunningTime(3660)).toBe("6:06");
  });

  it("formats seconds with leading zero below 10", () => {
    // 1 min 5 sec = 65 seconds = 650 ds
    expect(formatRunningTime(650)).toBe("1:05");
  });

  it("formats with hours when >= 3600 seconds (36000 ds)", () => {
    // 1:00:00 = 3600 seconds = 36000 ds
    expect(formatRunningTime(36000)).toBe("1:00:00");
  });

  it("formats 1:01:01 correctly", () => {
    // 3661 seconds = 36610 ds
    expect(formatRunningTime(36610)).toBe("1:01:01");
  });

  it("no leading zero on minutes when < 1 hour", () => {
    // 9 min = 540 seconds = 5400 ds
    expect(formatRunningTime(5400)).toBe("9:00");
  });
});

// ─── parseMeosTime ────────────────────────────────────────────

describe("parseMeosTime", () => {
  it("parses HH:MM:SS to deciseconds", () => {
    expect(parseMeosTime("09:00:00")).toBe(324000);
    expect(parseMeosTime("10:00:00")).toBe(360000);
  });

  it("parses MM:SS (two-part) format", () => {
    expect(parseMeosTime("1:30")).toBe(900); // 90 seconds = 900 ds
    expect(parseMeosTime("6:06")).toBe(3660);
  });

  it("round-trips with formatMeosTime", () => {
    const original = 324000; // 09:00:00
    expect(parseMeosTime(formatMeosTime(original))).toBe(original);
  });

  it("returns 0 for empty string", () => {
    expect(parseMeosTime("")).toBe(0);
  });
});

// ─── runnerStatusLabel ────────────────────────────────────────

describe("runnerStatusLabel", () => {
  it("returns correct label for each known status", () => {
    expect(runnerStatusLabel(RunnerStatus.OK)).toBe("OK");
    expect(runnerStatusLabel(RunnerStatus.DNS)).toBe("DNS");
    expect(runnerStatusLabel(RunnerStatus.DNF)).toBe("DNF");
    expect(runnerStatusLabel(RunnerStatus.MissingPunch)).toBe("MP");
    expect(runnerStatusLabel(RunnerStatus.DQ)).toBe("DQ");
    expect(runnerStatusLabel(RunnerStatus.OverMaxTime)).toBe("Over max time");
    expect(runnerStatusLabel(RunnerStatus.Cancel)).toBe("Cancelled");
    expect(runnerStatusLabel(RunnerStatus.NoTiming)).toBe("No timing");
    expect(runnerStatusLabel(RunnerStatus.OutOfCompetition)).toBe(
      "Out of competition",
    );
    expect(runnerStatusLabel(RunnerStatus.NotCompeting)).toBe("Not competing");
    expect(runnerStatusLabel(RunnerStatus.Unknown)).toBe("Unknown");
  });

  it("returns a non-empty string for all defined RunnerStatus values", () => {
    const values = Object.values(RunnerStatus) as number[];
    for (const v of values) {
      const label = runnerStatusLabel(v as Parameters<typeof runnerStatusLabel>[0]);
      expect(label.length).toBeGreaterThan(0);
    }
  });
});

// ─── parseMultiCourse ─────────────────────────────────────────

describe("parseMultiCourse", () => {
  it("returns [] for null", () => {
    expect(parseMultiCourse(null)).toEqual([]);
  });

  it("returns [] for undefined", () => {
    expect(parseMultiCourse(undefined)).toEqual([]);
  });

  it("returns [] for empty string", () => {
    expect(parseMultiCourse("")).toEqual([]);
  });

  it("returns [] for '@' (MeOS empty sentinel)", () => {
    expect(parseMultiCourse("@")).toEqual([]);
  });

  it("parses single stage: '101 102;' → [[101, 102]]", () => {
    expect(parseMultiCourse("101 102;")).toEqual([[101, 102]]);
  });

  it("parses two stages: '101 102; 103 104;' → [[101, 102], [103, 104]]", () => {
    expect(parseMultiCourse("101 102; 103 104;")).toEqual([
      [101, 102],
      [103, 104],
    ]);
  });

  it("handles extra whitespace", () => {
    expect(parseMultiCourse("  101  102  ;")).toEqual([[101, 102]]);
  });

  it("filters out 0 and NaN values", () => {
    expect(parseMultiCourse("101 0 102;")).toEqual([[101, 102]]);
  });
});

// ─── encodeMultiCourse ────────────────────────────────────────

describe("encodeMultiCourse", () => {
  it("returns '' for empty array", () => {
    expect(encodeMultiCourse([])).toBe("");
  });

  it("returns '' for single courseId (no forking needed)", () => {
    expect(encodeMultiCourse([101])).toBe("");
  });

  it("encodes two courseIds", () => {
    expect(encodeMultiCourse([101, 102])).toBe("101 102;");
  });

  it("encodes three courseIds", () => {
    expect(encodeMultiCourse([101, 102, 103])).toBe("101 102 103;");
  });

  it("round-trips through parseMultiCourse (single stage)", () => {
    const original = [101, 102, 103];
    const encoded = encodeMultiCourse(original);
    const decoded = parseMultiCourse(encoded);
    expect(decoded).toEqual([original]);
  });
});
