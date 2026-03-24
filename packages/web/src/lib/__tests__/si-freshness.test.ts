import { describe, it, expect, vi, afterEach } from "vitest";
import { isPunchDataFresh } from "../../context/DeviceManager";
import type { SICardReadout } from "../si-protocol";

function makeReadout(overrides: Partial<SICardReadout> = {}): SICardReadout {
  return {
    cardNumber: 2220164,
    cardType: "SI8",
    checkTime: null,
    startTime: null,
    finishTime: null,
    clearTime: null,
    punches: [],
    punchCount: 0,
    ...overrides,
  };
}

describe("isPunchDataFresh", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns false when card has no punches", () => {
    const readout = makeReadout({ punches: [] });
    expect(isPunchDataFresh(readout)).toBe(false);
  });

  it("returns true when finish DOW matches today", () => {
    // Fake "Wednesday" (JS getDay() = 3, SI DOW = 3)
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-11T10:00:00")); // Wednesday
    const readout = makeReadout({
      punches: [{ controlCode: 31, time: 36000 }],
      finishTime: 37800,
      finishDayOfWeek: 3, // Wednesday
    });
    expect(isPunchDataFresh(readout)).toBe(true);
  });

  it("returns false when finish DOW differs from today", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-11T10:00:00")); // Wednesday (DOW=3)
    const readout = makeReadout({
      punches: [{ controlCode: 31, time: 36000 }],
      finishTime: 37800,
      finishDayOfWeek: 5, // Friday — stale
    });
    expect(isPunchDataFresh(readout)).toBe(false);
  });

  it("falls back to check DOW when no finish DOW", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-11T10:00:00")); // Wednesday (DOW=3)
    const readout = makeReadout({
      punches: [{ controlCode: 31, time: 36000 }],
      checkTime: 35000,
      checkDayOfWeek: 5, // Friday — stale
      finishDayOfWeek: null,
    });
    expect(isPunchDataFresh(readout)).toBe(false);
  });

  it("returns true when no DOW info is available (conservative)", () => {
    const readout = makeReadout({
      punches: [{ controlCode: 31, time: 36000 }],
      finishDayOfWeek: null,
      checkDayOfWeek: null,
    });
    expect(isPunchDataFresh(readout)).toBe(true);
  });

  it("handles Sunday correctly (JS=0 → SI=7)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-15T10:00:00")); // Sunday
    const readout = makeReadout({
      punches: [{ controlCode: 31, time: 36000 }],
      finishTime: 37800,
      finishDayOfWeek: 7, // Sunday in SI format
    });
    expect(isPunchDataFresh(readout)).toBe(true);
  });

  it("accepts Sunday finish data on Monday (yesterday = night-O window)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-16T10:00:00")); // Monday (DOW=1)
    const readout = makeReadout({
      punches: [{ controlCode: 31, time: 36000 }],
      finishTime: 37800,
      finishDayOfWeek: 7, // Sunday — yesterday, accepted for night-O
    });
    expect(isPunchDataFresh(readout)).toBe(true);
  });

  it("rejects finish data from 2 days ago", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-16T10:00:00")); // Monday (DOW=1)
    const readout = makeReadout({
      punches: [{ controlCode: 31, time: 36000 }],
      finishTime: 37800,
      finishDayOfWeek: 6, // Saturday — 2 days ago
    });
    expect(isPunchDataFresh(readout)).toBe(false);
  });

  it("ignores check DOW when finish DOW is available and matches", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-11T10:00:00")); // Wednesday (DOW=3)
    const readout = makeReadout({
      punches: [{ controlCode: 31, time: 36000 }],
      finishTime: 37800,
      finishDayOfWeek: 3, // today
      checkDayOfWeek: 5, // old check from Friday — should be ignored
    });
    expect(isPunchDataFresh(readout)).toBe(true);
  });

  // ── Night-O tests ────────────────────────────────────────────

  it("accepts yesterday finish for night-O (Saturday finish → Sunday check)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-15T08:00:00")); // Sunday (DOW=7)
    const readout = makeReadout({
      punches: [{ controlCode: 31, time: 36000 }],
      finishTime: 3600, // 01:00 Sunday morning
      finishDayOfWeek: 6, // Saturday — but yesterday is OK
    });
    expect(isPunchDataFresh(readout)).toBe(true);
  });

  it("accepts yesterday check DOW for night-O DNF (no finish punch)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-15T08:00:00")); // Sunday (DOW=7)
    const readout = makeReadout({
      punches: [{ controlCode: 31, time: 36000 }],
      checkTime: 80000, // Saturday 22:13
      checkDayOfWeek: 6, // Saturday
      finishDayOfWeek: null, // DNF — no finish
    });
    expect(isPunchDataFresh(readout)).toBe(true);
  });

  it("wraps Monday yesterday to Sunday (DOW 1 → 7)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-16T08:00:00")); // Monday (DOW=1)
    const readout = makeReadout({
      punches: [{ controlCode: 31, time: 36000 }],
      finishTime: 3600,
      finishDayOfWeek: 7, // Sunday — yesterday for Monday
    });
    expect(isPunchDataFresh(readout)).toBe(true);
  });
});
