/**
 * Turn Eventor result lists into a per-runner speed estimate.
 *
 * The goal is answering "who is slow?" well enough to keep those runners off
 * the end of their class in the start draw. Two things make that harder than
 * dividing time by distance:
 *
 *   1. Course length is often missing. Eventor's `results/event` speaks a
 *      2.0.3 dialect that carries no distance at all, and the IOF 3.0
 *      variant only has one if whoever uploaded the results supplied it.
 *   2. Terrain, weather and course setting move everyone's times together,
 *      so raw minutes are not comparable across races.
 *
 * So the primary measure here is length-free: a runner's time divided by the
 * median time in their class that day. 1.0 is exactly average for the field
 * they ran against, 1.6 is 60 percent slower. Across races we take the
 * median of those ratios, because a single bad leg or a long hesitation is
 * not evidence that someone is slow. Pace in min/km is computed too, but
 * only for the races that happen to carry a length.
 *
 * Everything here is pure: XML in, numbers out. The CLI in
 * `scripts/eventor-pace.ts` does the fetching and the printing.
 */

import { XMLParser } from "fast-xml-parser";

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  isArray: (_name, jpath) =>
    [
      "ResultList.ClassResult",
      "ResultList.ClassResult.PersonResult",
    ].includes(String(jpath)),
});

export type ResultStatus =
  | "OK"
  | "MissingPunch"
  | "DidNotFinish"
  | "DidNotStart"
  | "Disqualified"
  | "OverTime"
  | "Cancelled"
  | "NotCompeting"
  | "Unknown";

export interface RaceResult {
  /** Eventor person id. 0 for competitors not in the national database. */
  personId: number;
  name: string;
  clubName: string;
  /** Class id when the list has one, else the class name. */
  classKey: string;
  className: string;
  timeSec: number;
  status: ResultStatus;
  /** Course length for this runner, person-level override applied. 0 = unknown. */
  courseLengthM: number;
  /** Length declared for the class as a whole, before any forking override. */
  classCourseLengthM?: number;
}

export interface ParsedResultList {
  iofVersion: "2.0.3" | "3.0";
  results: RaceResult[];
}

export interface ClassSummary {
  classKey: string;
  className: string;
  finishers: number;
  medianSec: number;
  bestSec: number;
  courseLengthM: number;
}

export interface RunnerRace {
  personId: number;
  className: string;
  timeSec: number;
  /** Time relative to the class median that day. Null when not a finisher. */
  ratio: number | null;
  paceMinPerKm: number | null;
  status: ResultStatus;
}

export interface RunnerAggregate {
  /** Races that produced a usable time. */
  races: number;
  /** Races that did not — mispunch, DNF, DNS. */
  dnf: number;
  ratio: number | null;
  paceMinPerKm: number | null;
}

// ─── Small helpers ───────────────────────────────────────────

function text(val: unknown): string {
  if (val === undefined || val === null) return "";
  if (typeof val === "object") {
    const obj = val as Record<string, unknown>;
    return "#text" in obj ? String(obj["#text"]) : "";
  }
  return String(val);
}

function num(val: unknown): number {
  const n = parseInt(text(val), 10);
  return Number.isNaN(n) ? 0 : n;
}

/**
 * Accepts everything the two dialects throw at us: "mm:ss", "hh:mm:ss",
 * bare seconds, and seconds with a fractional part.
 */
export function parseTimeToSeconds(raw: unknown): number {
  const str = text(raw).trim();
  if (!str) return 0;

  if (str.includes(":")) {
    const parts = str.split(":").map((p) => parseInt(p, 10));
    if (parts.some((p) => Number.isNaN(p))) return 0;
    return parts.reduce((acc, p) => acc * 60 + p, 0);
  }

  const seconds = parseFloat(str);
  return Number.isNaN(seconds) ? 0 : Math.floor(seconds);
}

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

const STATUS_2_0_3: Record<string, ResultStatus> = {
  OK: "OK",
  MisPunch: "MissingPunch",
  DidNotFinish: "DidNotFinish",
  DidNotStart: "DidNotStart",
  Disqualified: "Disqualified",
  OverTime: "OverTime",
  Cancelled: "Cancelled",
  NotCompeting: "NotCompeting",
};

const STATUS_3_0: Record<string, ResultStatus> = {
  ...STATUS_2_0_3,
  MissingPunch: "MissingPunch",
  DidNotEnter: "NotCompeting",
  Moved: "NotCompeting",
  MovedUp: "NotCompeting",
  Inactive: "NotCompeting",
};

/** Length lives in different places depending on dialect and uploader. */
function courseLengthOf(container: Record<string, unknown> | undefined): number {
  if (!container) return 0;
  const course = container.Course as Record<string, unknown> | undefined;
  if (course) {
    const len = num(course.Length);
    if (len > 0) return len;
  }
  return num(container.CourseLength);
}

// ─── Parsing ─────────────────────────────────────────────────

