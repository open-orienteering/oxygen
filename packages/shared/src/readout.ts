/**
 * Card readout logic — pure functions for parsing punches, matching courses,
 * and computing readout results. Used by both server (API) and client (offline).
 *
 * These functions have zero database dependencies — they operate on data
 * passed in as parameters.
 */

import { RunnerStatus, TransferFlags, hasTransferFlag } from "./types.js";

// ─── Constants ──────────────────────────────────────────────

/** Special punch type codes in MeOS */
export const PUNCH_START = 1;
export const PUNCH_FINISH = 2;
export const PUNCH_CHECK = 3;

// ─── Types ──────────────────────────────────────────────────

export interface ParsedPunch {
  type: number;
  time: number; // deciseconds since midnight (absolute or ZeroTime-relative, depending on context)
  source: "card" | "free";
  freePunchId?: number; // oPunch.Id for free punches (enables removal)
  unit?: number; // MeOS punch unit (timing station identifier)
}

/**
 * MeOS control status modes that affect the matcher and time accounting.
 *
 * - "required": OK / Multiple expansion. Missing increments missingCount;
 *   the leg time into this position counts toward running time.
 * - "skipped": Bad / Optional / BadNoTiming. Missing does NOT count as MP.
 *   If the runner happens to have punched a matching code, we still
 *   consume it and record the time (matches MeOS oRunner.cpp:1424-1438).
 * - "noTiming": NoTiming or the OK position immediately following a
 *   BadNoTiming. The leg time into this position is deducted from the
 *   running time (matches MeOS oRunner.cpp:1777-1786).
 */
export type PositionMode = "required" | "skipped" | "noTiming";

export interface ControlMatch {
  controlIndex: number;
  /**
   * The code that actually matched a punch (the punch's `type`) when
   * `status === "ok"`. For missing / extra positions, this falls back to
   * the first acceptable code on that position so the UI has something
   * stable to display.
   */
  controlCode: number;
  /**
   * All SI punch codes that were acceptable at this position. Single-code
   * positions yield a one-element array; multi-code controls yield several.
   */
  expectedCodes: number[];
  /** Mode of this course position — see {@link PositionMode}. */
  positionMode: PositionMode;
  punchTime: number;
  splitTime: number;
  cumTime: number;
  status: "ok" | "missing" | "extra";
  source: "card" | "free" | "";
  freePunchId?: number;
}

export interface MatchResult {
  matches: ControlMatch[];
  extraPunches: ParsedPunch[];
  startTime: number;
  cardStartTime: number;
  finishTime: number;
  missingCount: number;
  /**
   * Sum of leg deciseconds that should be deducted from the raw
   * `finishTime - startTime` to obtain the corrected running time.
   * Accumulated from positions whose mode is `"noTiming"` (NoTiming
   * controls and OK positions following a BadNoTiming).
   */
  runningTimeAdjustment: number;
}

export interface StatusInput {
  finishTime: number;
  startTime: number;
  missingCount: number;
  runningTime: number;
  classMaxTime: number; // 0 = no limit (deciseconds)
  classNoTiming: boolean;
  transferFlags: number;
  currentStatus: number; // fallback if no determination can be made
}

// ─── Punch Parsing ──────────────────────────────────────────

/**
 * Parse MeOS card punch string: "{type}-{seconds}.{tenths}[@unit][#origin];"
 */
export function parsePunches(punchString: string): ParsedPunch[] {
  if (!punchString) return [];
  const punches: ParsedPunch[] = [];
  const parts = punchString.split(";").filter(Boolean);

  for (const part of parts) {
    const dashIdx = part.indexOf("-");
    if (dashIdx === -1) continue;

    const type = parseInt(part.substring(0, dashIdx), 10);
    let timeStr = part.substring(dashIdx + 1);

    // Extract optional @unit suffix (MeOS timing station identifier)
    let unit: number | undefined;
    const atIdx = timeStr.indexOf("@");
    if (atIdx !== -1) {
      const unitStr = timeStr.substring(atIdx + 1).split("#")[0];
      unit = parseInt(unitStr, 10) || undefined;
      timeStr = timeStr.substring(0, atIdx);
    }
    const hashIdx = timeStr.indexOf("#");
    if (hashIdx !== -1) timeStr = timeStr.substring(0, hashIdx);

    const dotIdx = timeStr.indexOf(".");
    let time: number;
    if (dotIdx !== -1) {
      const seconds = parseInt(timeStr.substring(0, dotIdx), 10);
      const tenths = parseInt(timeStr.substring(dotIdx + 1), 10) || 0;
      time = seconds * 10 + tenths;
    } else {
      time = parseInt(timeStr, 10) * 10;
    }

    if (!isNaN(type) && !isNaN(time)) {
      punches.push({ type, time, source: "card", ...(unit ? { unit } : {}) });
    }
  }

  return punches;
}

