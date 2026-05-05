/**
 * Pure helpers for shaping registration timestamps into chart-friendly
 * series. Kept framework-free so they can be unit-tested without a DOM.
 */

export interface RawEntry {
  /** ISO 8601 timestamp */
  at: string;
  classId: number;
}

export interface SeriesPoint {
  /** Numeric x-coordinate. In `daysBefore` mode this is fractional days
   * before the event (positive = before, 0 = race day, negative = after).
   * In `date` mode this is a Unix timestamp in milliseconds. */
  x: number;
  y: number;
}

export type XAxisMode = "date" | "daysBefore";
export type YAxisMode = "cumulative" | "perDay";

/**
 * Shape a list of raw entry timestamps into a single chart series.
 *
 * - `cumulative` returns one point per entry, with y monotonically
 *   increasing. Entries are assumed already-sorted by `at`; we sort
 *   defensively anyway because the input shape doesn't guarantee it.
 * - `perDay` buckets entries into local-calendar days and returns one
 *   point per non-empty day.
 */
export function buildSeries(
  entries: RawEntry[],
  opts: {
    xAxis: XAxisMode;
    yAxis: YAxisMode;
    /** Race date as YYYY-MM-DD (local) — required for daysBefore axis. */
    eventDate?: string;
    /** Optional: only include entries whose classId is in this set. */
    classIds?: ReadonlySet<number>;
  },
): SeriesPoint[] {
  const filtered = opts.classIds
    ? entries.filter((e) => opts.classIds!.has(e.classId))
    : entries;

  const sorted = [...filtered].sort((a, b) => a.at.localeCompare(b.at));

  if (opts.yAxis === "cumulative") {
    return sorted.map((e, idx) => ({
      x: xCoord(e.at, opts.xAxis, opts.eventDate),
      y: idx + 1,
    }));
  }

  // perDay: bucket by local calendar day
  const byDay = new Map<string, number>();
  for (const e of sorted) {
    const key = localDayKey(e.at);
    byDay.set(key, (byDay.get(key) ?? 0) + 1);
  }
  const points: SeriesPoint[] = [];
  for (const [key, count] of byDay) {
    points.push({
      x: xCoord(`${key}T12:00:00Z`, opts.xAxis, opts.eventDate),
      y: count,
    });
  }
  points.sort((a, b) => a.x - b.x);
  return points;
}

/**
 * "Days before race" for an ISO timestamp. Positive = before, 0 = race day,
 * negative = after. Uses a local-day bucket on both sides to avoid the
 * "23h59m before" off-by-one that timezone math creates near midnight.
 */
export function daysBefore(at: string, eventDate: string): number {
  const t = Date.parse(at);
  const start = new Date(eventDate + "T00:00:00").getTime();
  if (isNaN(t) || isNaN(start)) return 0;
  return (start - t) / 86400000;
}

function xCoord(
  at: string,
  mode: XAxisMode,
  eventDate: string | undefined,
): number {
  if (mode === "daysBefore" && eventDate) {
    return daysBefore(at, eventDate);
  }
  return Date.parse(at);
}

/** Local YYYY-MM-DD key for an ISO timestamp. */
function localDayKey(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "1970-01-01";
  const y = d.getFullYear();
  const m = d.getMonth() + 1;
  const day = d.getDate();
  return `${y}-${String(m).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/**
 * Calendar-day distance between today and a YYYY-MM-DD race date. Positive
 * = race is in the future, 0 = race day, negative = race is past.
 */
export function daysToGo(
  eventDate: string,
  now: Date = new Date(),
): number {
  const start = new Date(eventDate + "T00:00:00").getTime();
  if (isNaN(start)) return 0;
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  return Math.round((start - today) / 86400000);
}

/**
 * Number of registrations that landed in the local calendar day matching
 * `now` — used by the dashboard "today's entries" StatCard.
 */
export function entriesToday(
  entries: RawEntry[],
  now: Date = new Date(),
): number {
  const today = localDayKey(
    new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString(),
  );
  let count = 0;
  for (const e of entries) {
    if (localDayKey(e.at) === today) count++;
  }
  return count;
}
