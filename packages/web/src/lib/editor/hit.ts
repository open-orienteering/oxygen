/**
 * What the editor's pointer is on (docs/course-editor.md §5): the course
 * layer's symbolised shapes, hit-tested on the shared stage
 * (`render.hitTest`, docs/map-rendering.md §5.5) over the hit index the
 * worker returns with every course reply — no SVG hit targets, no GPU
 * readback, synchronous on pointer-down.
 *
 * Off-course controls the editor fades are not in the layer (the UI layer
 * draws them, §5.4 "Overlay"), so they are passed as plain circles and
 * lose to any layer object at the same point.
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
 * A course object the layer does not draw on screen — a filter region (a
 * region, not an object) or a toner saver (no frame on screen) — which the
 * UI layer outlines: its ring, paper mm. It hits over its interior and
 * along its outline, below everything else.
 */
export interface UiArea {
  id: number;
  ring: readonly Pt[];
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
 */
export function editorHitAt(
  index: CourseHitIndex | null, pt: Pt, toleranceMm: number, uiSites: readonly UiSite[] = [], uiAreas: readonly UiArea[] = [],
): EditorTarget | null {
  if (index) {
    const hits = render.hitTest(index.stream, pt.x * 1000, pt.y * 1000, {
      toleranceUm: toleranceMm * 1000,
      closedStrokeInterior: true,
      objects: (i) => targetOf(index.refs[i] ?? { kind: "", id: "" }) !== null,
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
    const d = Math.max(0, Math.hypot(pt.x - s.x, pt.y - s.y) - s.radiusMm);
    if (d <= toleranceMm && (!near || d < near.d)) near = { id: s.id, d };
  }
  if (near) return { kind: "site", id: near.id };
  for (let i = uiAreas.length - 1; i >= 0; i--) {
    const a = uiAreas[i];
    if (insideRing(pt, a.ring) || ringDistance(pt, a.ring) <= toleranceMm) return { kind: "object", id: a.id };
  }
  return null;
}

function insideRing(pt: Pt, ring: readonly Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    if ((a.y > pt.y) !== (b.y > pt.y) && pt.x < ((b.x - a.x) * (pt.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

function ringDistance(pt: Pt, ring: readonly Pt[]): number {
  let best = Infinity;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
    const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((pt.x - a.x) * dx + (pt.y - a.y) * dy) / l2));
    best = Math.min(best, Math.hypot(pt.x - a.x - t * dx, pt.y - a.y - t * dy));
  }
  return best;
}
