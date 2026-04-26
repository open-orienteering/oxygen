/**
 * Local readout computation for offline finish station.
 * Uses cached React Query data + shared readout logic.
 *
 * Two modes:
 * - computeLocalReadout: for manual finish (no card punch data)
 * - computeCardReadout: for SI card read (full punch data available)
 */

import type { QueryClient } from "@tanstack/react-query";
import {
  parsePunches,
  matchPunchesToCourse,
  computeStatus,
  computePosition,
  computeMatchScore,
  type ParsedPunch,
  type ControlMatch,
  type ClassRunnerForPosition,
  type PositionResult,
  PUNCH_START,
  PUNCH_FINISH,
  PUNCH_CHECK,
} from "@oxygen/shared";
import type { SICardReadout } from "../si-protocol";

export interface LocalReadoutResult {
  runner: {
    id: number;
    name: string;
    cardNo: number;
    startNo: number;
    clubName: string;
    clubId: number | null;
    className: string;
    classId: number | null;
  };
  timing: {
    startTime: number;
    finishTime: number;
    runningTime: number;
    status: number;
  };
  controls: ControlMatch[];
  course: { name: string; length: number } | null;
  position: PositionResult | null;
  classResults: Array<{ name: string; clubId: number | null; runningTime: number }>;
}

/**
 * Compute a readout locally using cached data.
 * This is the offline equivalent of the server's finishReceipt endpoint.
 */
export function computeLocalReadout(
  runnerId: number,
  finishTime: number,
  queryClient: QueryClient,
): LocalReadoutResult | null {
  // Get cached data from React Query
  // These are the shapes returned by tRPC queries, accessed via their cache keys
  const dashboard = findCachedQuery<DashboardData>(queryClient, "competition.dashboard");
  const runners = findCachedQuery<RunnerListData>(queryClient, "runner.list");

  if (!dashboard || !runners) return null;

  // Find the runner
  const runner = runners.find((r: RunnerItem) => r.id === runnerId);
  if (!runner) return null;

  // Find class and course
  const cls = dashboard.classes?.find((c: ClassItem) => c.id === runner.classId);
  const course = cls?.courseId
    ? dashboard.courses?.find((c: CourseItem) => c.id === cls.courseId)
    : null;

  // No-op for the manual-finish path (no card data → no matching). Kept
  // here only so future telemetry can report course length etc.
  void course;

  // We may not have the card punch data cached locally.
  // For a manual finish (FinishStation), we don't have SI card punches —
  // the runner's punches come from the oCard table (storeReadout).
  // For offline, we do our best with what we have.
  // If no card data: we can still compute basic result (time-only, no splits).

  const startTime = runner.startTime || 0;
  const runningTime = finishTime > 0 && startTime > 0 ? finishTime - startTime : 0;

  const status = computeStatus({
    finishTime,
    startTime,
    missingCount: 0, // We don't know without card data
    runningTime,
    classMaxTime: cls?.maxTime ?? 0,
    classNoTiming: cls?.noTiming === 1,
    transferFlags: runner.transferFlags ?? 0,
    currentStatus: runner.status,
  });

  // Compute position from cached runners
  const classRunners: ClassRunnerForPosition[] = runners
    .filter((r: RunnerItem) => r.classId === runner.classId && r.id !== runnerId)
    .map((r: RunnerItem) => ({
      name: r.name,
      clubId: r.clubId ?? null,
      startTime: r.startTime,
      finishTime: r.finishTime,
    }));

  const position = computePosition(
    classRunners,
    runner.name,
    runningTime,
    runner.clubId ?? null,
  );

  const classResults = position?.rankedRunners.slice(0, 5) ?? [];

  return {
    runner: {
      id: runner.id,
      name: runner.name,
      cardNo: runner.cardNo,
      startNo: runner.startNo ?? 0,
      clubName: runner.clubName ?? "",
      clubId: runner.clubId ?? null,
      className: cls?.name ?? "",
      classId: runner.classId ?? null,
    },
    timing: {
      startTime,
      finishTime,
      runningTime,
      status,
    },
    controls: [], // No card data available for offline manual finish
    course: course ? { name: course.name, length: course.length } : null,
    position,
    classResults,
  };
}

// ─── Card-read-based readout (with SI punch data) ───────────

export interface CardReadoutInput {
  cardNo: number;
  punches: Array<{ controlCode: number; time: number }>;
  startTime?: number;
  finishTime?: number;
}

/**
 * Compute a full readout offline from SI card punch data + cached competition data.
 * This is the offline equivalent of the server's performReadout + readout endpoint.
 *
 * SI card times are in seconds since midnight. We convert to deciseconds for
 * compatibility with the shared readout functions.
 */
