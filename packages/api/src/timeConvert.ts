/**
 * Time conversion at the DB boundary.
 *
 * Runner, class and punch times are stored as ZeroTime-relative deciseconds
 * (a layout inherited from MeOS). Oxygen's API speaks absolute deciseconds
 * since the event's local midnight. Relative 0 doubles as "no time", so a
 * real time exactly at ZeroTime cannot be stored: `toRelativeChecked` refuses
 * it on human input. See docs/system/registration-and-readout.md, "Time model".
 */

import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { DAY_DS, dateInZone, timeOfDayDs, DEFAULT_EVENT_TIME_ZONE } from "@oxygen/shared";

/**
 * True if a stored ZeroTime-relative value carries a time. Relative times
 * are negative for anything before ZeroTime, so never test them with `> 0`.
 */
export function hasTime(rel: number | null | undefined): boolean {
  return rel != null && rel !== 0;
}

/**
 * `toRelative` for times typed by a person (or chosen in the draw): refuses a
 * time exactly at ZeroTime, which would read back as "no time".
 */
export function toRelativeChecked(absoluteDs: number, zeroTime: number): number {
  if (absoluteDs > 0 && absoluteDs === zeroTime) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        "ZERO_TIME_COLLISION: a time exactly at the event's zero time cannot be stored. " +
        "Use a time one second later, or move the zero time in the event settings.",
    });
  }
  return toRelative(absoluteDs, zeroTime);
}

/**
 * Convert an absolute time (deciseconds since midnight) to ZeroTime-relative
 * for DB storage. Returns 0 for sentinel "no time" values.
 */
export function toRelative(absoluteDs: number, zeroTime: number): number {
  return absoluteDs > 0 ? absoluteDs - zeroTime : 0;
}

/**
 * `toRelative` for Eventor clock times: the result is wrapped into 0..24 h
 * (what `toAbsolute` undoes), so a finish after midnight stays positive and a
 * clock time that equals ZeroTime is not mistaken for "no time" (a runner's
 * relative 0). Returns 0 for the "no time" sentinel.
 */
export function toRelativeWrapped(absoluteDs: number, zeroTime: number): number {
  if (absoluteDs <= 0) return 0;
  const rel = (((absoluteDs - zeroTime) % DAY_DS) + DAY_DS) % DAY_DS;
  return rel === 0 ? 1 : rel;
}

/**
 * Wire schema for an absolute time of day in deciseconds since local
 * midnight: 0 ("no time") up to one day minus a decisecond, the same bound as
 * `event.create`'s `firstStart`. A value outside it can never be a clock
 * time and would be stored as a nonsense ZeroTime-relative time (RES-24).
 */
export const absoluteTimeSchema = z
  .number()
  .int()
  .min(0)
  .max(DAY_DS - 1);

/**
 * ZeroTime for an event imported with results: one hour before the earliest
 * start, rounded down to the hour, never below midnight. Without a start the
 * default (09:00) stays.
 */
export function zeroTimeForResults(startTimes: Iterable<number>, fallback: number): number {
  let earliest = Infinity;
  for (const t of startTimes) if (t > 0 && t < earliest) earliest = t;
  if (!Number.isFinite(earliest)) return fallback;
  const hour = 36000;
  return Math.max(0, Math.floor(earliest / hour) * hour - hour);
}

/**
 * Convert a ZeroTime-relative time from DB storage to absolute deciseconds
 * since midnight. Handles wraparound for events crossing midnight.
 * Returns 0 for sentinel "no time" values.
 */
export function toAbsolute(relativeDs: number, zeroTime: number): number {
  if (relativeDs === 0) return 0;
  return ((relativeDs + zeroTime) % DAY_DS + DAY_DS) % DAY_DS;
}

/**
 * Today's date in the event's time zone as a YYYYMMDD integer (the
 * `runners.entry_date` format). Optional `now` for deterministic testing.
 */
export function nowMeosDate(now: Date = new Date(), timeZone: string = DEFAULT_EVENT_TIME_ZONE): number {
  return dateInZone(now.getTime(), timeZone);
}

/**
 * Current time of day in the event's time zone as whole-second deciseconds
 * since midnight (the `runners.entry_time` format).
 */
export function nowMeosTime(now: Date = new Date(), timeZone: string = DEFAULT_EVENT_TIME_ZONE): number {
  return Math.floor(timeOfDayDs(now.getTime(), timeZone) / 10) * 10;
}

/**
 * Convert MeOS-format `(EntryDate, EntryTime)` (YYYYMMDD int + deciseconds
 * since midnight) into a JavaScript `Date` interpreted as local time.
 *
 * Returns null if `entryDate` is the sentinel zero, since that indicates
 * the row carries no recorded entry timestamp.
 */
export function meosEntryToDate(
  entryDate: number,
  entryTime: number,
): Date | null {
  if (entryDate <= 0) return null;
  const y = Math.floor(entryDate / 10000);
  const m = Math.floor((entryDate % 10000) / 100);
  const d = entryDate % 100;
  if (y < 1900 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const totalSeconds = Math.max(0, Math.floor(entryTime / 10));
  const h = Math.floor(totalSeconds / 3600) % 24;
  const min = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  return new Date(y, m - 1, d, h, min, s);
}

/** The event's IANA zone, falling back to the default for partial refs. */
export function eventTimeZone(event: { timeZone?: string | null }): string {
  return event.timeZone || DEFAULT_EVENT_TIME_ZONE;
}

/**
 * The current time of day at the event (deciseconds since the event's local
 * midnight). Use this, never `Date#getHours`, which reads the process zone.
 */
export function eventNowDs(event: { timeZone?: string | null }, nowMs: number = Date.now()): number {
  return timeOfDayDs(nowMs, eventTimeZone(event));
}

/**
 * "Has started" by the clock: the runner has a start time (relative, may be
 * before ZeroTime) and it has passed. Relative 1 is the "drawn, start time
 * not set" marker and counts as started.
 */
export function hasStartedByClock(relStart: number, zeroTime: number, nowDs: number): boolean {
  if (!hasTime(relStart)) return false;
  if (relStart === 1) return true;
  return nowDs >= toAbsolute(relStart, zeroTime);
}
