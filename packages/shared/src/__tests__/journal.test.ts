import { describe, it, expect } from "vitest";
import {
  type Stamp,
  resolveHlc,
  entryStamp,
  compareStamps,
  compareEntries,
  earliestWins,
  latestWins,
  punchDedupeKey,
  cardReadIsDuplicate,
  CARD_READ_DEDUPE_WINDOW_MS,
} from "../journal.js";

const base = { competitionId: "c", payload: {} as never };

describe("resolveHlc", () => {
  it("returns the stamped HLC when present", () => {
    expect(resolveHlc({ id: "x", stationId: "a", timestamp: 50, hlc: { physical: 99, logical: 3 } })).toEqual({
      physical: 99,
      logical: 3,
    });
  });

  it("synthesises HLC from the wall clock for legacy entries", () => {
    expect(resolveHlc({ id: "x", stationId: "a", timestamp: 1234 })).toEqual({ physical: 1234, logical: 0 });
  });
});

describe("compareStamps / compareEntries", () => {
  it("breaks HLC ties on stationId then id", () => {
    const hlc = { physical: 100, logical: 0 };
    const a: Stamp = { hlc, stationId: "A", id: "z" };
    const b: Stamp = { hlc, stationId: "B", id: "a" };
    expect(compareStamps(a, b)).toBe(-1); // A < B by station
    const c: Stamp = { hlc, stationId: "A", id: "y" };
    expect(compareStamps(a, c)).toBe(1); // same station, z > y by id
    expect(compareStamps(a, a)).toBe(0);
  });

  it("compareEntries synthesises HLC for legacy entries before comparing", () => {
    const older = { ...base, id: "1", type: "finish.recorded" as const, stationId: "A", timestamp: 100 };
    const newer = { ...base, id: "2", type: "finish.recorded" as const, stationId: "A", timestamp: 200 };
    expect(compareEntries(older, newer)).toBe(-1);
  });
});

describe("earliestWins / latestWins", () => {
  const lo: Stamp = { hlc: { physical: 10, logical: 0 }, stationId: "A", id: "a" };
  const hi: Stamp = { hlc: { physical: 20, logical: 0 }, stationId: "A", id: "a" };

  it("earliestWins replaces only with a strictly earlier stamp", () => {
    expect(earliestWins(null, hi)).toBe(true); // first writer
    expect(earliestWins(hi, lo)).toBe(true); // lo is earlier → wins
    expect(earliestWins(lo, hi)).toBe(false); // hi is later → loses
    expect(earliestWins(lo, lo)).toBe(false); // tie → no change
  });

  it("latestWins replaces only with a strictly later stamp", () => {
    expect(latestWins(null, lo)).toBe(true);
    expect(latestWins(lo, hi)).toBe(true);
    expect(latestWins(hi, lo)).toBe(false);
    expect(latestWins(hi, hi)).toBe(false);
  });
});

describe("dedupe helpers", () => {
  it("punchDedupeKey keys on cardNo, controlCode, time", () => {
    expect(punchDedupeKey({ cardNo: 5, controlCode: 31, time: 1000 })).toBe("5:31:1000");
  });

  it("cardReadIsDuplicate matches the same card within the window", () => {
    const existing = [{ cardNo: 100, timestamp: 1_000_000 }];
    expect(cardReadIsDuplicate(existing, 100, 1_000_000 + CARD_READ_DEDUPE_WINDOW_MS)).toBe(true);
    expect(cardReadIsDuplicate(existing, 100, 1_000_000 + CARD_READ_DEDUPE_WINDOW_MS + 1)).toBe(false);
    expect(cardReadIsDuplicate(existing, 101, 1_000_000)).toBe(false);
  });
});

describe("entryStamp", () => {
  it("derives a full stamp from an entry", () => {
    expect(entryStamp({ id: "e1", stationId: "S", timestamp: 7, hlc: { physical: 7, logical: 2 } })).toEqual({
      hlc: { physical: 7, logical: 2 },
      stationId: "S",
      id: "e1",
    });
  });
});
