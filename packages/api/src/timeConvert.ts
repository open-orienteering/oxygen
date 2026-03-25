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
