import { describe, it, expect } from "vitest";
import {
  findMatchingVariants,
  mergePunchesInCardOrder,
  matchPunchesToCourse,
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


describe("mergePunchesInCardOrder", () => {
  const c = (type: number, time: number): ParsedPunch => ({ type, time, source: "card" });
  const f = (type: number, time: number): ParsedPunch => ({ type, time, source: "free" });
  const types = (ps: ParsedPunch[]) => ps.map((p) => p.type);

  it("keeps card punches in card order, even when the card clock ran backwards", () => {
    // 32's clock is an hour behind: sorting by time would put it first.
    const card = [c(31, 36000), c(32, 32500), c(33, 36200)];
    expect(types(mergePunchesInCardOrder(card, []))).toEqual([31, 32, 33]);
  });

  it("does not modify its inputs", () => {
    const card = [c(31, 100), c(33, 300)];
    const free = [f(32, 200)];
    mergePunchesInCardOrder(card, free);
    expect(types(card)).toEqual([31, 33]);
    expect(types(free)).toEqual([32]);
  });

  it("inserts a free punch before the first card punch with a later time", () => {
    const merged = mergePunchesInCardOrder([c(31, 100), c(33, 300)], [f(32, 200)]);
    expect(types(merged)).toEqual([31, 32, 33]);
  });

  it("appends a free punch later than every card punch", () => {
    const merged = mergePunchesInCardOrder([c(31, 100), c(32, 200)], [f(33, 900)]);
    expect(types(merged)).toEqual([31, 32, 33]);
  });

  it("orders several free punches by time among the card punches", () => {
    const merged = mergePunchesInCardOrder(
      [c(31, 100), c(35, 500)],
      [f(34, 400), f(32, 200), f(33, 300)],
    );
    expect(types(merged)).toEqual([31, 32, 33, 34, 35]);
  });

  it("puts a free punch with the same time after the card punch (strictly later wins)", () => {
    const merged = mergePunchesInCardOrder([c(31, 100), c(32, 200)], [f(99, 100)]);
    expect(types(merged)).toEqual([31, 99, 32]);
  });

  it("ignores the special start/finish punches as insert positions (stored cards list them first)", () => {
    // punches_raw is written as start, finish, then the controls.
    const card = [c(PUNCH_START, 100), c(PUNCH_FINISH, 900), c(31, 200), c(33, 400)];
    const merged = mergePunchesInCardOrder(card, [f(32, 300)]);
    expect(types(merged)).toEqual([PUNCH_START, PUNCH_FINISH, 31, 32, 33]);
  });

  it("skips card punches without a time when looking for the insert position", () => {
    // SI5 overflow punches have time 0 and stay where the card put them.
    const merged = mergePunchesInCardOrder([c(31, 100), c(60, 0), c(33, 300)], [f(32, 200)]);
    expect(types(merged)).toEqual([31, 60, 32, 33]);
  });

  it("appends free punches without a time at the end", () => {
    const merged = mergePunchesInCardOrder([c(31, 100)], [f(77, 0), f(32, 50)]);
    expect(types(merged)).toEqual([32, 31, 77]);
  });
});

describe("matching with the merged order (SI-09)", () => {
  const START = 3_600_000;
  const pos = (code: number): ExpectedPosition => ({ codes: [code], skipMatching: false, noTimingLeg: false });
  const course = [31, 32, 33].map(pos);

  it("a card punch with a clock an hour behind still matches in card order", () => {
    const card: ParsedPunch[] = [
      { type: 31, time: START + 1000, source: "card" },
      { type: 32, time: START - 35_000, source: "card" }, // clock an hour behind
      { type: 33, time: START + 3000, source: "card" },
      { type: 2, time: START + 4000, source: "card" },
    ];
    const result = matchPunchesToCourse(mergePunchesInCardOrder(card, []), course, START);
    expect(result.missingCount).toBe(0);
  });

  it("the same card sorted by time would lose the control (what the old merge did)", () => {
    const card: ParsedPunch[] = [
      { type: 31, time: START + 1000, source: "card" },
      { type: 32, time: START - 35_000, source: "card" },
      { type: 33, time: START + 3000, source: "card" },
      { type: 2, time: START + 4000, source: "card" },
    ];
    const sorted = [...card].sort((a, b) => a.time - b.time);
    expect(matchPunchesToCourse(sorted, course, START).missingCount).toBe(1);
  });

  it("a radio punch still fills a control the card missed", () => {
    const card: ParsedPunch[] = [
      { type: 31, time: START + 1000, source: "card" },
      { type: 33, time: START + 3000, source: "card" },
      { type: 2, time: START + 4000, source: "card" },
    ];
    const radio: ParsedPunch[] = [{ type: 32, time: START + 2000, source: "free" }];
    const result = matchPunchesToCourse(mergePunchesInCardOrder(card, radio), course, START);
    expect(result.missingCount).toBe(0);
  });

  it("code-only SI5 overflow punches (time 0) stay at the tail", () => {
    const card: ParsedPunch[] = [
      { type: 31, time: START + 1000, source: "card" },
      { type: 32, time: START + 2000, source: "card" },
      { type: 33, time: START + 3000, source: "card" },
      { type: 2, time: START + 4000, source: "card" },
      { type: 90, time: 0, source: "card" },
    ];
    const merged = mergePunchesInCardOrder(card, []);
    expect(merged.map((p) => p.type)).toEqual([31, 32, 33, 2, 90]);
    expect(matchPunchesToCourse(merged, course, START).missingCount).toBe(0);
  });
});