// ─── ReadId Hash ────────────────────────────────────────────

/**
 * Compute a ReadId hash from punch data, matching MeOS's SICard::calculateHash().
 * Used for deduplication — identical card reads produce the same hash.
 */
export function computeReadId(
  punches: { controlCode: number; time: number }[],
  finishTime?: number | null,
  startTime?: number | null,
): number {
  let h = (punches.length * 100000 + (finishTime ?? 0)) >>> 0;
  for (const p of punches) {
    h = (((h * 31 + p.controlCode) >>> 0) * 31 + p.time) >>> 0;
  }
  h = (h + (startTime ?? 0)) >>> 0;
  return h;
}

// ─── Match Score ────────────────────────────────────────────

/**
 * Compute a 0.0–1.0 score for how well the card punches match a course.
 *
 * Base: proportion of course controls matched (0.0–1.0).
 * Penalty: each punch for a control NOT in the competition subtracts 0.10.
 */
export function computeMatchScore(
  courseControlCount: number,
  matchedCount: number,
  totalCardPunches: number,
  foreignPunchCount: number,
): number {
  if (courseControlCount === 0 || totalCardPunches === 0) return 0;
  const courseRate = matchedCount / courseControlCount;
  const penalty = foreignPunchCount * 0.10;
  return Math.max(0, Math.min(1, courseRate - penalty));
}

// ─── Course Control Parsing ─────────────────────────────────

/**
 * Parse a semicolon-delimited course control string into an array of control codes.
 */
export function parseCourseControls(controls: string): number[] {
  return controls
    .split(";")
    .filter(Boolean)
    .map((s) => parseInt(s, 10))
    .filter((n) => !isNaN(n));
}

// ─── Course Matching ────────────────────────────────────────

/**
 * Per-position descriptor for the punch matcher. Each entry corresponds
 * to one course "position" (one box on a course-setting sheet).
 *
 * - `codes`: SI punch codes acceptable at this position (one for plain
 *   controls, several for multi-code or MeOS Multiple expansion).
 * - `skipMatching`: when true, missing this position does NOT increment
 *   `missingCount`. If a card has a punch matching one of `codes`, the
 *   punch is still consumed and recorded for splits (mirrors MeOS
 *   `oRunner.cpp:1424-1438`).
 * - `noTimingLeg`: when true, the leg time INTO this position is added
 *   to `MatchResult.runningTimeAdjustment`. Set on NoTiming positions
 *   directly; the resolver also propagates it to the next required
 *   position following a BadNoTiming (mirrors `oRunner.cpp:1772-1786`).
 */
export interface ExpectedPosition {
  codes: number[];
  skipMatching: boolean;
  noTimingLeg: boolean;
}

/**
 * Normalise the matcher's per-position input. Accepts:
 *   - `number[]`        — legacy: one required code per position.
 *   - `number[][]`      — multi-code aware: each inner array is the
 *                         acceptable code set for one required position.
 *   - `ExpectedPosition[]` — full shape with status-aware flags.
 *
 * Legacy shapes lift to `ExpectedPosition[]` with `skipMatching=false`,
 * `noTimingLeg=false`, so existing call sites keep working unchanged.
 *
 * @internal Exported for unit testing.
 */
export function normalizeExpectedCodes(
  input: number[] | number[][] | ExpectedPosition[],
): ExpectedPosition[] {
  if (input.length === 0) return [];
  const first = input[0];
  if (typeof first === "object" && !Array.isArray(first)) {
    return input as ExpectedPosition[];
  }
  if (Array.isArray(first)) {
    return (input as number[][]).map((codes) => ({
      codes,
      skipMatching: false,
      noTimingLeg: false,
    }));
  }
  return (input as number[]).map((c) => ({
    codes: [c],
    skipMatching: false,
    noTimingLeg: false,
  }));
}

/**
 * Match punches sequentially to a course's expected control sequence.
 *
 * `expected` is a per-position descriptor list. Required positions
 * behave like MeOS `oCourse::distance` (oCourse.cpp:472-501). Skipped
 * positions consume a matching punch when present but never raise
 * `missingCount`. Positions with `noTimingLeg=true` contribute their
 * incoming leg duration to `runningTimeAdjustment` so callers can
 * subtract it from `finishTime - startTime` to obtain the corrected
 * running time.
 *
 * Backward compatibility: legacy callers may pass `number[]` (single
 * required code per position) or `number[][]` (multi-code per position);
 * both shapes are lifted into `ExpectedPosition[]` automatically.
 */
