/**
 * The control ids the map viewer's course list carries for one course:
 * start?, the course's controls, finish? (docs/course-editor.md §6.1,
 * row P5). The course layer request splices the armed tool's provisional
 * visit into this list, so a course whose start is missing here draws no
 * pending leg from it.
 */
import { effectiveRoleControlId } from "./course-editor";

/** The slice of `CourseSummary` (`course.list`) the overlay reads. */
export interface OverlayCourse {
  /** ";"-separated public ids of the course's controls (the middle). */
  controls: string;
  startControlId: number | null;
  finishControlId: number | null;
  firstAsStart: boolean;
  lastAsFinish: boolean;
}

/** A `course.controlCoordinates` row: wire status 4 = start, 5 = finish. */
export interface OverlayControl {
  id: number;
  status: number;
  mapX: number;
  mapY: number;
}

/**
 * Resolve one end of a course: the explicit id when it names a live
 * control of the role; else, for a legacy course with controls, the one
 * nearest its first (start) or last (finish) positioned control; else the
 * event default of docs/course-layer.md §6.2 (lowest id). `null` when the
 * event has no control of the role.
 */
function resolveEnd(
  controls: readonly OverlayControl[],
  role: "start" | "finish",
  explicitId: number | null,
  neighbourId: string | undefined,
): number | null {
  const status = role === "start" ? 4 : 5;
  const candidates = controls.filter((c) => c.status === status);
  if (candidates.length === 0) return null;
  if (explicitId != null && candidates.some((c) => c.id === explicitId)) return explicitId;
  const neighbour =
    neighbourId === undefined ? undefined : controls.find((c) => String(c.id) === neighbourId);
  if (neighbour) {
    let best = candidates[0];
    let bestDist = Infinity;
    for (const c of candidates) {
      const d = (c.mapX - neighbour.mapX) ** 2 + (c.mapY - neighbour.mapY) ** 2;
      if (d < bestDist) {
        bestDist = d;
        best = c;
      }
    }
    return best.id;
  }
  return effectiveRoleControlId(candidates, role, null);
}

/**
 * Start?, the course's controls, finish? as string ids. The start and
 * finish are listed whatever the control count, so a course that has only
 * a start already joins the armed `K` tool's provisional visit. No start
 * under `firstAsStart`, no finish under `lastAsFinish`; an end already at
 * the head or tail of the controls is not repeated.
 */
export function courseOverlayIds(
  course: OverlayCourse,
  controls: readonly OverlayControl[],
): string[] {
  const ids = course.controls.split(";").filter(Boolean);
  const start = course.firstAsStart
    ? null
    : resolveEnd(controls, "start", course.startControlId, ids[0]);
  const finish = course.lastAsFinish
    ? null
    : resolveEnd(controls, "finish", course.finishControlId, ids.at(-1));
  const out = [...ids];
  if (start != null && out[0] !== String(start)) out.unshift(String(start));
  if (finish != null && out.at(-1) !== String(finish)) out.push(String(finish));
  return out;
}
