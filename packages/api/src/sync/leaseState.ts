/**
 * In-memory lease state of this process: the events whose checkin barrier is
 * running. Between "the last local entry was shipped" and "the lease was
 * released on both nodes" a race write would land after the barrier counted
 * and never reach the cloud; `assertRaceWritable` refuses it while the set
 * holds the event (review SYNC-08 / SYNC-18). In memory on purpose: a
 * restart ends a barrier, and the retry starts a new one.
 */

const checkingIn = new Set<bigint>();

export function beginCheckin(eventId: bigint): void {
  checkingIn.add(eventId);
}

export function endCheckin(eventId: bigint): void {
  checkingIn.delete(eventId);
}

export function isCheckingIn(eventId: bigint): boolean {
  return checkingIn.has(eventId);
}
