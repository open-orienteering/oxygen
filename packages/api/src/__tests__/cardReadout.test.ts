import { describe, it, expect } from "vitest";
import {
  parsePunches,
  parseCourseControls,
  matchPunchesToCourse,
  computeReadId,
  computeMatchScore,
  PUNCH_START,
  PUNCH_FINISH,
  PUNCH_CHECK,
  type ParsedPunch,
} from "../routers/cardReadout.js";

// ─── parsePunches ────────────────────────────────────────────

describe("parsePunches", () => {
  it("parses standard punch string with decisecond times", () => {
    const result = parsePunches("31-3600.5;32-3660.0;");
    expect(result).toEqual([
      { type: 31, time: 36005, source: "card" },
      { type: 32, time: 36600, source: "card" },
    ]);
  });

  it("parses start, check, and finish punches", () => {
    const result = parsePunches("3-3500.0;1-3550.0;31-3600.0;2-3700.0;");
    expect(result).toHaveLength(4);
    expect(result[0].type).toBe(PUNCH_CHECK);
    expect(result[1].type).toBe(PUNCH_START);
    expect(result[2].type).toBe(31);
    expect(result[3].type).toBe(PUNCH_FINISH);
  });

  it("extracts @unit suffix", () => {
    const result = parsePunches("31-3600.0@42;");
    expect(result).toEqual([{ type: 31, time: 36000, source: "card", unit: 42 }]);
  });

  it("strips #origin suffix", () => {
    const result = parsePunches("31-3600.0#1;");
    expect(result).toEqual([{ type: 31, time: 36000, source: "card" }]);
  });

  it("extracts @unit and strips #origin", () => {
    const result = parsePunches("31-3600.0@42#1;");
    expect(result).toEqual([{ type: 31, time: 36000, source: "card", unit: 42 }]);
  });

  it("returns empty array for empty string", () => {
    expect(parsePunches("")).toEqual([]);
  });

  it("returns empty array for null-like input", () => {
    expect(parsePunches("")).toEqual([]);
  });

  it("skips malformed entries without dash", () => {
    const result = parsePunches("31-3600.0;garbage;32-3660.0;");
    expect(result).toHaveLength(2);
  });

  it("handles time without decimal point", () => {
    const result = parsePunches("31-3600;");
    expect(result).toEqual([{ type: 31, time: 36000, source: "card" }]);
  });
});

// ─── parseCourseControls ─────────────────────────────────────

describe("parseCourseControls", () => {
  it("parses semicolon-separated control codes", () => {
    expect(parseCourseControls("31;32;33;")).toEqual([31, 32, 33]);
  });

  it("returns empty array for empty string", () => {
    expect(parseCourseControls("")).toEqual([]);
  });

  it("filters out NaN values", () => {
    expect(parseCourseControls("31;abc;33;")).toEqual([31, 33]);
  });
});

// ─── matchPunchesToCourse ────────────────────────────────────

