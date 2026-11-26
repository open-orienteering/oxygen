/**
 * Time-of-day, running-time and time-input helpers.
 *
 * Oxygen speaks absolute deciseconds since local midnight in the API. "Local"
 * means the event's own IANA time zone (`events.time_zone`), never the time
 * zone of the server process or the browser: the Docker and Cloud Run images
 * run in UTC, and one cloud instance serves events in several zones.
 */

/** 24 hours in deciseconds. */
export const DAY_DS = 864000;

/** Default event time zone (Oxygen's home market). */
export const DEFAULT_EVENT_TIME_ZONE = "Europe/Stockholm";

const partsFormatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let f = partsFormatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-GB", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    partsFormatters.set(timeZone, f);
  }
  return f;
}

/** True if `timeZone` is an IANA zone the runtime knows. */
export function isValidTimeZone(timeZone: string): boolean {
  if (!timeZone) return false;
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone });
    return true;
  } catch {
    return false;
  }
}

function zoneParts(epochMs: number, timeZone: string) {
  const out = { year: 0, month: 0, day: 0, hour: 0, minute: 0, second: 0 };
  for (const p of formatterFor(timeZone).formatToParts(new Date(epochMs))) {
    if (p.type in out) out[p.type as keyof typeof out] = Number(p.value);
  }
  // Some runtimes render midnight as 24 even with h23.
  if (out.hour === 24) out.hour = 0;
  return out;
}

/**
 * Time of day at `epochMs` in `timeZone`, as deciseconds since that zone's
 * midnight. Sub-second precision is kept (tenths).
 */
export function timeOfDayDs(epochMs: number, timeZone: string): number {
  const p = zoneParts(epochMs, timeZone);
  const tenths = Math.floor((((epochMs % 1000) + 1000) % 1000) / 100);
  return (p.hour * 3600 + p.minute * 60 + p.second) * 10 + tenths;
}

/** Calendar date at `epochMs` in `timeZone`, as a YYYYMMDD integer. */
export function dateInZone(epochMs: number, timeZone: string): number {
  const p = zoneParts(epochMs, timeZone);
  return p.year * 10000 + p.month * 100 + p.day;
}

/**
 * Running time from two absolute clock times (deciseconds since midnight).
 * 0 when either is missing (0). A finish earlier than the start is read as a
 * run across midnight, so 23:30 → 00:20 is 50 minutes, not 0.
 */
export function runningTimeDs(startAbs: number, finishAbs: number): number {
  if (startAbs <= 0 || finishAbs <= 0) return 0;
  return (((finishAbs - startAbs) % DAY_DS) + DAY_DS) % DAY_DS;
}

/**
 * Strict parser for a clock time typed by a person. Accepts `H:MM`,
 * `H:MM:SS`, `H.MM`, `H.MM.SS` and the compact `HHMM` / `HHMMSS`. Returns
 * deciseconds since midnight, or null for anything else (empty, one part,
 * out of range, trailing junk). Never returns 0 for bad input, so a
 * half-typed value cannot clear a stored time.
 */
export function parseClockTime(input: string): number | null {
  const s = input.trim();
  let h: number, m: number, sec = 0;
  let match = /^(\d{1,2})[:.](\d{2})(?:[:.](\d{2}))?$/.exec(s);
  if (match) {
    h = Number(match[1]);
    m = Number(match[2]);
    if (match[3] !== undefined) sec = Number(match[3]);
  } else if ((match = /^(\d{2})(\d{2})(\d{2})?$/.exec(s))) {
    h = Number(match[1]);
    m = Number(match[2]);
    if (match[3] !== undefined) sec = Number(match[3]);
  } else {
    return null;
  }
  if (h > 23 || m > 59 || sec > 59) return null;
  return (h * 3600 + m * 60 + sec) * 10;
}

/**
 * Strict parser for a duration typed by a person, in deciseconds, or null.
 *
 * - A bare number is minutes (`"150"` → 2 h 30 min, `"2"` → 2 min).
 * - Three parts are always `H:MM:SS`.
 * - Two parts depend on the field: `"hm"` reads `H:MM` (max time:
 *   `"2:30"` is 2 h 30 min), `"ms"` reads `M:SS` (start interval:
 *   `"1:30"` is 90 s).
 */
export function parseDuration(input: string, twoPart: "hm" | "ms"): number | null {
  const s = input.trim();
  if (/^\d+$/.test(s)) return Number(s) * 600;
  let match = /^(\d+):(\d{2}):(\d{2})$/.exec(s);
  if (match) {
    const [h, m, sec] = [Number(match[1]), Number(match[2]), Number(match[3])];
    if (m > 59 || sec > 59) return null;
    return (h * 3600 + m * 60 + sec) * 10;
  }
  match = /^(\d+):(\d{2})$/.exec(s);
  if (match) {
    const [a, b] = [Number(match[1]), Number(match[2])];
    if (b > 59) return null;
    return twoPart === "hm" ? (a * 3600 + b * 60) * 10 : (a * 60 + b) * 10;
  }
  return null;
}
