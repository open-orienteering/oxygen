/**
 * Local readout computation for offline finish station.
 * Uses cached React Query data + shared readout logic.
 *
 * Two modes:
 * - computeLocalReadout: for manual finish (no card punch data)
 * - computeCardReadout: for SI card read (full punch data available)
 */

import type { QueryClient } from "@tanstack/react-query";
import { cacheOwner } from "./cache-scope";
import {
  matchPunchesToCourse,
  computeStatus,
  computePosition,
  computeMatchScore,
  findMatchingVariants,
  type OtherVariantMatch,
  type VariantCandidate,
  type ParsedPunch,
  type ControlMatch,
  type ClassRunnerForPosition,
  type PositionResult,
  PUNCH_START,
  PUNCH_FINISH,
  RunnerStatus,
  runningTimeDs,
  finishLegOf,
} from "@oxygen/shared";

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
  /** The receipt's finish leg (CRS-013); absent without card punches. */
  finish?: { splitTime: number; legLength: number };
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
  nameId?: string | null,
): LocalReadoutResult | null {
  if (!cacheBelongsTo(queryClient, nameId)) return null;
  // Get cached data from React Query
  // These are the shapes returned by tRPC queries, accessed via their cache keys
  const dashboard = findCachedQuery<DashboardData>(queryClient, "competition.dashboard");
  const runners = findCachedQuery<RunnerListData>(queryClient, "runner.list");

  if (!dashboard || !runners) return null;

  // Find the runner
  const runner = runners.find((r: RunnerItem) => r.id === runnerId);
  if (!runner) return null;

  // Find class and course: the runner's own (her variant) before the class's
  const cls = dashboard.classes?.find((c: ClassItem) => c.id === runner.classId);
  const course = courseOf(runner, cls, dashboard);

  // No-op for the manual-finish path (no card data → no matching). Kept
  // here only so future telemetry can report course length etc.
  void course;

  // We may not have the card punch data cached locally.
  // For a manual finish (FinishStation), we don't have SI card punches —
  // the runner's punches come from the oCard table (storeReadout).
  // For offline, we do our best with what we have.
  // If no card data: we can still compute basic result (time-only, no splits).

  const startTime = runner.startTime || 0;
  // Absolute clock times: a run across midnight still has a time (RES-16).
  const runningTime = finishTime > 0 && startTime > 0 ? runningTimeDs(startTime, finishTime) : 0;

  const status = computeStatus({
    finishTime,
    startTime,
    missingCount: 0, // We don't know without card data
    runningTime,
    classMaxTime: cls?.maxTime ?? 0,
    classNoTiming: cls?.noTiming === true,
    transferFlags: runner.transferFlags ?? 0,
    currentStatus: runner.status,
  });

  // Position among the class's OK runners, and only for an OK result
  // (RES-20 / CRS-045).
  const classRunners: ClassRunnerForPosition[] = runners
    .filter((r: RunnerItem) => r.classId === runner.classId && r.id !== runnerId && r.status === RunnerStatus.OK)
    .map((r: RunnerItem) => ({
      name: r.name,
      clubId: r.clubId ?? null,
      startTime: r.startTime,
      finishTime: r.finishTime,
    }));

  const position = status === RunnerStatus.OK
    ? computePosition(classRunners, runner.name, runningTime, runner.clubId ?? null)
    : null;

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
  nameId?: string | null,
): (LocalReadoutResult & {
  matchScore: number;
  punchesRelevant: boolean;
  /** The other pooled variants the punches validate fully against (F6c); on MP only. */
  otherVariantMatches: OtherVariantMatch[];
}) | null {
  if (!cacheBelongsTo(queryClient, nameId)) return null;
  const dashboard = findCachedQuery<DashboardData>(queryClient, "competition.dashboard");
  const runners = findCachedQuery<RunnerListData>(queryClient, "runner.list");

  if (!dashboard || !runners) return null;

  // Find runner by card number
  const runner = runners.find((r: RunnerItem) => r.cardNo === input.cardNo);
  if (!runner) return null;

  // Find class and course: the runner's own (her variant) before the class's
  const cls = dashboard.classes?.find((c: ClassItem) => c.id === runner.classId);
  const course = courseOf(runner, cls, dashboard);
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

  const { matches, startTime, finishTime, missingCount, runningTimeAdjustment } =
    matchPunchesToCourse(allPunches, expectedPositions, fallbackStartTime, {
      orderMode: course?.orderMode ?? "ordered",
    });

  const rawRunningTime = finishTime > 0 && startTime > 0 ? runningTimeDs(startTime, finishTime) : 0;
  // Subtract NoTiming/BadNoTiming leg deductions so the offline result
  // matches the canonical (kiosk + admin + results-page) running time.
  const runningTime = Math.max(0, rawRunningTime - runningTimeAdjustment);

  const status = computeStatus({
    finishTime,
    startTime,
    missingCount,
    runningTime,
    classMaxTime: cls?.maxTime ?? 0,
    classNoTiming: cls?.noTiming === true,
    transferFlags: runner.transferFlags ?? 0,
    currentStatus: runner.status,
  });

  // Red exit (F6c): on MP in a pooled class, the other variants the
  // punches validate fully against — the server's helper, the same rule.
  const poolIds = cls?.coursePoolIds ?? [];
  const candidates: VariantCandidate[] =
    status === RunnerStatus.MissingPunch && poolIds.length >= 2
      ? poolIds
          .filter((id) => id !== course?.id)
          .map((id) => dashboard.courses?.find((c: CourseItem) => c.id === id))
          .filter((c): c is CourseItem => !!c)
          .map((c) => ({
            courseId: c.id,
            variantKey: c.variantKey ?? "",
            courseName: c.name,
            orderMode: c.orderMode,
            expectedPositions: c.expectedPositions ?? [],
          }))
      : [];
  const otherVariantMatches = findMatchingVariants(allPunches, candidates, { fallbackStartTime });

  // Compute match score
  const matchedCount = matches.filter((m) => m.status === "ok").length;
  const matchScore = computeMatchScore(expectedPositions.length, matchedCount, input.punches.length, 0);
  const punchesRelevant = matchScore >= 0.2;

  // Position among the class's OK runners, and only for an OK result
  // (RES-20 / CRS-045).
  const classRunners: ClassRunnerForPosition[] = runners
    .filter((r: RunnerItem) => r.classId === runner.classId && r.id !== runner.id && r.status === RunnerStatus.OK)
    .map((r: RunnerItem) => ({
      name: r.name,
      clubId: r.clubId ?? null,
      startTime: r.startTime,
      finishTime: r.finishTime,
    }));

  const position = status === RunnerStatus.OK
    ? computePosition(classRunners, runner.name, runningTime, runner.clubId ?? null)
    : null;

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
    // No leg lengths in the offline cache: split only.
    finish: finishLegOf(matches, startTime, finishTime, [], course?.orderMode ?? "ordered"),
    course: course ? { name: course.name, length: course.length } : null,
    position,
    classResults,
    matchScore,
    punchesRelevant,
    otherVariantMatches,
  };
}