describe("matchPunchesToCourse", () => {
  const START = 324000; // 09:00:00 in deciseconds

  function punch(type: number, time: number): ParsedPunch {
    return { type, time, source: "card" };
  }

  it("matches all controls with start and finish", () => {
    const punches = [
      punch(PUNCH_START, START),
      punch(31, START + 600),
      punch(32, START + 1200),
      punch(PUNCH_FINISH, START + 1800),
    ];
    const result = matchPunchesToCourse(punches, [31, 32]);

    expect(result.missingCount).toBe(0);
    expect(result.startTime).toBe(START);
    expect(result.cardStartTime).toBe(START);
    expect(result.finishTime).toBe(START + 1800);
    expect(result.matches).toHaveLength(2);
    expect(result.matches[0]).toMatchObject({ controlCode: 31, status: "ok" });
    expect(result.matches[1]).toMatchObject({ controlCode: 32, status: "ok" });
  });

  it("reports missing controls", () => {
    const punches = [
      punch(PUNCH_START, START),
      punch(31, START + 600),
      // missing 32
      punch(PUNCH_FINISH, START + 1800),
    ];
    const result = matchPunchesToCourse(punches, [31, 32]);

    expect(result.missingCount).toBe(1);
    expect(result.matches[1]).toMatchObject({ controlCode: 32, status: "missing" });
  });

  it("returns finishTime=0 when no finish punch", () => {
    const punches = [
      punch(PUNCH_START, START),
      punch(31, START + 600),
    ];
    const result = matchPunchesToCourse(punches, [31]);

    expect(result.finishTime).toBe(0);
  });

  it("uses fallback start time when no start punch (punch-start event)", () => {
    const punches = [
      punch(31, START + 600),
      punch(PUNCH_FINISH, START + 1800),
    ];
    const result = matchPunchesToCourse(punches, [31], START);

    expect(result.startTime).toBe(START);
    expect(result.cardStartTime).toBe(0);
  });

  it("prefers assigned (fallback) start over card start punch", () => {
    const assignedStart = START;
    const cardStart = START + 150; // punched 15s late
    const punches = [
      punch(PUNCH_START, cardStart),
      punch(31, START + 600),
      punch(PUNCH_FINISH, START + 1800),
    ];
    const result = matchPunchesToCourse(punches, [31], assignedStart);

    // Assigned start takes priority
    expect(result.startTime).toBe(assignedStart);
    // Card start punch is still available for review
    expect(result.cardStartTime).toBe(cardStart);
  });

  it("uses card start punch when no assigned start (punch-start)", () => {
    const cardStart = START + 150;
    const punches = [
      punch(PUNCH_START, cardStart),
      punch(31, START + 600),
      punch(PUNCH_FINISH, START + 1800),
    ];
    const result = matchPunchesToCourse(punches, [31], 0);

    expect(result.startTime).toBe(cardStart);
    expect(result.cardStartTime).toBe(cardStart);
  });

  it("reports extra punches not in course", () => {
    const punches = [
      punch(PUNCH_START, START),
      punch(31, START + 600),
      punch(99, START + 900), // not in course
      punch(32, START + 1200),
      punch(PUNCH_FINISH, START + 1800),
    ];
    const result = matchPunchesToCourse(punches, [31, 32]);

    expect(result.missingCount).toBe(0);
    expect(result.extraPunches).toHaveLength(1);
    expect(result.extraPunches[0].type).toBe(99);
  });

  it("returns all controls as missing when no punches", () => {
    const result = matchPunchesToCourse([], [31, 32, 33]);

    expect(result.missingCount).toBe(3);
    expect(result.matches.every((m) => m.status === "missing")).toBe(true);
  });

  it("computes correct split and cumulative times", () => {
    const punches = [
      punch(PUNCH_START, START),
      punch(31, START + 600),
      punch(32, START + 1800),
      punch(PUNCH_FINISH, START + 2400),
    ];
    const result = matchPunchesToCourse(punches, [31, 32]);

    expect(result.matches[0].splitTime).toBe(600); // from start
    expect(result.matches[0].cumTime).toBe(600);
    expect(result.matches[1].splitTime).toBe(1200); // from control 31
    expect(result.matches[1].cumTime).toBe(1800);
  });

  it("handles sequential matching (skips out-of-order punches)", () => {
    // Punches in wrong order: 32 before 31
    const punches = [
      punch(PUNCH_START, START),
      punch(32, START + 300), // too early for course order
      punch(31, START + 600),
      punch(32, START + 1200), // correct 32
      punch(PUNCH_FINISH, START + 1800),
    ];
    const result = matchPunchesToCourse(punches, [31, 32]);

    expect(result.missingCount).toBe(0);
    expect(result.matches[0]).toMatchObject({ controlCode: 31, punchTime: START + 600 });
    expect(result.matches[1]).toMatchObject({ controlCode: 32, punchTime: START + 1200 });
    expect(result.extraPunches).toHaveLength(1);
    expect(result.extraPunches[0]).toMatchObject({ type: 32, time: START + 300 });
  });

  // ─── number[][] (per-position) matcher behaviour ───────────────────────────

  it("accepts the new per-position number[][] shape (single-code positions)", () => {
    // Same scenario as the first test, but expressed with the new shape.
    const punches = [
      punch(PUNCH_START, START),
      punch(31, START + 600),
      punch(32, START + 1200),
      punch(PUNCH_FINISH, START + 1800),
    ];
    const result = matchPunchesToCourse(punches, [[31], [32]]);

    expect(result.missingCount).toBe(0);
    expect(result.matches[0]).toMatchObject({ controlCode: 31, status: "ok" });
    expect(result.matches[1]).toMatchObject({ controlCode: 32, status: "ok" });
    expect(result.matches[0].expectedCodes).toEqual([31]);
  });

  it("accepts any code from a multi-code position (oControl.Numbers='131;231')", () => {
    // Course position 0 has two acceptable codes; the runner happens to
    // hit the second one. MeOS-equivalent oCourse.cpp:472,483.
    const punches = [
      punch(PUNCH_START, START),
      punch(231, START + 600),
      punch(PUNCH_FINISH, START + 1800),
    ];
    const result = matchPunchesToCourse(punches, [[131, 231]]);

    expect(result.missingCount).toBe(0);
    expect(result.matches[0]).toMatchObject({
      controlCode: 231,
      status: "ok",
      expectedCodes: [131, 231],
    });
    expect(result.extraPunches).toHaveLength(0);
  });

  it("matches a renumbered control (Id 31 lives on but punch code is now 131)", () => {
    // The course's stored Id is still 31, but the live oControl.Numbers
    // is "131" — so the matcher receives [[131]] from the resolver. A
    // card carrying punch type 131 must match; a card stuck on the old
    // code 31 must not.
    const ok = matchPunchesToCourse(
      [
        punch(PUNCH_START, START),
        punch(131, START + 600),
        punch(PUNCH_FINISH, START + 1800),
      ],
      [[131]],
    );
    expect(ok.missingCount).toBe(0);
    expect(ok.matches[0]).toMatchObject({ controlCode: 131, status: "ok" });

    const stale = matchPunchesToCourse(
      [
        punch(PUNCH_START, START),
        punch(31, START + 600),
        punch(PUNCH_FINISH, START + 1800),
      ],
      [[131]],
    );
    expect(stale.missingCount).toBe(1);
    expect(stale.matches[0]).toMatchObject({ controlCode: 131, status: "missing" });
    // The 31 punch is foreign — surfaces as an extra.
    expect(stale.extraPunches.map((p) => p.type)).toEqual([31]);
  });

  it("mixes single-code and multi-code positions on the same course", () => {
    const punches = [
      punch(PUNCH_START, START),
      punch(31, START + 600),
      punch(231, START + 1200),
      punch(33, START + 1800),
      punch(PUNCH_FINISH, START + 2400),
    ];
    const result = matchPunchesToCourse(punches, [[31], [131, 231], [33]]);

    expect(result.missingCount).toBe(0);
    expect(result.matches.map((m) => m.controlCode)).toEqual([31, 231, 33]);
  });

  it("populates expectedCodes on missing positions for diagnostics", () => {
    const result = matchPunchesToCourse([], [[131, 231], [33]]);
    expect(result.matches[0].expectedCodes).toEqual([131, 231]);
    expect(result.matches[0].controlCode).toBe(131);
    expect(result.matches[1].expectedCodes).toEqual([33]);
  });

  // ─── ExpectedPosition shape (status-aware matcher behaviour) ───────────────

  it("OK position is required (missing → MP, time counts) — sanity check via ExpectedPosition shape", () => {
    const punches = [
      punch(PUNCH_START, START),
      punch(31, START + 600),
      punch(PUNCH_FINISH, START + 1200),
    ];
    const result = matchPunchesToCourse(
      punches,
      [{ codes: [31], skipMatching: false, noTimingLeg: false }],
    );
    expect(result.missingCount).toBe(0);
    expect(result.matches[0].positionMode).toBe("required");
    expect(result.runningTimeAdjustment).toBe(0);
  });

  it("Bad position with no punch: status=missing, mode=skipped, missingCount stays 0", () => {
    const punches = [
      punch(PUNCH_START, START),
      // no punch for the bad position
      punch(33, START + 1200),
      punch(PUNCH_FINISH, START + 1800),
    ];
    const result = matchPunchesToCourse(punches, [
      { codes: [32], skipMatching: true, noTimingLeg: false },
      { codes: [33], skipMatching: false, noTimingLeg: false },
    ]);
    expect(result.missingCount).toBe(0);
    expect(result.matches[0].status).toBe("missing");
    expect(result.matches[0].positionMode).toBe("skipped");
    expect(result.matches[1].status).toBe("ok");
  });

  it("Bad position with a punch: status=ok, mode=skipped, punch consumed (not in extras)", () => {
    const punches = [
      punch(PUNCH_START, START),
      punch(32, START + 600), // hit the bad control anyway
      punch(33, START + 1200),
      punch(PUNCH_FINISH, START + 1800),
    ];
    const result = matchPunchesToCourse(punches, [
      { codes: [32], skipMatching: true, noTimingLeg: false },
      { codes: [33], skipMatching: false, noTimingLeg: false },
    ]);
    expect(result.missingCount).toBe(0);
    expect(result.matches[0]).toMatchObject({
      status: "ok",
      positionMode: "skipped",
      controlCode: 32,
    });
    // Punch was consumed by the skipped position — not surfaced as extra.
    expect(result.extraPunches).toHaveLength(0);
  });

  it("Optional behaves identically to Bad", () => {
    // Same scenario as the previous two but with skipMatching=true
    // representing Optional rather than Bad. Our matcher doesn't
    // distinguish — both share the skipMatching code path.
    const punches = [
      punch(PUNCH_START, START),
      punch(33, START + 1200),
      punch(PUNCH_FINISH, START + 1800),
    ];
    const result = matchPunchesToCourse(punches, [
      { codes: [32], skipMatching: true, noTimingLeg: false },
      { codes: [33], skipMatching: false, noTimingLeg: false },
    ]);
    expect(result.missingCount).toBe(0);
    expect(result.matches[0].positionMode).toBe("skipped");
  });

  it("NoTiming position deducts the leg into it from runningTimeAdjustment", () => {
    // Course: 31 → 32(NoTiming) → 33. The 32 leg duration must be
    // accumulated into runningTimeAdjustment. Previous reference is the
    // ok punch at 31 (or startTime if 31 hadn't punched).
    const punches = [
      punch(PUNCH_START, START),
      punch(31, START + 600),
      punch(32, START + 1200), // leg of 600 — should be deducted
      punch(33, START + 1800),
      punch(PUNCH_FINISH, START + 2400),
    ];
    const result = matchPunchesToCourse(punches, [
      { codes: [31], skipMatching: false, noTimingLeg: false },
      { codes: [32], skipMatching: false, noTimingLeg: true },
      { codes: [33], skipMatching: false, noTimingLeg: false },
    ]);
    expect(result.missingCount).toBe(0);
    expect(result.runningTimeAdjustment).toBe(600);
    expect(result.matches[1].positionMode).toBe("noTiming");
  });

  it("BadNoTiming → propagated to next required position's leg deduction", () => {
    // Course (resolver-emitted): 31 → 32(BadNoTiming, skip) → 33(noTimingLeg=true).
    // The runner skipped 32 entirely. Time from 31 to 33 (1200 deciseconds)
    // should be deducted. Resolver propagation happens upstream — here we
    // just verify the matcher honours the noTimingLeg flag on 33.
    const punches = [
      punch(PUNCH_START, START),
      punch(31, START + 600),
      // no punch at 32 (was destroyed mid-race)
      punch(33, START + 1800), // 1200 deciseconds after 31
      punch(PUNCH_FINISH, START + 2400),
    ];
    const result = matchPunchesToCourse(punches, [
      { codes: [31], skipMatching: false, noTimingLeg: false },
      { codes: [32], skipMatching: true, noTimingLeg: false },
      { codes: [33], skipMatching: false, noTimingLeg: true },
    ]);
    expect(result.missingCount).toBe(0);
    expect(result.runningTimeAdjustment).toBe(1200);
    expect(result.matches[1].positionMode).toBe("skipped");
    expect(result.matches[2].positionMode).toBe("noTiming");
  });

  it("Multiple-expansion: 3 any-order positions sharing the same code pool", () => {
    // Resolver-emitted: a single MeOS Multiple control with Numbers
    // = "31;32;33" expands to three positions, each accepting any of
    // the three codes. The runner punches them out of "natural" order
    // 33 / 31 / 32; all count.
    const punches = [
      punch(PUNCH_START, START),
      punch(33, START + 600),
      punch(31, START + 900),
      punch(32, START + 1200),
      punch(PUNCH_FINISH, START + 1800),
    ];
    const result = matchPunchesToCourse(punches, [
      { codes: [31, 32, 33], skipMatching: false, noTimingLeg: false },
      { codes: [31, 32, 33], skipMatching: false, noTimingLeg: false },
      { codes: [31, 32, 33], skipMatching: false, noTimingLeg: false },
    ]);
    expect(result.missingCount).toBe(0);
    expect(result.matches.map((m) => m.controlCode)).toEqual([33, 31, 32]);
    expect(result.runningTimeAdjustment).toBe(0);
  });

  it("Mixed course: OK → Bad → NoTiming → Multiple → OK", () => {
    // Combines every status to verify the matcher doesn't accidentally
    // entangle adjustments / missing counts across modes.
    const punches = [
      punch(PUNCH_START, START),
      punch(31, START + 600),
      // 32 (Bad) skipped
      punch(33, START + 1200), // NoTiming → 600 leg deducted (from 31)
      punch(34, START + 1800),
      punch(35, START + 2100), // multi pool
      punch(36, START + 2400), // multi pool
      punch(37, START + 3000), // final OK
      punch(PUNCH_FINISH, START + 3600),
    ];
    const result = matchPunchesToCourse(punches, [
      { codes: [31], skipMatching: false, noTimingLeg: false },
      { codes: [32], skipMatching: true, noTimingLeg: false },
      { codes: [33], skipMatching: false, noTimingLeg: true },
      { codes: [34, 35, 36], skipMatching: false, noTimingLeg: false },
      { codes: [34, 35, 36], skipMatching: false, noTimingLeg: false },
      { codes: [34, 35, 36], skipMatching: false, noTimingLeg: false },
      { codes: [37], skipMatching: false, noTimingLeg: false },
    ]);
    expect(result.missingCount).toBe(0);
    expect(result.runningTimeAdjustment).toBe(600);
    // No leftover punches surface as extras.
    expect(result.extraPunches).toHaveLength(0);
  });
});

