import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  formatDateTime,
  formatDate,
  timeAgo,
  formatEntryDate,
} from "../format.js";

afterEach(() => {
  vi.useRealTimers();
});

// ─── formatDateTime ───────────────────────────────────────────

describe("formatDateTime", () => {
  it("formats a Date object to YYYY-MM-DD HH:mm:ss", () => {
    const d = new Date(2026, 2, 15, 10, 5, 30); // March 15, 2026 10:05:30
    expect(formatDateTime(d)).toBe("2026-03-15 10:05:30");
  });

  it("formats an ISO string", () => {
    expect(formatDateTime("2026-03-15T10:05:30")).toMatch(
      /^2026-03-15 \d{2}:05:30$/,
    );
  });

  it("formats a numeric timestamp", () => {
    const d = new Date(2026, 2, 15, 10, 5, 30);
    const result = formatDateTime(d.getTime());
    expect(result).toBe(formatDateTime(d));
  });

  it("pads month, day, hour, minute, second with leading zeros", () => {
    const d = new Date(2026, 0, 5, 9, 3, 7); // Jan 5, 2026 09:03:07
    expect(formatDateTime(d)).toBe("2026-01-05 09:03:07");
  });

  it("returns String(input) for an invalid input", () => {
    const result = formatDateTime("not-a-date");
    // NaN date → returns String("not-a-date")
    expect(result).toBe("not-a-date");
  });
});

// ─── formatDate ───────────────────────────────────────────────

describe("formatDate", () => {
  it("formats a Date object to YYYY-MM-DD", () => {
    const d = new Date(2026, 2, 15); // March 15, 2026
    expect(formatDate(d)).toBe("2026-03-15");
  });

  it("pads single-digit month and day", () => {
    const d = new Date(2026, 0, 5); // Jan 5, 2026
    expect(formatDate(d)).toBe("2026-01-05");
  });

  it("formats an ISO string", () => {
    expect(formatDate("2026-12-01")).toBe("2026-12-01");
  });

  it("returns String(input) for invalid input", () => {
    expect(formatDate("invalid")).toBe("invalid");
  });
});

// ─── timeAgo ─────────────────────────────────────────────────

describe("timeAgo", () => {
  const NOW = new Date(2026, 2, 15, 12, 0, 0).getTime(); // fixed reference point

  function ago(ms: number): Date {
    return new Date(NOW - ms);
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  it("returns 'just now' for a future date", () => {
    expect(timeAgo(new Date(NOW + 5000))).toBe("just now");
  });

  it("returns 'just now' for 0 seconds ago", () => {
    expect(timeAgo(new Date(NOW))).toBe("just now");
  });

  it("returns 'just now' for 59 seconds ago", () => {
    expect(timeAgo(ago(59 * 1000))).toBe("just now");
  });

  it("returns '1 min ago' for 60 seconds ago", () => {
    expect(timeAgo(ago(60 * 1000))).toBe("1 min ago");
  });

  it("returns '5 min ago' for 5 minutes ago", () => {
    expect(timeAgo(ago(5 * 60 * 1000))).toBe("5 min ago");
  });

  it("returns '59 min ago' for 59 minutes ago", () => {
    expect(timeAgo(ago(59 * 60 * 1000))).toBe("59 min ago");
  });

  it("returns '1 hour ago' for 60 minutes ago", () => {
    expect(timeAgo(ago(60 * 60 * 1000))).toBe("1 hour ago");
  });

  it("returns '5 hours ago' for 5 hours ago", () => {
    expect(timeAgo(ago(5 * 60 * 60 * 1000))).toBe("5 hours ago");
  });

  it("returns '23 hours ago' for 23 hours ago", () => {
    expect(timeAgo(ago(23 * 60 * 60 * 1000))).toBe("23 hours ago");
  });

  it("returns '1 day ago' for 24 hours ago", () => {
    expect(timeAgo(ago(24 * 60 * 60 * 1000))).toBe("1 day ago");
  });

  it("returns '5 days ago' for 5 days ago", () => {
    expect(timeAgo(ago(5 * 24 * 60 * 60 * 1000))).toBe("5 days ago");
  });

  it("returns '29 days ago' for 29 days ago", () => {
    expect(timeAgo(ago(29 * 24 * 60 * 60 * 1000))).toBe("29 days ago");
  });

  it("returns '1 month ago' for 30 days ago", () => {
    expect(timeAgo(ago(30 * 24 * 60 * 60 * 1000))).toBe("1 month ago");
  });

  it("returns '6 months ago' for ~180 days ago", () => {
    expect(timeAgo(ago(180 * 24 * 60 * 60 * 1000))).toBe("6 months ago");
  });

  it("returns '11 months ago' for ~330 days ago", () => {
    expect(timeAgo(ago(330 * 24 * 60 * 60 * 1000))).toBe("11 months ago");
  });

  it("returns '1 year ago' for 365 days ago", () => {
    expect(timeAgo(ago(365 * 24 * 60 * 60 * 1000))).toBe("1 year ago");
  });

  it("returns '2 years ago' for 730 days ago", () => {
    expect(timeAgo(ago(730 * 24 * 60 * 60 * 1000))).toBe("2 years ago");
  });

  it("returns '' for an invalid date", () => {
    expect(timeAgo("not-a-date")).toBe("");
  });

  it("accepts ISO string input", () => {
    const isoString = new Date(NOW - 5 * 60 * 1000).toISOString();
    expect(timeAgo(isoString)).toBe("5 min ago");
  });

  it("accepts numeric timestamp input", () => {
    expect(timeAgo(NOW - 60 * 1000)).toBe("1 min ago");
  });
});

// ─── formatEntryDate ─────────────────────────────────────────

describe("formatEntryDate", () => {
  it("formats a valid YYYYMMDD integer", () => {
    expect(formatEntryDate(20260315)).toBe("2026-03-15");
  });

  it("formats another valid date", () => {
    expect(formatEntryDate(20261231)).toBe("2026-12-31");
  });

  it("returns '' for 0", () => {
    expect(formatEntryDate(0)).toBe("");
  });

  it("returns '' for values below 19000101 (invalid year)", () => {
    expect(formatEntryDate(18991231)).toBe("");
    expect(formatEntryDate(1)).toBe("");
  });

  it("returns '' for NaN-like falsy values", () => {
    // TypeScript would prevent this normally, but test the runtime guard
    expect(formatEntryDate(0)).toBe("");
  });

  it("formats a date with single-digit month and day", () => {
    expect(formatEntryDate(20260105)).toBe("2026-01-05");
  });
});
