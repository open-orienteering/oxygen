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
 *   straight leg, an empty petal draws nothing). Labels are codes (several
 *   courses are highlighted).
 *
 * Pure; ids are the overlay's (public control ids as strings).
 */

import { course } from "@oxygen/shared";

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
  const out = courses.map((c) => (c.name === own.name ? { ...c, controls: own.controls, legs: own.legs, hiddenNumbers: own.hiddenNumbers } : c));
  return [...out, ...extra.map((d) => ({ ...d, highlight: true as const }))];
}

/** The branch course's name: unique per group and alternative, never a stored course's. */
export const branchName = (courseName: string, groupId: string, label: string) => `${courseName}#${groupId}/${label}`;

/** All variations (§12): the spine and one tinted branch per drawn alternative (`course.allVariationStructures`, as F8's print). */
export function allVariationDraws(name: string, s: Structure): CourseDraw[] {
  const { spine, branches } = course.allVariationStructures<Control>(s);
  return [courseDrawOf(name, spine), ...branches.map((b) => courseDrawOf(branchName(name, b.groupId, b.label), b.items, b.label))];
}
