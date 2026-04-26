import { describe, it, expect } from "vitest";
import {
  getControlSuffix,
  meosStartId,
  meosFinishId,
  meosStartName,
  meosFinishName,
  parseCourseControlIds,
  normalizeClassName,
  findBestClassMatch,
} from "../routers/course.js";
import { normalizeExpectedCodes } from "@oxygen/shared";

describe("getControlSuffix", () => {
  it("extracts numeric suffix from STA1", () => {
    expect(getControlSuffix("STA1")).toBe(1);
  });

  it("extracts numeric suffix from FIN2", () => {
    expect(getControlSuffix("FIN2")).toBe(2);
  });

  it("extracts suffix from plain number", () => {
    expect(getControlSuffix("31")).toBe(31);
  });

  it("extracts suffix with trailing whitespace", () => {
    expect(getControlSuffix("STA3 ")).toBe(3);
  });

  it("returns 1 for no numeric suffix", () => {
    expect(getControlSuffix("Start")).toBe(1);
  });

  it("returns 1 for empty string", () => {
    expect(getControlSuffix("")).toBe(1);
  });

  it("extracts multi-digit suffix", () => {
    expect(getControlSuffix("CTRL123")).toBe(123);
  });
});

describe("meosStartId / meosFinishId", () => {
  it("start 1 → 211101", () => {
    expect(meosStartId(1)).toBe(211101);
  });

  it("start 2 → 211102", () => {
    expect(meosStartId(2)).toBe(211102);
  });

  it("finish 1 → 311101", () => {
    expect(meosFinishId(1)).toBe(311101);
  });

  it("finish 3 → 311103", () => {
    expect(meosFinishId(3)).toBe(311103);
  });
});

describe("meosStartName / meosFinishName", () => {
  it("start 1 → 'Start 1'", () => {
    expect(meosStartName(1)).toBe("Start 1");
  });

  it("start 2 → 'Start 2'", () => {
    expect(meosStartName(2)).toBe("Start 2");
  });

  it("finish 1 → 'Mål 1'", () => {
    expect(meosFinishName(1)).toBe("Mål 1");
  });

  it("finish 2 → 'Mål 2'", () => {
    expect(meosFinishName(2)).toBe("Mål 2");
  });
});

describe("parseCourseControlIds", () => {
  it("parses a typical MeOS-style trailing-semicolon list", () => {
    expect(parseCourseControlIds("31;32;33;")).toEqual([31, 32, 33]);
  });

  it("handles missing trailing semicolon", () => {
    expect(parseCourseControlIds("31;32;33")).toEqual([31, 32, 33]);
  });

  it("returns an empty list for an empty string", () => {
    expect(parseCourseControlIds("")).toEqual([]);
  });

  it("trims whitespace around tokens", () => {
    expect(parseCourseControlIds(" 31 ; 32 ; ")).toEqual([31, 32]);
  });

  it("drops non-numeric and non-positive tokens", () => {
    expect(parseCourseControlIds("31;abc;0;-5;42;")).toEqual([31, 42]);
  });

  it("preserves duplicate Ids (a control may appear twice on a course)", () => {
    expect(parseCourseControlIds("31;42;31;")).toEqual([31, 42, 31]);
  });
});

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
  const dbClasses = [
    { Id: 1, Name: "H21" },
    { Id: 2, Name: "D21" },
    { Id: 3, Name: "H21 Elit" },
    { Id: 4, Name: "Öppen 5" },
  ];

  it("returns null when DB list is empty", () => {
    expect(findBestClassMatch("H21", [])).toBeNull();
  });

  it("returns null when no match is possible", () => {
    expect(findBestClassMatch("H35", dbClasses)).toBeNull();
  });

  it("matches identical names as an exact match", () => {
    expect(findBestClassMatch("H21", dbClasses)).toEqual({
      id: 1,
      name: "H21",
      matchType: "exact",
    });
  });

  it("matches case-insensitively as exact", () => {
    expect(findBestClassMatch("h21", dbClasses)).toEqual({
      id: 1,
      name: "H21",
      matchType: "exact",
    });
    expect(findBestClassMatch("D21", dbClasses)).toEqual({
      id: 2,
      name: "D21",
      matchType: "exact",
    });
  });

  it("matches across whitespace differences as a normalized match", () => {
    expect(findBestClassMatch("H 21", dbClasses)).toEqual({
      id: 1,
      name: "H21",
      matchType: "normalized",
    });
  });

  it("matches across punctuation differences as a normalized match", () => {
    expect(findBestClassMatch("H.21", dbClasses)).toEqual({
      id: 1,
      name: "H21",
      matchType: "normalized",
    });
    expect(findBestClassMatch("H,21", dbClasses)).toEqual({
      id: 1,
      name: "H21",
      matchType: "normalized",
    });
    expect(findBestClassMatch("D-21", dbClasses)).toEqual({
      id: 2,
      name: "D21",
      matchType: "normalized",
    });
  });

  it("prefers a normalized exact match over a substring match", () => {
    // "H21" must match "H21" (id=1), NOT the longer "H21 Elit" (id=3).
    expect(findBestClassMatch("H 21", dbClasses)).toEqual({
      id: 1,
      name: "H21",
      matchType: "normalized",
    });
  });

  it("falls back to substring match when no exact / normalized match exists", () => {
    // "H21 Elit Lång" is not equal to anything but contains "H21 Elit".
    const result = findBestClassMatch("H21 Elit Lång", dbClasses);
    expect(result).toEqual({ id: 3, name: "H21 Elit", matchType: "substring" });
  });

  it("substring fallback works in either direction", () => {
    // XML "Elit" is substring of DB "H21 Elit" (after normalization).
    const result = findBestClassMatch("Elit", dbClasses);
    expect(result).toEqual({ id: 3, name: "H21 Elit", matchType: "substring" });
  });

  it("normalizes both sides during substring matching", () => {
    // DB stores "Öppen 5" with whitespace; XML has "Öppen-5".
    expect(findBestClassMatch("Öppen-5", dbClasses)).toEqual({
      id: 4,
      name: "Öppen 5",
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
