/**
 * Course objects attached to a control as the editor shows and writes them
 * (J10; docs/course-editor.md §7 "Attached objects", course-layer.md §8.1
 * "Attachment"). The layer draws an attached object translated by its
 * control's position minus `at`; the editor works on that drawn object
 * (`shownObject`: geometry where it is drawn, `at` the control's position
 * now, so the layer draws it at the same place), and every write that sends
 * geometry sends `at` with it — undo then restores the same offset to the
 * control.
 */

import { course } from "@oxygen/shared";

type Pt = { x: number; y: number };
type CourseObject = course.CourseObject;

/** A drawn site's position by public control id; null when it is not drawn in this view. */
export type SitePosition = (controlId: number) => Pt | null;

/** The object as drawn: an attached one moved by its control's position minus `at` (`at` now that position); null when its control is not drawn. */
export function shownObject(o: CourseObject, pos: SitePosition): CourseObject | null {
  if (!o.attach) return o;
  const p = pos(o.attach.controlId);
  if (!p) return null;
  const dx = p.x - o.attach.at.x, dy = p.y - o.attach.at.y;
  if (dx === 0 && dy === 0) return o;
  return { ...o, geometry: course.translateGeometry(o.geometry, dx, dy), attach: { controlId: o.attach.controlId, at: { x: p.x, y: p.y } } } as CourseObject;
}

/** `shownObject` over a list, the hidden ones left out; an unattached list is returned as it is. */
export function shownObjects(objects: readonly CourseObject[], pos: SitePosition): CourseObject[] {
  if (!objects.some((o) => o.attach)) return objects as CourseObject[];
  return objects.flatMap((o) => shownObject(o, pos) ?? []);
}

/** The point an object is centred on: a text's anchor, else the centre of its vertices' bounds. */
export function objectCentre(o: Pick<CourseObject, "kind" | "geometry">): Pt {
  if (o.kind === "text") return { x: o.geometry[0].x, y: o.geometry[0].y };
  const xs = o.geometry.map((v) => v.x), ys = o.geometry.map((v) => v.y);
  return { x: (Math.min(...xs) + Math.max(...xs)) / 2, y: (Math.min(...ys) + Math.max(...ys)) / 2 };
}

/** The drawn site nearest a point (null without any). */
export function nearestSite<S extends { id: number; x: number; y: number }>(pt: Pt, sites: readonly S[]): S | null {
  let best: S | null = null, bestD = Infinity;
  for (const s of sites) {
    const d = Math.hypot(s.x - pt.x, s.y - pt.y);
    if (d < bestD) { best = s; bestD = d; }
  }
  return best;
}

export interface AttachWrite { geometry: CourseObject["geometry"]; attach: course.CourseObjectAttach<number> | null }

/** *Attach to control*: the object stays where it is drawn, following `site` from now on. */
export function attachPatch(shown: CourseObject, site: { id: number; x: number; y: number }): AttachWrite {
  return { geometry: shown.geometry, attach: { controlId: site.id, at: { x: site.x, y: site.y } } };
}

/** *Centre on control*: moved so its centre is on the control, and attached to it. */
export function centrePatch(shown: CourseObject, site: { id: number; x: number; y: number }): AttachWrite {
  const c = objectCentre(shown);
  return { geometry: course.translateGeometry(shown.geometry, site.x - c.x, site.y - c.y), attach: { controlId: site.id, at: { x: site.x, y: site.y } } };
}

/** *Detach*: kept where it is drawn now, following nothing. */
export function detachPatch(shown: CourseObject): AttachWrite {
  return { geometry: shown.geometry, attach: null };
}
