/**
 * Course-import helpers — the pure-logic pieces that don't need a DB.
 *
 * After the PG migration the legacy `getControlSuffix`, `meosStartId`,
 * `meosStartName`, `parseCourseControlIds` etc. are gone (the per-event
 * `controls` table replaces the MeOS pseudo-id encoding). The class
 * matcher and the shared `ExpectedPosition` normaliser survive and are
 * pinned here so the import-preview UI stays correct as the matcher
 * evolves.
 */

import { describe, it, expect } from "vitest";
import {
  normalizeClassName,
  findBestClassMatch,
} from "../routers/course.js";
import { normalizeExpectedCodes } from "@oxygen/shared";

describe("normalizeClassName", () => {
  it("lowercases", () => {
    expect(normalizeClassName("H21")).toBe("h21");
  });

  it("strips whitespace", () => {
    expect(normalizeClassName("H 21")).toBe("h21");
    expect(normalizeClassName("  H\t21 ")).toBe("h21");
  });

  it("strips common punctuation (.,;:_-/\\)", () => {
    expect(normalizeClassName("H.21")).toBe("h21");
    expect(normalizeClassName("H,21")).toBe("h21");
    expect(normalizeClassName("D-21")).toBe("d21");
    expect(normalizeClassName("H_21")).toBe("h21");
    expect(normalizeClassName("H/21")).toBe("h21");
    expect(normalizeClassName("H21,Elit")).toBe("h21elit");
  });

  it("collapses consecutive separators", () => {
    expect(normalizeClassName("H  - 21")).toBe("h21");
  });

  it("returns empty string when only separators", () => {
    expect(normalizeClassName("  -.,  ")).toBe("");
  });

  it("preserves Swedish characters", () => {
    expect(normalizeClassName("Öppen 5")).toBe("öppen5");
  });
});

describe("findBestClassMatch", () => {
  // The new matcher takes UUID-shaped {id, name, seq} — `seq` is the
  // per-event integer the UI surfaces.
  const dbClasses = [
    { id: "01", name: "H21", seq: 1 },
    { id: "02", name: "D21", seq: 2 },
    { id: "03", name: "H21 Elit", seq: 3 },
    { id: "04", name: "Öppen 5", seq: 4 },
  ];

  it("returns null when DB list is empty", () => {
    expect(findBestClassMatch("H21", [])).toBeNull();
  });

  it("returns null when no match is possible", () => {
    expect(findBestClassMatch("H35", dbClasses)).toBeNull();
  });

  it("matches identical names as an exact match", () => {
    expect(findBestClassMatch("H21", dbClasses)).toEqual({
      id: "01",
      seq: 1,
      name: "H21",
      matchType: "exact",
    });
  });

  it("matches case-insensitively as exact", () => {
    expect(findBestClassMatch("h21", dbClasses)).toMatchObject({
      seq: 1,
      matchType: "exact",
    });
    expect(findBestClassMatch("D21", dbClasses)).toMatchObject({
      seq: 2,
      matchType: "exact",
    });
  });

  it("matches across whitespace differences as a normalized match", () => {
    expect(findBestClassMatch("H 21", dbClasses)).toMatchObject({
      seq: 1,
      matchType: "normalized",
    });
  });

  it("matches across punctuation differences as a normalized match", () => {
    expect(findBestClassMatch("H.21", dbClasses)).toMatchObject({
      seq: 1,
      matchType: "normalized",
    });
    expect(findBestClassMatch("D-21", dbClasses)).toMatchObject({
      seq: 2,
      matchType: "normalized",
    });
  });

  it("prefers a normalized exact match over a substring match", () => {
    // "H 21" must match "H21" (seq=1), NOT the longer "H21 Elit" (seq=3).
    expect(findBestClassMatch("H 21", dbClasses)).toMatchObject({
      seq: 1,
      matchType: "normalized",
    });
  });

  it("falls back to substring match when no exact / normalized match exists", () => {
    const result = findBestClassMatch("H21 Elit Lång", dbClasses);
    expect(result).toMatchObject({ seq: 3, matchType: "substring" });
  });

  it("substring fallback works in either direction", () => {
    const result = findBestClassMatch("Elit", dbClasses);
    expect(result).toMatchObject({ seq: 3, matchType: "substring" });
  });

  it("normalizes both sides during substring matching", () => {
    expect(findBestClassMatch("Öppen-5", dbClasses)).toMatchObject({
      seq: 4,
      matchType: "normalized",
    });
  });

  it("returns null when XML name normalizes to empty", () => {
    expect(findBestClassMatch("   ", dbClasses)).toBeNull();
  });
});

describe("normalizeExpectedCodes", () => {
  it("lifts a flat number[] into ExpectedPosition[] (one required code per position)", () => {
    expect(normalizeExpectedCodes([31, 32, 33])).toEqual([
      { codes: [31], skipMatching: false, noTimingLeg: false },
      { codes: [32], skipMatching: false, noTimingLeg: false },
      { codes: [33], skipMatching: false, noTimingLeg: false },
    ]);
  });

  it("lifts a number[][] into ExpectedPosition[] preserving multi-code sets", () => {
    expect(normalizeExpectedCodes([[31], [131, 231], [33]])).toEqual([
      { codes: [31], skipMatching: false, noTimingLeg: false },
      { codes: [131, 231], skipMatching: false, noTimingLeg: false },
      { codes: [33], skipMatching: false, noTimingLeg: false },
    ]);
  });

  it("passes ExpectedPosition[] through untouched", () => {
    const input = [
      { codes: [31], skipMatching: false, noTimingLeg: false },
      { codes: [32], skipMatching: true, noTimingLeg: false },
      { codes: [33], skipMatching: false, noTimingLeg: true },
    ];
    expect(normalizeExpectedCodes(input)).toEqual(input);
  });

  it("returns an empty array for an empty input", () => {
    expect(normalizeExpectedCodes([])).toEqual([]);
  });
});