/**
 * Look up a runner by card number from cached data.
 * Used by DeviceManager when offline to determine card action.
 */
export function lookupRunnerByCard(
  cardNo: number,
  queryClient: QueryClient,
  nameId?: string | null,
): RunnerItem | undefined {
  if (!cacheBelongsTo(queryClient, nameId)) return undefined;
  const runners = findCachedQuery<RunnerListData>(queryClient, "runner.list");
  return runners?.find((r: RunnerItem) => r.cardNo === cardNo);
}

/**
 * The course a runner is matched against: her own (`runner.courseId`, a
 * variant of a forked course — docs/course-controls-and-matching.md
 * "Forked courses and variants") before her class's, as the server's
 * `performReadout` does.
 */
export function courseOf(
  runner: Pick<RunnerItem, "courseId">,
  cls: Pick<ClassItem, "courseId"> | undefined,
  dashboard: Pick<DashboardData, "courses">,
): CourseItem | null {
  const id = runner.courseId || cls?.courseId;
  return id ? (dashboard.courses?.find((c: CourseItem) => c.id === id) ?? null) : null;
}

// ─── Cache access helpers ───────────────────────────────────

/**
 * The cached value of an event-scoped query with no input. tRPC keys are
 * `[["runner","list"], {type:"query"}]` for `undefined` input and
 * `[..., {input, type}]` otherwise, so a filtered `runner.list({search})`
 * result (a subset) must never be taken for the full list (MC-19 / BLD-24).
 * `undefined`/`{}` inputs qualify; entries without data are skipped; the
 * freshest wins.
 */
