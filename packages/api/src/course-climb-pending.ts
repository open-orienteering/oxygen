/**
 * Courses whose computed climb is to be written once the edit that
 * touched them has committed (docs/course-elevation.md §6 "When"). A
 * leaf module: the geometry rebuild marks, the tRPC layer drains.
 *
 * Marks belong to the request that made them: `withClimbMarks` opens a
 * scope (AsyncLocalStorage) and hands the marks to its caller when the
 * work is done, so another request can never take an edit's marks before
 * that edit has committed. A mark made outside a scope is dropped — the
 * course's climb is then empty until the event's next edit of it or
 * `course.refreshClimbs`.
 */

import { AsyncLocalStorage } from "node:async_hooks";

/** Per event: the marked courses, or "all" for every course of the event. */
export type ClimbMarks = Map<bigint, Set<string> | "all">;

const scope = new AsyncLocalStorage<ClimbMarks>();

export function markClimbPending(eventId: bigint, courseUuids: readonly string[] | "all"): void {
  const marks = scope.getStore();
  if (!marks) return;
  if (courseUuids === "all") {
    marks.set(eventId, "all");
    return;
  }
  if (courseUuids.length === 0) return;
  const set = marks.get(eventId);
  if (set === "all") return;
  const ids = set ?? new Set<string>();
  if (!set) marks.set(eventId, ids);
  for (const id of courseUuids) ids.add(id);
}

/** Runs `fn` in a fresh scope; returns its result and the marks made in it. */
export async function withClimbMarks<T>(fn: () => Promise<T>): Promise<{ result: T; marks: ClimbMarks }> {
  const marks: ClimbMarks = new Map();
  const result = await scope.run(marks, fn);
  return { result, marks };
}

/** Runs `fn` outside the request's marks scope: a background job that outlives the request must not add to its marks. */
export function outsideClimbMarks<T>(fn: () => T): T {
  return scope.exit(fn);
}
