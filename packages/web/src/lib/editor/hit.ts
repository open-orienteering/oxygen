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
  | { kind: "leg"; courseId: string; index: number };

/** A site the UI layer draws (faded, not in the course layer): its centre and circle radius, paper mm. */
export interface UiSite {
  id: string;
  x: number;
  y: number;
  radiusMm: number;
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
    default:
      // Extras and layout objects are D5's (course objects in the editor).
      return null;
  }
}

/**
 * The target at `pt` (paper mm), within `toleranceMm`: the nearest shape,
 * the topmost of equally near ones (a point inside a circle is distance 0).
 */
export function editorHitAt(index: CourseHitIndex | null, pt: Pt, toleranceMm: number, uiSites: readonly UiSite[] = []): EditorTarget | null {
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
  return near ? { kind: "site", id: near.id } : null;
}
