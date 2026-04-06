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

export interface ControlMatch {
  controlIndex: number;
  controlCode: number;
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
 * Match punches sequentially to course controls. Returns matched controls,
 * extra (unmatched) punches, and timing info.
 */
export function matchPunchesToCourse(
  punches: ParsedPunch[],
  courseControls: number[],
  fallbackStartTime = 0,
): MatchResult {
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

  for (let ci = 0; ci < courseControls.length; ci++) {
    const expectedCode = courseControls[ci];
    let found = false;

    for (let pi = punchSearchStart; pi < controlPunches.length; pi++) {
      if (controlPunches[pi].type === expectedCode && !usedPunchIndices.has(pi)) {
        const p = controlPunches[pi];
        const splitTime = p.time - prevTime;
        const cumTime = p.time - startTime;

        matches.push({
          controlIndex: ci,
          controlCode: expectedCode,
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
        controlCode: expectedCode,
        punchTime: 0,
        splitTime: 0,
        cumTime: 0,
        status: "missing",
        source: "",
      });
      missingCount++;
    }
  }

  const extraPunches = controlPunches.filter(
    (_, idx) => !usedPunchIndices.has(idx),
  );

  return { matches, extraPunches, startTime, cardStartTime, finishTime, missingCount };
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
