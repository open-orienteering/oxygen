/**
 * What the canvas draws of a course with variation groups
 * (docs/course-editor.md §12; docs/course-layer.md §5, §12.7). `course.list`
 * carries the root's mirror (its first alternatives), so the editor draws
 * the course it shows from the structure instead:
 *
 * - Course and Variant view: the displayed path as one linear course — the
 *   numbering, legs and hidden numbers of that path, as the variant prints.
 * - All variations: the spine (the top-level items; across a plain group a
 *   `style: "none"` leg, a loop keeps its anchor → next leg) plus one
 *   tinted branch per alternative — anchor → its controls → the next item
 *   (a loop's petal back to the anchor; an empty plain alternative is the
 *   straight leg, an empty petal draws nothing). Labels are the numbers every
 *   variant shares (F15) when the variants number alike, else codes.
 *
 * Pure; ids are the overlay's (public control ids as strings).
 */

import { course, type PathVertex } from "@oxygen/shared";
import { bendsEqual } from "./bends";

type Structure = course.WireCourseStructure;
type Item = Structure["items"][number];
type Control = Extract<Item, { siteId: number }>;

/** A course as the canvas draws it in place of (or beside) `course.list`'s overlay. */
export interface CourseDraw {
  name: string;
  /** Ordered control ids, start and finish included. */
  controls: string[];
  legs: Record<string, course.CourseLegProps>;
  hiddenNumbers: number[];
  /** All variations: the alternative's label (its tint row, course-layer.md §12.7). */
  tint?: string;
  /** All variations, the spine only (F15): the text of each control when the variants number alike (`course.uniformVariantNumbers`), else absent — codes. */
  labels?: Record<string, string>;
}

/** A wire leg in the layer's form: the crossing point's id as a string (as `layerPropsOfStored`). */
function layerLeg(leg: Control["leg"]): course.CourseLegProps | null {
  if (!leg) return null;
  const { crossing, ...rest } = leg;
  const out: course.CourseLegProps = crossing ? { ...rest, crossing: { ...crossing, controlId: String(crossing.controlId) } } : rest;
  return Object.keys(out).length > 0 ? out : null;
}

/** One linear course from control items in visiting order (a displayed path). */
export function courseDrawOf(name: string, items: readonly Control[], tint?: string): CourseDraw {
  const legs: Record<string, course.CourseLegProps> = {};
  const hidden = new Map<number, boolean>();
  items.forEach((item, i) => {
    hidden.set(item.siteId, (hidden.get(item.siteId) ?? true) && !!item.numberHidden);
    const leg = i > 0 ? layerLeg(item.leg) : null;
    if (leg) legs[`${items[i - 1].siteId}>${item.siteId}`] = leg;
  });
  return {
    name,
    controls: items.map((i) => String(i.siteId)),
    legs,
    hiddenNumbers: [...hidden].filter(([, h]) => h).map(([id]) => id),
    ...(tint ? { tint } : {}),
  };
}

/**
 * The viewer's overlays with the editor's override applied (`MapViewerEditorProps.courseOverride`):
 * the first draw replaces the overlay of its name (its other fields — label offsets, classes, length —
 * kept), the rest are added highlighted. No override: the overlays as given.
 */
export function withCourseOverride<O extends { name: string }>(courses: readonly O[], draws: readonly CourseDraw[] | null): (O | (CourseDraw & { highlight: true }))[] {
  if (!draws || draws.length === 0) return courses as O[];
  const [own, ...extra] = draws;
  const out = courses.map((c) => (c.name === own.name ? { ...c, controls: own.controls, legs: own.legs, hiddenNumbers: own.hiddenNumbers, ...(own.labels ? { labels: own.labels } : {}) } : c));
  return [...out, ...extra.map((d) => ({ ...d, highlight: true as const }))];
}

