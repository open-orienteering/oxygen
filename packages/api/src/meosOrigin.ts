/**
 * MeOS-compatible `oPunch.Origin` checksum.
 *
 * MeOS uses a deterministic hash of (absolute time × control code) to mark a
 * punch as "original" — i.e. inserted from a trusted source (online input,
 * card readout) and not subsequently edited. When MeOS later re-opens the
 * record, it recomputes the hash and compares; mismatch means the punch was
 * tampered with and is shown as such in the UI.
 *
 * For Oxygen to remain bidirectionally compatible with MeOS (AGENTS.md §7),
 * any punch we insert from a trusted source must use the same hash so MeOS
 * sees it as `isOriginal()`. Manually entered or hand-edited punches keep
 * the existing convention: `Origin = 0` (manual) or `Origin = -1` (edited).
 *
 * Ported verbatim from MeOS `code/oPunch.cpp:321-330`:
 *
 *     int oPunch::computeOrigin(int time, int code) {
 *       if (time <= 0 || code <= 0) return false;
 *       static_assert(timeConstHour == 36000);
 *       time = time % (36000 * 24 * 7);
 *       code = code % 29;
 *       uint64_t xcode = (time * 29 + code) * 7;
 *       assert(xcode > 0 && xcode < 1300000000);
 *       return (xcode * 53458ul) % origin_key;
 *     }
 *
 * `origin_key = 1300602071` (oPunch.cpp:318).
 */

const ORIGIN_KEY = 1300602071n;
// MeOS deciseconds-per-hour is 36000; week = 36000 * 24 * 7
const WEEK_DS = 36000 * 24 * 7;

/**
 * Compute the MeOS-compatible Origin checksum for a punch.
 *
 * @param absoluteTimeDs Absolute deciseconds since midnight (the MeOS
 *   `oPunch.Time` field is ZeroTime-relative, so callers must add ZeroTime
 *   before invoking this function).
 * @param code The punch type code stored in `oPunch.Type`. For special
 *   punches (start=1, finish=2, check=3) the same enum is used.
 * @returns A non-negative integer hash, or 0 if either input is non-positive.
 */
export function computeOrigin(absoluteTimeDs: number, code: number): number {
  if (absoluteTimeDs <= 0 || code <= 0) return 0;
  const t = BigInt(absoluteTimeDs % WEEK_DS);
  const c = BigInt(code % 29);
  const xcode = (t * 29n + c) * 7n;
  return Number((xcode * 53458n) % ORIGIN_KEY);
}
