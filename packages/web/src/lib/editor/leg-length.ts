/**
 * A leg's length on the ground as the UI layer labels it (docs/course-editor.md
 * §6.1): the pending leg while a placement tool is armed, both legs of a
 * dragged control. The status bar shows the same metres.
 */

import type { ToolShape } from "../../components/MapViewer";

type Pt = { x: number; y: number };

/** Metres on the ground for `mm` on paper at 1:`mapScale`. */
export const legLengthM = (mm: number, mapScale: number): number => (mm * mapScale) / 1000;

/** "123 m", rounded to the metre; null without a scale. */
export function legLengthLabel(a: Pt, b: Pt, mapScale: number | null | undefined): string | null {
  if (!mapScale) return null;
  return `${Math.round(legLengthM(Math.hypot(b.x - a.x, b.y - a.y), mapScale))} m`;
}

/** Where the label sits: the leg's midpoint, paper mm. */
export const legMidpoint = (a: Pt, b: Pt): Pt => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

/** The label as a UI-layer shape (`editor-leg-length`) at the leg's midpoint. */
export function legLengthShape(a: Pt, b: Pt, text: string): ToolShape {
  const m = legMidpoint(a, b);
  return { kind: "text", x: m.x, y: m.y, text, dxPx: 6, dyPx: -6, color: "#7c3aed", testId: "editor-leg-length" };
}

/**
 * The labels of a dragged control's legs: every visit of `id` in the
 * course's sequence, the leg in and the leg out, each between the nearest
 * drawn neighbours (the layer joins over an undrawn item, course-layer.md §2).
 */
export function dragLegShapes(sequence: readonly string[], pos: ReadonlyMap<string, Pt>, id: string, mapScale: number | null | undefined): ToolShape[] {
  const out: ToolShape[] = [];
  const at = pos.get(id);
  if (!at || !mapScale) return out;
  const drawn = (from: number, step: 1 | -1) => {
    for (let i = from; i >= 0 && i < sequence.length; i += step) {
      const p = pos.get(sequence[i]);
      if (p) return sequence[i] === id ? null : p;
    }
    return null;
  };
  sequence.forEach((s, i) => {
    if (s !== id) return;
    for (const other of [drawn(i - 1, -1), drawn(i + 1, 1)]) {
      if (other) out.push(legLengthShape(other, at, legLengthLabel(other, at, mapScale)!));
    }
  });
  return out;
}