/**
 * A bend or grip drag in flight on the selected leg (docs/course-editor.md §6.7, F21): its live bends, so the layer
 * redraws the course per move as the write would leave it. Held after the release until `course.list` carries them.
 */
export interface LegDraft {
  /** The overlay's name (the selected course). */
  course: string;
  /** The leg's key in the overlay's `legs`: `"<fromId>><toId>"`. */
  key: string;
  bends: readonly PathVertex[];
}

/**
 * The overlays with the editor's leg draft applied (`MapViewerEditorProps.legDraft`), after the course override: that
 * leg's `bends` replaced on the course of its name (an empty list removes them; an empty leg drops out), its style,
 * gaps, corridor and crossing kept. No draft, or no course of that name: the overlays as given.
 */
export function withLegDraft<O extends { name: string; legs?: Record<string, course.CourseLegProps> }>(courses: readonly O[], draft: LegDraft | null): O[] {
  if (!draft || !courses.some((c) => c.name === draft.course)) return courses as O[];
  return courses.map((c) => {
    if (c.name !== draft.course) return c;
    const legs = { ...c.legs };
    const rest: course.CourseLegProps = { ...legs[draft.key] };
    delete rest.bends;
    const leg: course.CourseLegProps = draft.bends.length > 0 ? { ...rest, bends: [...draft.bends] } : rest;
    if (Object.keys(leg).length > 0) legs[draft.key] = leg;
    else delete legs[draft.key];
    return { ...c, legs };
  });
}

/**
 * The leg draft as the editor page keeps it (§6.7 "Live redraw", F21): the leg it belongs to (`legIdentity`), the undo
 * epoch it was made in, and `live` during the drag or `held` from the release, with the bends drawn under it then.
 */
export type HeldLegDraft = LegDraft & { leg: string; epoch: number } & ({ phase: "live" } | { phase: "held"; from: readonly PathVertex[] | undefined });

/**
 * The leg draft the viewer draws (§6.7 "Live redraw"): none from another undo epoch (undo / redo end it); a live one
 * while its leg is selected; a held one until the drawn leg (`drawn`: the override's own draw, else `course.list`'s)
 * carries the written bends or leaves the ones drawn at the release — the `pendingMoves` rule, so another write never
 * pins a stale draft.
 */
export function shownLegDraftOf(
  draft: HeldLegDraft | null,
  at: { epoch: number; leg: string | null; drawn: (course: string, key: string) => readonly PathVertex[] | undefined },
): HeldLegDraft | null {
  if (!draft || draft.epoch !== at.epoch) return null;
  if (draft.phase === "live") return draft.leg === at.leg ? draft : null;
  const drawn = at.drawn(draft.course, draft.key);
  return bendsEqual(drawn, draft.bends) || !bendsEqual(drawn, draft.from) ? null : draft;
}

/** The branch course's name: unique per group and alternative, never a stored course's. */
export const branchName = (courseName: string, groupId: string, label: string) => `${courseName}#${groupId}/${label}`;

/**
 * All variations (§12): the spine and one tinted branch per drawn alternative (`course.allVariationStructures`, as F8's print).
 * `isNumbered` (a control the layer numbers: role `control`, positioned) lets the spine carry the numbers every variant
 * shares (F15, course-layer.md §12.7); without it, or when the variants number unalike, the labels are codes.
 */
export function allVariationDraws(name: string, s: Structure, isNumbered?: (item: Control) => boolean): CourseDraw[] {
  const { spine, branches } = course.allVariationStructures<Control>(s);
  const numbers = isNumbered ? course.uniformVariantNumbers<Control>(s, isNumbered) : null;
  const labels = numbers && numbers.size > 0 ? Object.fromEntries([...numbers].map(([id, n]) => [String(id), String(n)])) : undefined;
  return [{ ...courseDrawOf(name, spine), ...(labels ? { labels } : {}) }, ...branches.map((b) => courseDrawOf(branchName(name, b.groupId, b.label), b.items, b.label))];
}