export function matchPunchesToCourse(
  punches: ParsedPunch[],
  expected: number[] | number[][] | ExpectedPosition[],
  fallbackStartTime = 0,
): MatchResult {
  const positions = normalizeExpectedCodes(expected);

  const startPunch = punches.find((p) => p.type === PUNCH_START);
  const finishPunch = punches.find((p) => p.type === PUNCH_FINISH);
  const controlPunches = punches.filter(
    (p) => p.type !== PUNCH_START && p.type !== PUNCH_FINISH && p.type !== PUNCH_CHECK,
  );

  const cardStartTime = startPunch?.time ?? 0;
  const startTime = fallbackStartTime > 0 ? fallbackStartTime : cardStartTime;
  const finishTime = finishPunch?.time ?? 0;

  const matches: ControlMatch[] = [];
  const usedPunchIndices = new Set<number>();
  let punchSearchStart = 0;
  let prevTime = startTime;
  let missingCount = 0;

  for (let ci = 0; ci < positions.length; ci++) {
    const pos = positions[ci];
    const acceptable = new Set(pos.codes);
    // Display fallback for missing/extra rows: prefer the first acceptable
    // code, mirroring MeOS's "Numbers[0]" convention for the displayed code.
    const displayCode = pos.codes[0] ?? 0;
    const positionMode: PositionMode = pos.noTimingLeg
      ? "noTiming"
      : pos.skipMatching
      ? "skipped"
      : "required";
    let found = false;

    for (let pi = punchSearchStart; pi < controlPunches.length; pi++) {
      if (acceptable.has(controlPunches[pi].type) && !usedPunchIndices.has(pi)) {
        const p = controlPunches[pi];
        const splitTime = p.time - prevTime;
        const cumTime = p.time - startTime;

        matches.push({
          controlIndex: ci,
          controlCode: p.type,
          expectedCodes: [...pos.codes],
          positionMode,
          punchTime: p.time,
          splitTime,
          cumTime,
          status: "ok",
          source: p.source,
          freePunchId: p.freePunchId,
        });

        usedPunchIndices.add(pi);
        punchSearchStart = pi + 1;
        prevTime = p.time;
        found = true;
        break;
      }
    }

    if (!found) {
      matches.push({
        controlIndex: ci,
        controlCode: displayCode,
        expectedCodes: [...pos.codes],
        positionMode,
        punchTime: 0,
        splitTime: 0,
        cumTime: 0,
        status: "missing",
        source: "",
      });
      // Skipped positions never raise the missing-punch flag, regardless
      // of whether a matching punch was actually found in the card.
      if (!pos.skipMatching) missingCount++;
    }
  }

  // Compute the running-time adjustment from positions with `noTimingLeg`.
  // The deducted leg is from the previous timed reference (the prior ok
  // match, or `startTime` if none) to this position's punch time. Walking
  // matches in order is enough — `prevReferenceTime` advances on every ok
  // match regardless of mode. Missing or skipped-without-punch positions
  // contribute nothing.
  let runningTimeAdjustment = 0;
  let prevReferenceTime = startTime;
  for (const m of matches) {
    if (m.status === "ok") {
      if (m.positionMode === "noTiming") {
        runningTimeAdjustment += m.punchTime - prevReferenceTime;
      }
      prevReferenceTime = m.punchTime;
    }
  }

  const extraPunches = controlPunches.filter(
    (_, idx) => !usedPunchIndices.has(idx),
  );

  return {
    matches,
    extraPunches,
    startTime,
    cardStartTime,
    finishTime,
    missingCount,
    runningTimeAdjustment,
  };
}

// ─── Status Computation ─────────────────────────────────────

/**
 * Compute the runner's result status from readout data.
 * Pure function — no DB access. Applies MeOS-compatible status rules.
 */
export function computeStatus(input: StatusInput): number {
  const { finishTime, missingCount, runningTime, classMaxTime, classNoTiming, transferFlags, currentStatus } = input;

  let status: number;
  if (finishTime === 0) {
    status = RunnerStatus.DNF;
  } else if (missingCount > 0) {
    status = RunnerStatus.MissingPunch;
  } else if (runningTime > 0) {
    status = RunnerStatus.OK;
  } else {
    return currentStatus;
  }

  // MeOS-compatible status overrides (only when base status is OK)
  if (status === RunnerStatus.OK) {
    if (classMaxTime > 0 && runningTime > classMaxTime) {
      status = RunnerStatus.OverMaxTime;
    }
    if (status === RunnerStatus.OK && hasTransferFlag(transferFlags, TransferFlags.FlagOutsideCompetition)) {
      status = RunnerStatus.OutOfCompetition;
    }
    if (status === RunnerStatus.OK) {
      if (classNoTiming || hasTransferFlag(transferFlags, TransferFlags.FlagNoTiming)) {
        status = RunnerStatus.NoTiming;
      }
    }
  }

  return status;
}