// ─── computeReadId ────────────────────────────────────────────

describe("computeReadId", () => {
  it("produces the same hash for identical inputs", () => {
    const punches = [
      { controlCode: 31, time: 3600 },
      { controlCode: 32, time: 3660 },
    ];
    const a = computeReadId(punches, 3700, 3550);
    const b = computeReadId(punches, 3700, 3550);
    expect(a).toBe(b);
  });

  it("produces different hashes for different punches", () => {
    const a = computeReadId(
      [{ controlCode: 31, time: 3600 }],
      3700,
      3550,
    );
    const b = computeReadId(
      [{ controlCode: 32, time: 3600 }],
      3700,
      3550,
    );
    expect(a).not.toBe(b);
  });

  it("produces different hashes for different finish times", () => {
    const punches = [{ controlCode: 31, time: 3600 }];
    const a = computeReadId(punches, 3700, 3550);
    const b = computeReadId(punches, 3800, 3550);
    expect(a).not.toBe(b);
  });

  it("produces different hashes for different start times", () => {
    const punches = [{ controlCode: 31, time: 3600 }];
    const a = computeReadId(punches, 3700, 3550);
    const b = computeReadId(punches, 3700, 3560);
    expect(a).not.toBe(b);
  });

  it("handles empty punches", () => {
    const h = computeReadId([], 0, 0);
    expect(typeof h).toBe("number");
    expect(h).toBeGreaterThanOrEqual(0);
  });

  it("handles null/undefined finish and start times", () => {
    const punches = [{ controlCode: 31, time: 3600 }];
    const a = computeReadId(punches, null, null);
    const b = computeReadId(punches, undefined, undefined);
    expect(a).toBe(b);
  });

  it("always returns a non-negative integer (unsigned 32-bit)", () => {
    // Use values that could cause overflow
    const punches = Array.from({ length: 50 }, (_, i) => ({
      controlCode: 100 + i,
      time: 40000 + i * 100,
    }));
    const h = computeReadId(punches, 99999, 10000);
    expect(h).toBeGreaterThanOrEqual(0);
    expect(h).toBeLessThanOrEqual(0xFFFFFFFF);
    expect(Number.isInteger(h)).toBe(true);
  });
});