function findCachedQuery<T>(queryClient: QueryClient, key: string): T | undefined {
  let best: { at: number; data: T } | undefined;
  for (const q of queryClient.getQueryCache().getAll()) {
    const k = q.queryKey;
    if (!Array.isArray(k) || !Array.isArray(k[0]) || k[0].join(".") !== key) continue;
    const opts = k[1] as { input?: unknown } | undefined;
    const input = opts?.input;
    const noInput =
      input === undefined ||
      (typeof input === "object" && input !== null && Object.keys(input).length === 0);
    if (!noInput || q.state.data === undefined) continue;
    if (!best || q.state.dataUpdatedAt > best.at) {
      best = { at: q.state.dataUpdatedAt, data: q.state.data as T };
    }
  }
  return best?.data;
}

/**
 * True when the cache may be read for `nameId`: it is claimed by that event.
 * Callers that know the event pass it; a cache owned by another event (or by
 * none) yields no local result rather than the wrong runner (MC-04).
 */
export function cacheBelongsTo(queryClient: QueryClient, nameId: string | null | undefined): boolean {
  return nameId === undefined || (nameId !== null && cacheOwner(queryClient) === nameId);
}

// ─── Cached data type shapes (matching tRPC query responses) ──

export interface DashboardData {
  competition?: { name: string; date?: string; eventorEventId?: number };
  organizer?: { eventorId?: number };
  classes?: ClassItem[];
  courses?: CourseItem[];
  totalControls?: number;
}

export interface ClassItem {
  id: number;
  name: string;
  courseId?: number;
  /** Deciseconds, 0 / absent = none (sent by the dashboard, RES-20). */
  maxTime?: number;
  /** The dashboard sends a boolean (`ClassInfo.noTiming`). */
  noTiming?: boolean;
  /** The class's variant pool (course seqs, key order); absent / [] = none (F6c). */
  coursePoolIds?: number[];
}

export interface CourseItem {
  id: number;
  name: string;
  length: number;
  /** Raw oCourse.Controls Id list (kept for diagnostics). */
  controls: string;
  /** Visit-order mode from the dashboard cache. */
  orderMode?: import("@oxygen/shared").CourseOrderMode;
  /**
   * Status-aware per-position descriptors resolved server-side. Used
   * for offline punch matching so the client applies the same MeOS
   * evaluation rules (skipped positions, NoTiming / BadNoTiming leg
   * deductions, Multiple expansion).
   */
  expectedPositions: import("@oxygen/shared").ExpectedPosition[];
  /** A variant child's key; null / absent for a root or a plain course. */
  variantKey?: string | null;
}

export interface RunnerItem {
  id: number;
  name: string;
  cardNo: number;
  startNo?: number;
  clubName?: string;
  clubId?: number;
  className?: string;
  classId?: number;
  /** The runner's own course seq (her variant); 0 / absent = the class's. */
  courseId?: number;
  status: number;
  startTime: number;
  finishTime: number;
  transferFlags?: number;
}

type RunnerListData = RunnerItem[];
