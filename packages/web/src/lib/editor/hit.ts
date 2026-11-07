/**
 * What the editor's pointer is on (docs/course-editor.md §5): the course
 * layer's symbolised shapes, hit-tested on the shared stage
 * (`render.hitTest`, docs/map-rendering.md §5.5) over the hit index the
 * worker returns with every course reply — no SVG hit targets, no GPU
 * readback, synchronous on pointer-down.
 *
 * Off-course controls the editor fades are not in the layer (the UI layer
 * draws them, §5.4 "Overlay"), so they are passed as plain circles and
 * lose to any layer object at the same point. Closed course objects hit by
 * their outline only (`UiArea`): the toner saver covers every control, and a
 * press inside an area pans the map (docs/bugfix-editor-area-press-pans.md).
 */

import { render } from "@oxygen/shared";
import type { CourseHitIndex } from "../../map-gl/worker";

type Pt = { x: number; y: number };

export type EditorTarget =
  | { kind: "site"; id: string }
  | { kind: "number"; id: string }
  | { kind: "leg"; courseId: string; index: number }
  /** A course object (docs/course-editor.md §7) by its public id (`seq`). */
  | { kind: "object"; id: number };

/** A site the UI layer draws (faded, not in the course layer): its centre and circle radius, paper mm. */
export interface UiSite {
  id: string;
  x: number;
  y: number;
  radiusMm: number;
}

/**
 * A closed course object — `oob_area`, `whiteout`, `toner_saver`,
 * `filter_region` (`vertexRule(kind).closed`) — by its sampled outline,
 * paper mm. It hits only along that outline, below everything else; its
 * interior is the map, so a press there pans (§5, §7). The layer's own
 * passes for it (fill, hatch, a 709.b border) are passed over: inside them
 * the layer answers distance 0.
 */
export interface UiArea {
  id: number;
  ring: readonly Pt[];
}

/**
 * A leg the layer draws no line for (`style: "none"`, course-layer.md
 * §10.1 — no object, so no hit-index piece): its derived pieces, paper mm.
 * It hits within the tolerance of them, after the layer's objects and the
 * UI sites, before the UI areas (docs/course-editor.md §5, §6.7).
 */
export interface UiLeg {
  courseId: string;
  index: number;
  pieces: readonly (readonly Pt[])[];
}

/** The `style: "none"` legs of a derivation as UI-layer hit targets. */
export function uiLegsOf(courses: readonly { id: string; legs: readonly { style: string; pieces: readonly (readonly Pt[])[] }[] }[] | undefined): UiLeg[] {
  return (courses ?? []).flatMap((c) => c.legs.flatMap((l, index) => (l.style === "none" ? [{ courseId: c.id, index, pieces: l.pieces }] : [])));
}

/** Reach around every shape, CSS px — the legacy leg hit-line was 12 px wide (6 px each side). */
export const HIT_TOLERANCE_PX = 6;

function targetOf(ref: { kind: string; id: string }): EditorTarget | null {
  switch (ref.kind) {
    case "site":
      return { kind: "site", id: ref.id };
    case "number":
    case "leader":
      return { kind: "number", id: ref.id };
    case "leg": {
      const cut = ref.id.lastIndexOf(":");
      const index = Number(ref.id.slice(cut + 1));
      return cut > 0 && Number.isInteger(index) ? { kind: "leg", courseId: ref.id.slice(0, cut), index } : null;
    }
    case "object": {
      // `course-object:<seq>` (course-layer.md §8.3); a sheet's layout objects are Layout mode's (D7).
      const m = /^course-object:(\d+)$/.exec(ref.id);
      return m ? { kind: "object", id: Number(m[1]) } : null;
    }
    default:
      // Imported extras are not editable (D1 turns them into course objects).
      return null;
  }
}

/**
 * The target at `pt` (paper mm), within `toleranceMm`: the nearest shape,
 * the topmost of equally near ones (a point inside a circle is distance 0).
 * `accept` narrows the targets: the others are passed over, not reported
 * (an armed placement sees through its own provisional visit, §6.1).
 */
export function editorHitAt(
  index: CourseHitIndex | null, pt: Pt, toleranceMm: number, uiSites: readonly UiSite[] = [], uiAreas: readonly UiArea[] = [],
  accept: (t: EditorTarget) => boolean = () => true, uiLegs: readonly UiLeg[] = [],
): EditorTarget | null {
  const areaIds = new Set(uiAreas.map((a) => a.id));
  if (index) {
    const hits = render.hitTest(index.stream, pt.x * 1000, pt.y * 1000, {
      toleranceUm: toleranceMm * 1000,
      // For control circles; closed areas never reach it (`areaIds`).
      closedStrokeInterior: true,
      objects: (i) => {
        const t = targetOf(index.refs[i] ?? { kind: "", id: "" });
        return t !== null && !(t.kind === "object" && areaIds.has(t.id)) && accept(t);
      },
    });
    let best: { t: EditorTarget; d: number } | null = null;
    for (const h of hits) {
      const t = targetOf(index.refs[h.objectIdx]);
      if (t && (!best || h.distanceUm < best.d)) best = { t, d: h.distanceUm };
    }
    if (best) return best.t;
  }
  let near: { id: string; d: number } | null = null;
  for (const s of uiSites) {
    if (!accept({ kind: "site", id: s.id })) continue;
    const d = Math.max(0, Math.hypot(pt.x - s.x, pt.y - s.y) - s.radiusMm);
    if (d <= toleranceMm && (!near || d < near.d)) near = { id: s.id, d };
  }
  if (near) return { kind: "site", id: near.id };
  let leg: { t: EditorTarget; d: number } | null = null;
  for (const l of uiLegs) {
    const t: EditorTarget = { kind: "leg", courseId: l.courseId, index: l.index };
    if (!accept(t)) continue;
    for (const piece of l.pieces) {
      const d = pathDistance(pt, piece, false);
      if (d <= toleranceMm && (!leg || d < leg.d)) leg = { t, d };
    }
  }
  if (leg) return leg.t;
  for (let i = uiAreas.length - 1; i >= 0; i--) {
    const a = uiAreas[i];
    if (!accept({ kind: "object", id: a.id })) continue;
    if (ringDistance(pt, a.ring) <= toleranceMm) return { kind: "object", id: a.id };
  }
  return null;
}

const ringDistance = (pt: Pt, ring: readonly Pt[]): number => pathDistance(pt, ring, true);

function pathDistance(pt: Pt, ring: readonly Pt[], closed: boolean): number {
  let best = Infinity;
  const n = closed ? ring.length : ring.length - 1;
  for (let i = 0; i < n; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
    const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((pt.x - a.x) * dx + (pt.y - a.y) * dy) / l2));
    best = Math.min(best, Math.hypot(pt.x - a.x - t * dx, pt.y - a.y - t * dy));
  }
  return best;
}
