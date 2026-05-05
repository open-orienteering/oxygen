import { describe, it, expect } from "vitest";
import {
  buildSeries,
  daysBefore,
  daysToGo,
  entriesToday,
  type RawEntry,
} from "../registration-trends.js";

const E1 = "2026-04-01T10:00:00.000Z";
const E2 = "2026-04-05T08:00:00.000Z";
const E3 = "2026-04-05T14:00:00.000Z";
const E4 = "2026-04-12T20:00:00.000Z";

const ENTRIES: RawEntry[] = [
  { at: E1, classId: 1 },
  { at: E2, classId: 1 },
  { at: E3, classId: 2 },
  { at: E4, classId: 2 },
];

const RACE_DATE = "2026-04-12";

describe("buildSeries — cumulative", () => {
  it("returns one point per entry, monotonically increasing", () => {
    const points = buildSeries(ENTRIES, {
      xAxis: "date",
      yAxis: "cumulative",
    });
    expect(points).toHaveLength(4);
    expect(points.map((p) => p.y)).toEqual([1, 2, 3, 4]);
  });

  it("normalises x to days-before-race when requested", () => {
    const points = buildSeries(ENTRIES, {
      xAxis: "daysBefore",
      yAxis: "cumulative",
      eventDate: RACE_DATE,
    });
    // First entry on 2026-04-01 10:00 UTC should be ~11 days before race date
    expect(points[0].x).toBeGreaterThan(10);
    expect(points[0].x).toBeLessThan(12);
    // Last entry on 2026-04-12 20:00 UTC should be slightly before race date (in some TZs negative)
    expect(points[3].x).toBeLessThan(1);
  });

  it("respects the class filter", () => {
    const points = buildSeries(ENTRIES, {
      xAxis: "date",
      yAxis: "cumulative",
      classIds: new Set([1]),
    });
    expect(points).toHaveLength(2);
    expect(points.map((p) => p.y)).toEqual([1, 2]);
  });

  it("sorts unsorted input defensively", () => {
    const shuffled = [ENTRIES[3], ENTRIES[0], ENTRIES[2], ENTRIES[1]];
    const points = buildSeries(shuffled, {
      xAxis: "date",
      yAxis: "cumulative",
    });
    const xs = points.map((p) => p.x);
    expect([...xs].sort((a, b) => a - b)).toEqual(xs);
  });
});

describe("buildSeries — per day", () => {
  it("buckets entries by local calendar day", () => {
    const points = buildSeries(ENTRIES, {
      xAxis: "date",
      yAxis: "perDay",
    });
    // E2 and E3 share a day, the other two are unique
    expect(points).toHaveLength(3);
    const counts = points.map((p) => p.y).sort((a, b) => b - a);
    expect(counts).toEqual([2, 1, 1]);
  });

  it("returns an empty array for no entries", () => {
    expect(
      buildSeries([], { xAxis: "date", yAxis: "perDay" }),
    ).toEqual([]);
  });
});

describe("daysBefore", () => {
  it("returns positive for timestamps before the race date", () => {
    expect(daysBefore(E1, RACE_DATE)).toBeGreaterThan(10);
  });

  it("returns 0 for timestamps at midnight on race day", () => {
    expect(
      Math.abs(daysBefore("2026-04-12T00:00:00", RACE_DATE)),
    ).toBeLessThan(0.01);
  });
});

describe("daysToGo", () => {
  it("counts whole calendar days to a future race date", () => {
    expect(daysToGo("2026-04-12", new Date(2026, 3, 1))).toBe(11);
  });

  it("returns 0 on race day", () => {
    expect(daysToGo("2026-04-12", new Date(2026, 3, 12))).toBe(0);
  });

  it("returns a negative value for past race dates", () => {
    expect(daysToGo("2026-04-12", new Date(2026, 3, 15))).toBe(-3);
  });
});

describe("entriesToday", () => {
  it("counts only entries that share today's local calendar day", () => {
    const today = new Date(2026, 3, 5, 12, 0, 0);
    const same = new Date(2026, 3, 5, 6, 30, 0).toISOString();
    const other = new Date(2026, 3, 4, 23, 30, 0).toISOString();
    const count = entriesToday(
      [
        { at: same, classId: 1 },
        { at: other, classId: 1 },
        { at: same, classId: 2 },
      ],
      today,
    );
    expect(count).toBe(2);
  });

  it("returns 0 when no entries match today", () => {
    expect(
      entriesToday([{ at: E1, classId: 1 }], new Date(2030, 0, 1)),
    ).toBe(0);
  });
});
