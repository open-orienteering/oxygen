/**
 * Courses whose computed climb is to be written once the edit that
 * touched them has committed (docs/course-elevation.md §6 "When"). A
 * leaf module: the geometry rebuild marks, the tRPC layer drains.
 * In-memory and per process — the request that marked is the one that
 * drains; anything left (a rolled-back edit, a write outside tRPC) is
 * computed by the event's next mutation or `course.refreshClimbs`.
 */

const pending = new Map<bigint, Set<string>>();

export function markClimbPending(eventId: bigint, courseUuids: readonly string[]): void {
  if (courseUuids.length === 0) return;
  let set = pending.get(eventId);
  if (!set) pending.set(eventId, (set = new Set()));
  for (const id of courseUuids) set.add(id);
}

/** The event's marked courses, cleared. */
export function takeClimbPending(eventId: bigint): string[] {
  const set = pending.get(eventId);
  if (!set) return [];
  pending.delete(eventId);
  return [...set];
}