// ─── computeMatchScore ───────────────────────────────────────

describe("computeMatchScore", () => {
  it("returns 1.0 for perfect readout (all controls matched, no foreign)", () => {
    expect(computeMatchScore(15, 15, 15, 0)).toBe(1.0);
  });

  it("returns proportional score for missing punches (MP)", () => {
    // 12/15 matched = 0.8
    expect(computeMatchScore(15, 12, 12, 0)).toBeCloseTo(0.8);
  });

  it("penalizes 0.10 per foreign punch", () => {
    // 15/15 matched = 1.0, minus 1 foreign * 0.10 = 0.9
    expect(computeMatchScore(15, 15, 16, 1)).toBeCloseTo(0.9);
  });

  it("penalizes multiple foreign punches", () => {
    // 15/15 matched = 1.0, minus 3 foreign * 0.10 = 0.7
    expect(computeMatchScore(15, 15, 18, 3)).toBeCloseTo(0.7);
  });

  it("returns low score for coincidental 1-control overlap", () => {
    // 1/15 = 0.067
    const score = computeMatchScore(15, 1, 10, 0);
    expect(score).toBeCloseTo(1 / 15);
    expect(score).toBeLessThan(0.1);
  });

  it("returns 0 when foreign penalty exceeds course rate", () => {
    // 1/15 = 0.067, minus 3 * 0.10 = -0.233 → clamped to 0
    expect(computeMatchScore(15, 1, 4, 3)).toBe(0);
  });

  it("returns 0 for empty course", () => {
    expect(computeMatchScore(0, 0, 5, 0)).toBe(0);
  });

  it("returns 0 for empty card (no punches)", () => {
    expect(computeMatchScore(15, 0, 0, 0)).toBe(0);
  });

  it("never exceeds 1.0", () => {
    // Even if somehow matchedCount > courseControlCount
    expect(computeMatchScore(5, 10, 10, 0)).toBeLessThanOrEqual(1.0);
  });

  it("never goes below 0.0", () => {
    expect(computeMatchScore(5, 0, 20, 20)).toBe(0);
  });
});