export function computeCardReadout(
  input: CardReadoutInput,
  queryClient: QueryClient,
): (LocalReadoutResult & { matchScore: number; punchesRelevant: boolean }) | null {
  const dashboard = findCachedQuery<DashboardData>(queryClient, "competition.dashboard");
  const runners = findCachedQuery<RunnerListData>(queryClient, "runner.list");

  if (!dashboard || !runners) return null;

  // Find runner by card number
  const runner = runners.find((r: RunnerItem) => r.cardNo === input.cardNo);
  if (!runner) return null;

  // Find class and course
  const cls = dashboard.classes?.find((c: ClassItem) => c.id === runner.classId);
  const course = cls?.courseId
    ? dashboard.courses?.find((c: CourseItem) => c.id === cls.courseId)
    : null;
  // Use the server-resolved per-position descriptors. Status-aware:
  // multi-code controls, Bad/Optional/BadNoTiming skipping, NoTiming /
  // BadNoTiming leg deductions are all baked into this shape.
  const expectedPositions = course?.expectedPositions ?? [];

  // Convert SI card data to ParsedPunch format (seconds → deciseconds)
  const allPunches: ParsedPunch[] = [];

  if (input.startTime && input.startTime > 0) {
    allPunches.push({ type: PUNCH_START, time: input.startTime * 10, source: "card" });
  }
  for (const p of input.punches) {
    allPunches.push({ type: p.controlCode, time: p.time * 10, source: "card" });
  }
  if (input.finishTime && input.finishTime > 0) {
    allPunches.push({ type: PUNCH_FINISH, time: input.finishTime * 10, source: "card" });
  }

  // Use runner's assigned start time as fallback (already in deciseconds from server cache)
  const fallbackStartTime = runner.startTime || 0;

  const { matches, extraPunches, startTime, finishTime, missingCount, runningTimeAdjustment } =
    matchPunchesToCourse(allPunches, expectedPositions, fallbackStartTime);

  const rawRunningTime = finishTime > 0 && startTime > 0 ? finishTime - startTime : 0;
  // Subtract NoTiming/BadNoTiming leg deductions so the offline result
  // matches the canonical (kiosk + admin + results-page) running time.
  const runningTime = Math.max(0, rawRunningTime - runningTimeAdjustment);

  const status = computeStatus({
    finishTime,
    startTime,
    missingCount,
    runningTime,
    classMaxTime: cls?.maxTime ?? 0,
    classNoTiming: cls?.noTiming === 1,
    transferFlags: runner.transferFlags ?? 0,
    currentStatus: runner.status,
  });

  // Compute match score
  const matchedCount = matches.filter((m) => m.status === "ok").length;
  const matchScore = computeMatchScore(expectedPositions.length, matchedCount, input.punches.length, 0);
  const punchesRelevant = matchScore >= 0.2;

  // Compute position from cached runners
  const classRunners: ClassRunnerForPosition[] = runners
    .filter((r: RunnerItem) => r.classId === runner.classId && r.id !== runner.id)
    .map((r: RunnerItem) => ({
      name: r.name,
      clubId: r.clubId ?? null,
      startTime: r.startTime,
      finishTime: r.finishTime,
    }));

  const position = computePosition(
    classRunners,
    runner.name,
    runningTime,
    runner.clubId ?? null,
  );

  const classResults = position?.rankedRunners.slice(0, 5) ?? [];

  return {
    runner: {
      id: runner.id,
      name: runner.name,
      cardNo: runner.cardNo,
      startNo: runner.startNo ?? 0,
      clubName: runner.clubName ?? "",
      clubId: runner.clubId ?? null,
      className: cls?.name ?? "",
      classId: runner.classId ?? null,
    },
    timing: {
      startTime,
      finishTime,
      runningTime,
      status,
    },
    controls: matches,
    course: course ? { name: course.name, length: course.length } : null,
    position,
    classResults,
    matchScore,
    punchesRelevant,
  };
}

/**
 * Look up a runner by card number from cached data.
 * Used by DeviceManager when offline to determine card action.
 */
export function lookupRunnerByCard(
  cardNo: number,
  queryClient: QueryClient,
): RunnerItem | undefined {
  const runners = findCachedQuery<RunnerListData>(queryClient, "runner.list");
  return runners?.find((r: RunnerItem) => r.cardNo === cardNo);
}

// ─── Cache access helpers ───────────────────────────────────

function findCachedQuery<T>(queryClient: QueryClient, key: string): T | undefined {
  // React Query + tRPC stores queries with array keys like [["competition","dashboard"], ...]
  const allQueries = queryClient.getQueryCache().getAll();
  const match = allQueries.find((q) => {
    const k = q.queryKey;
    if (Array.isArray(k) && Array.isArray(k[0])) {
      return k[0].join(".") === key;
    }
    return false;
  });
  return match?.state.data as T | undefined;
}

// ─── Cached data type shapes (matching tRPC query responses) ──

interface DashboardData {
  competition?: { name: string; date?: string; eventorEventId?: number };
  organizer?: { eventorId?: number };
  classes?: ClassItem[];
  courses?: CourseItem[];
  totalControls?: number;
}

interface ClassItem {
  id: number;
  name: string;
  courseId?: number;
  maxTime?: number;
  noTiming?: number;
}

interface CourseItem {
  id: number;
  name: string;
  length: number;
  /** Raw oCourse.Controls Id list (kept for diagnostics). */
  controls: string;
  /**
   * Status-aware per-position descriptors resolved server-side. Used
   * for offline punch matching so the client applies the same MeOS
   * evaluation rules (skipped positions, NoTiming / BadNoTiming leg
   * deductions, Multiple expansion).
   */
  expectedPositions: import("@oxygen/shared").ExpectedPosition[];
}

interface RunnerItem {
  id: number;
  name: string;
  cardNo: number;
  startNo?: number;
  clubName?: string;
  clubId?: number;
  className?: string;
  classId?: number;
  status: number;
  startTime: number;
  finishTime: number;
  transferFlags?: number;
}

type RunnerListData = RunnerItem[];
