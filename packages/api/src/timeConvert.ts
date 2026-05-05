/**
 * Time conversion utilities for MeOS compatibility.
 *
 * MeOS stores all times (oRunner.StartTime/FinishTime, oCard.Punches, oPunch.Time)
 * as ZeroTime-relative deciseconds. Oxygen's API speaks absolute deciseconds
 * (since midnight). These helpers convert at the DB boundary.
 */

const DAY_DS = 864000; // 24 hours in deciseconds

/**
 * Convert an absolute time (deciseconds since midnight) to ZeroTime-relative
 * for DB storage. Returns 0 for sentinel "no time" values.
 */
export function toRelative(absoluteDs: number, zeroTime: number): number {
  return absoluteDs > 0 ? absoluteDs - zeroTime : 0;
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
 * Today's local date as a YYYYMMDD integer — the format MeOS uses for
 * `oRunner.EntryDate`. Optional `now` for deterministic testing.
 */
export function nowMeosDate(now: Date = new Date()): number {
  const y = now.getFullYear();
  const m = now.getMonth() + 1;
  const d = now.getDate();
  return y * 10000 + m * 100 + d;
}

/**
 * Current local time-of-day as deciseconds since midnight — the format MeOS
 * uses for `oRunner.EntryTime`. Optional `now` for deterministic testing.
 */
export function nowMeosTime(now: Date = new Date()): number {
  return (now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds()) * 10;
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
