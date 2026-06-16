/**
 * Pure helper that decides which forked course variant(s) the course overlay
 * should draw, based on the currently visible runners and the "show all forks"
 * toggle.
 *
 * Rules (forked relay legs only — a non-forked event always returns its single
 * course as the primary fork):
 *  - All visible runners share one fork  -> that fork is the `primaryFork`
 *    (drawn in detail with sequence numbers).
 *  - Visible runners span multiple forks -> no primary; the `unionForks` are
 *    drawn merged (control codes, no sequence numbers).
 *  - `showAllForks` overlays every fork in the leg: when there is a single
 *    primary fork it is highlighted on top of a faint union of the rest;
 *    otherwise the full union is drawn.
 */

import type { ReplayCourse } from "@oxygen/shared";

export interface ForkSelection {
  /** Fork drawn in detail (clipped lines + sequential control numbers). */
  primaryFork: ReplayCourse | null;
  /** Forks drawn merged (deduped circles, control-code labels). */
  unionForks: ReplayCourse[];
  /** Draw the union faint because a primary fork sits highlighted on top. */
  unionFaint: boolean;
}

export function selectForks(
  courses: ReplayCourse[],
  /** participantId -> courseId for runners whose fork is known. */
  forkByParticipant: Map<string, string>,
  visibleParticipants: Iterable<string>,
  showAllForks: boolean,
): ForkSelection {
  // Non-forked event: the single course is always the primary.
  if (courses.length <= 1) {
    return { primaryFork: courses[0] ?? null, unionForks: [], unionFaint: false };
  }

  const byId = new Map(courses.map((c) => [c.id, c]));
  const activeIds = new Set<string>();
  for (const pid of visibleParticipants) {
    const cid = forkByParticipant.get(pid);
    if (cid && byId.has(cid)) activeIds.add(cid);
  }
  const activeForks = courses.filter((c) => activeIds.has(c.id));
  const primary = activeForks.length === 1 ? activeForks[0] : null;

  if (primary && !showAllForks) {
    return { primaryFork: primary, unionForks: [], unionFaint: false };
  }
  if (primary && showAllForks) {
    return {
      primaryFork: primary,
      unionForks: courses.filter((c) => c.id !== primary.id),
      unionFaint: true,
    };
  }

  // No single active fork (multiple or none visible).
  const union = showAllForks || activeForks.length === 0 ? courses : activeForks;
  return { primaryFork: null, unionForks: union, unionFaint: false };
}
