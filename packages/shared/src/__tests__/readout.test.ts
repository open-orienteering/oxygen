import { describe, it, expect } from "vitest";
import {
  findMatchingVariants,
  PUNCH_START,
  PUNCH_FINISH,
  type ExpectedPosition,
  type ParsedPunch,
  type VariantCandidate,
} from "../readout.js";

const req = (code: number): ExpectedPosition => ({ codes: [code], skipMatching: false, noTimingLeg: false });
const opt = (code: number): ExpectedPosition => ({ codes: [code], skipMatching: true, noTimingLeg: false });

function card(codes: number[]): ParsedPunch[] {
  const ps: ParsedPunch[] = [{ type: PUNCH_START, time: 1000, source: "card" }];
  codes.forEach((c, i) => ps.push({ type: c, time: 1100 + i * 100, source: "card" }));
  ps.push({ type: PUNCH_FINISH, time: 1100 + codes.length * 100, source: "card" });
  return ps;
}

function variant(key: string, codes: number[], orderMode?: "ordered" | "free_order"): VariantCandidate {
  return {
    courseId: key.charCodeAt(0),
    variantKey: key,
    courseName: `Lång ${key}`,
    expectedPositions: codes.map(req),
    orderMode,
  };
}

describe("findMatchingVariants", () => {
  // A butterfly: 31 → (32 | 33) → 34.
  const A = variant("A", [31, 32, 34]);
  const B = variant("B", [31, 33, 34]);

  it("lists the variant the punches validate fully against", () => {
    expect(findMatchingVariants(card([31, 33, 34]), [A, B])).toEqual([
      { courseId: B.courseId, variantKey: "B", courseName: "Lång B" },
    ]);
  });

  it("ignores a partial match (one required control missing)", () => {
    expect(findMatchingVariants(card([31, 34]), [A, B])).toEqual([]);
  });

  it("returns [] for no candidates and never matches an empty variant", () => {
    expect(findMatchingVariants(card([31, 33, 34]), [])).toEqual([]);
    expect(findMatchingVariants(card([31, 33, 34]), [variant("C", [])])).toEqual([]);
  });

  it("does not count skipped (optional) positions as missing", () => {
    const C: VariantCandidate = { ...variant("C", [31, 34]), expectedPositions: [req(31), opt(35), req(34)] };
    expect(findMatchingVariants(card([31, 34]), [C]).map((m) => m.variantKey)).toEqual(["C"]);
  });

  it("an ordered loop pair matches only the visiting order run", () => {
    const AB = variant("AB", [41, 42, 41, 43, 41]);
    const BA = variant("BA", [41, 43, 41, 42, 41]);
    expect(findMatchingVariants(card([41, 42, 41, 43, 41]), [AB, BA]).map((m) => m.variantKey)).toEqual(["AB"]);
  });

  it("a free-order loop pair lists several, in candidate order", () => {
    const AB = variant("AB", [41, 42, 41, 43, 41], "free_order");
    const BA = variant("BA", [41, 43, 41, 42, 41], "free_order");
    expect(findMatchingVariants(card([41, 42, 41, 43, 41]), [AB, BA]).map((m) => m.variantKey)).toEqual([
      "AB",
      "BA",
    ]);
  });
});
