/**
 * A leg's length on the ground as the UI layer labels it (docs/course-editor.md
 * §6.1): the pending leg while a placement tool is armed, both legs of a
 * dragged control. It is the one readout of the pending leg (P2: no status-bar number).
 * A leg with bends is measured and labelled along them (course-layer.md §10.1;
 * the call sites pass the stored bends, docs/course-editor.md §6.7).
 */

import { course } from "@oxygen/shared";
import type { ToolShape } from "../../components/MapViewer";

type Pt = { x: number; y: number };

/** Metres on the ground for `mm` on paper at 1:`mapScale`. */
export const legLengthM = (mm: number, mapScale: number): number => (mm * mapScale) / 1000;

/** The leg's polyline: `a`, the bends, `b`. */
const polyline = (a: Pt, b: Pt, via: readonly Pt[]): Pt[] => [a, ...via, b];

/** "123 m", rounded to the metre, along the bends `via`; null without a scale. */
export function legLengthLabel(a: Pt, b: Pt, mapScale: number | null | undefined, via: readonly Pt[] = []): string | null {
  if (!mapScale) return null;
  return `${Math.round(legLengthM(course.legLengthMm(polyline(a, b, via)), mapScale))} m`;
}

/** Where the label sits: the leg's midpoint, paper mm — half way along its bends `via`. */
export function legMidpoint(a: Pt, b: Pt, via: readonly Pt[] = []): Pt {
  const pts = polyline(a, b, via);
  let left = course.legLengthMm(pts) / 2;
  for (let i = 1; i < pts.length; i++) {
    const p = pts[i - 1], q = pts[i];
    const d = Math.hypot(q.x - p.x, q.y - p.y);
    if (d > 0 && left <= d) return { x: p.x + ((q.x - p.x) * left) / d, y: p.y + ((q.y - p.y) * left) / d };
    left -= d;
  }
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

/** The label as a UI-layer shape (`editor-leg-length`) at the leg's midpoint. */
export function legLengthShape(a: Pt, b: Pt, text: string, via: readonly Pt[] = []): ToolShape {
  const m = legMidpoint(a, b, via);
  return { kind: "text", x: m.x, y: m.y, text, dxPx: 6, dyPx: -6, color: "#7c3aed", testId: "editor-leg-length" };
}

/**
 * The labels of a dragged control's legs: every visit of `id` in the
 * course's sequence, the leg in and the leg out, each between the nearest
 * drawn neighbours (the layer joins over an undrawn item, course-layer.md §2).
 * `bendsInto[i]` are the bends of the leg into `sequence[i]` (§10.1).
 */
export function dragLegShapes(
  sequence: readonly string[],
  pos: ReadonlyMap<string, Pt>,
  id: string,
  mapScale: number | null | undefined,
  bendsInto: ReadonlyArray<readonly Pt[] | undefined> = [],
): ToolShape[] {
  const out: ToolShape[] = [];
  const at = pos.get(id);
  if (!at || !mapScale) return out;
  const drawn = (from: number, step: 1 | -1) => {
    for (let i = from; i >= 0 && i < sequence.length; i += step) {
      const p = pos.get(sequence[i]);
      if (p) return sequence[i] === id ? null : { p, i };
    }
    return null;
  };
  sequence.forEach((s, i) => {
    if (s !== id) return;
    const before = drawn(i - 1, -1);
    if (before) {
      const via = bendsInto[i] ?? [];
      out.push(legLengthShape(before.p, at, legLengthLabel(before.p, at, mapScale, via)!, via));
    }
    const after = drawn(i + 1, 1);
    if (after) {
      // The leg out runs at → bends → after; labelled from the far end, as before.
      const via = [...(bendsInto[after.i] ?? [])].reverse();
      out.push(legLengthShape(after.p, at, legLengthLabel(after.p, at, mapScale, via)!, via));
    }
  });
  return out;
}
