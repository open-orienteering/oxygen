/**
 * In-memory lease state of this process: the events whose checkin barrier is
 * running. Between "the last local entry was shipped" and "the lease was
 * released on both nodes" a race write would land after the barrier counted
 * and never reach the cloud; `assertRaceWritable` refuses it while the set
 * holds the event (review SYNC-08 / SYNC-18). In memory on purpose: a
 * restart ends a barrier, and the retry starts a new one.
 */

// A count per event, not a set: two overlapping checkins of one event (a
// double click, a retry racing the first) must not let the first one to finish
// reopen race writes under the second barrier.
const checkingIn = new Map<bigint, number>();

export function beginCheckin(eventId: bigint): void {
  checkingIn.set(eventId, (checkingIn.get(eventId) ?? 0) + 1);
}

export function endCheckin(eventId: bigint): void {
  const n = (checkingIn.get(eventId) ?? 0) - 1;
  if (n > 0) checkingIn.set(eventId, n);
  else checkingIn.delete(eventId);
}

export function isCheckingIn(eventId: bigint): boolean {
  return checkingIn.has(eventId);
}