export function parseResultList(xml: string): ParsedResultList {
  const parsed = parser.parse(xml) as Record<string, unknown>;
  const list = (parsed.ResultList ?? {}) as Record<string, unknown>;
  const iofVersion = text(list["@_iofVersion"]).startsWith("3")
    ? ("3.0" as const)
    : ("2.0.3" as const);

  const classResults = (list.ClassResult ?? []) as Record<string, unknown>[];
  const results: RaceResult[] = [];

  for (const cr of classResults) {
    const cls = ((iofVersion === "3.0" ? cr.Class : cr.EventClass) ??
      {}) as Record<string, unknown>;
    const classId =
      iofVersion === "3.0" ? num(cls.Id) : num(cls.EventClassId);
    const className = text(cls.Name) || text(cls.ClassShortName);
    const classKey = classId > 0 ? String(classId) : className;
    const classLength = courseLengthOf(cr);

    const personResults = (cr.PersonResult ?? []) as Record<string, unknown>[];

    for (const pr of personResults) {
      const person = (pr.Person ?? {}) as Record<string, unknown>;
      const nameEl = ((iofVersion === "3.0" ? person.Name : person.PersonName) ??
        {}) as Record<string, unknown>;
      const family = text(nameEl.Family);
      const given = text(nameEl.Given);
      const org = (pr.Organisation ?? {}) as Record<string, unknown>;
      const result = (pr.Result ?? {}) as Record<string, unknown>;

      const timeSec = resultTimeSeconds(result);
      const personLength = courseLengthOf(result);

      results.push({
        personId:
          iofVersion === "3.0" ? num(person.Id) : num(person.PersonId),
        name: family ? `${family}, ${given}`.trim() : given,
        clubName: text(org.Name),
        classKey,
        className,
        timeSec,
        status: statusOf(result, iofVersion),
        courseLengthM: personLength > 0 ? personLength : classLength,
        classCourseLengthM: classLength,
      });
    }
  }

  return { iofVersion, results };
}

function statusOf(
  result: Record<string, unknown>,
  iofVersion: "2.0.3" | "3.0",
): ResultStatus {
  if (iofVersion === "3.0") {
    return STATUS_3_0[text(result.Status)] ?? "Unknown";
  }
  const statusEl = (result.CompetitorStatus ?? {}) as Record<string, unknown>;
  return STATUS_2_0_3[text(statusEl["@_value"])] ?? "Unknown";
}

/**
 * `Time` is authoritative when present. Some 2.0.3 lists omit it and only
 * give the clocks, so fall back to finish minus start.
 */
function resultTimeSeconds(result: Record<string, unknown>): number {
  const direct = parseTimeToSeconds(result.Time);
  if (direct > 0) return direct;

  const start = result.StartTime as Record<string, unknown> | undefined;
  const finish = result.FinishTime as Record<string, unknown> | undefined;
  const startSec = parseTimeToSeconds(start?.Clock ?? start);
  const finishSec = parseTimeToSeconds(finish?.Clock ?? finish);
  return finishSec > startSec ? finishSec - startSec : 0;
}

// ─── Scoring ─────────────────────────────────────────────────

function isFinish(r: { status: ResultStatus; timeSec: number }): boolean {
  return r.status === "OK" && r.timeSec > 0;
}

export function summarizeClasses(
  results: RaceResult[],
): Map<string, ClassSummary> {
  const byClass = new Map<string, RaceResult[]>();
  for (const r of results) {
    const bucket = byClass.get(r.classKey);
    if (bucket) bucket.push(r);
    else byClass.set(r.classKey, [r]);
  }

  const summaries = new Map<string, ClassSummary>();
  for (const [classKey, rows] of byClass) {
    const finishers = rows.filter(isFinish);
    if (finishers.length === 0) continue;

    const times = finishers.map((r) => r.timeSec);
    const declared =
      rows.find((r) => (r.classCourseLengthM ?? 0) > 0)?.classCourseLengthM ??
      rows.find((r) => r.courseLengthM > 0)?.courseLengthM ??
      0;

    summaries.set(classKey, {
      classKey,
      className: rows[0].className,
      finishers: finishers.length,
      medianSec: median(times),
      bestSec: Math.min(...times),
      courseLengthM: declared,
    });
  }
  return summaries;
}

export function toRunnerRaces(
  results: RaceResult[],
  summaries: Map<string, ClassSummary>,
): RunnerRace[] {
  return results.map((r) => {
    const summary = summaries.get(r.classKey);
    const finished = isFinish(r);
    const ratio =
      finished && summary && summary.medianSec > 0
        ? r.timeSec / summary.medianSec
        : null;
    const paceMinPerKm =
      finished && r.courseLengthM > 0
        ? r.timeSec / 60 / (r.courseLengthM / 1000)
        : null;

    return {
      personId: r.personId,
      className: r.className,
      timeSec: r.timeSec,
      ratio,
      paceMinPerKm,
      status: r.status,
    };
  });
}

export function aggregateRunner(races: RunnerRace[]): RunnerAggregate {
  const ratios = races
    .map((r) => r.ratio)
    .filter((v): v is number => v !== null);
  const paces = races
    .map((r) => r.paceMinPerKm)
    .filter((v): v is number => v !== null);

  return {
    races: ratios.length,
    dnf: races.length - ratios.length,
    ratio: ratios.length > 0 ? median(ratios) : null,
    paceMinPerKm: paces.length > 0 ? median(paces) : null,
  };
}

/**
 * Expected finish time on a course of `lengthM`, given the pace an average
 * runner in that class is expected to hold. Returns 0 when we have no basis
 * for a target pace — better a blank column than a fabricated number.
 */
export function predictSeconds(
  ratio: number,
  lengthM: number,
  targetPaceMinPerKm: number,
): number {
  if (targetPaceMinPerKm <= 0 || lengthM <= 0) return 0;
  return Math.round(ratio * (lengthM / 1000) * targetPaceMinPerKm * 60);
}
