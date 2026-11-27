/**
 * A class has one course (WEB-09): what picking a course in the Classes page does.
 * Picking the course it already has changes nothing; changing it asks first when the class has runners, because
 * their variants are cleared or dealt anew (those who have raced keep theirs).
 */
export function courseChange(current: number | null, next: number | null, runnerCount: number): { changed: boolean; confirm: boolean } {
  const changed = (current ?? null) !== (next ?? null);
  return { changed, confirm: changed && runnerCount > 0 };
}
