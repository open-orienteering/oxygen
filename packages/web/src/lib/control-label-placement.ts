/**
 * Control-number label placement for the map overlay.
 *
 * Each control's code (or sequence number in description mode) is drawn
 * next to its circle. In congested clusters a naive placement easily
 * produces ambiguous maps — a number sitting closer to a *neighbouring*
 * circle than that circle's own number. This module chooses, for every
 * labeled circle, one of twelve slots around it by minimizing a cost
 * that penalizes:
 *
 *  - ambiguity: being close to a foreign circle relative to one's own
 *    (hard-rejected when the label is outright closer to the neighbour),
 *  - physical proximity of the label box to foreign circles,
 *  - overlap with already-placed labels,
 *  - proximity to drawn course lines (all courses on screen),
 *  - plus a small right/above preference as a tie-break.
 *
 * All cost terms are ratios of the input dimensions, so the result is
 * invariant under uniform scaling — labels do not jump around when the
 * map is zoomed. Callers pass only what is actually drawn: visible
 * circles and rendered leg segments. Pure module — no React, no DOM —
 * so placement is unit-testable.
 */

export interface PlacementCircle {
  id: string;
  x: number;
  y: number;
  /**
   * Text to place next to this circle. Circles without a label (start,
   * finish) still act as obstacles but get no placement entry.
   */
  label?: string;
  /** Obstacle radius override (finish outer ring); defaults to opts.radius. */
  radius?: number;
}

export interface PlacementSeg {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface PlacementOpts {
  /** Control circle radius, in the same unit as the coordinates. */
  radius: number;
  /** Label font size, same unit. Box estimate: w = len·0.65·size, h = 1.2·size. */
  labelSize: number;
}

/** Placed label: center plus the estimated box used for collision. */
export interface PlacedControlLabel {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Keep in sync with the SVG renderer's font metrics. */
const CHAR_WIDTH_RATIO = 0.65;
const LINE_HEIGHT_RATIO = 1.2;

/**
 * Candidate slots around the circle: 8 compass directions plus 4 wide
 * diagonals. Order encodes the preference used for cost tie-breaks
 * (earlier = slightly preferred).
 */
const SLOTS = [
  { dx: 1, dy: -1 }, { dx: 1, dy: 0 }, { dx: 1, dy: 1 },
  { dx: 0, dy: -1 }, { dx: -1, dy: -1 }, { dx: -1, dy: 0 },
  { dx: -1, dy: 1 }, { dx: 0, dy: 1 },
  { dx: 1.3, dy: -0.7 }, { dx: -1.3, dy: -0.7 },
  { dx: 1.3, dy: 0.7 }, { dx: -1.3, dy: 0.7 },
];

function ptSegDist(
  px: number, py: number,
  ax: number, ay: number, bx: number, by: number,
): number {
  const dx = bx - ax, dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  let t = lenSq > 0 ? ((px - ax) * dx + (py - ay) * dy) / lenSq : 0;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx, cy = ay + t * dy;
  return Math.hypot(px - cx, py - cy);
}

/**
 * Place one label per labeled circle. Greedy in id order (numeric-aware,
 * so the result is independent of input order), each label choosing the
 * cheapest of the twelve slots given everything placed so far.
 */
export function placeControlLabels(
  circles: PlacementCircle[],
  lines: PlacementSeg[],
  opts: PlacementOpts,
): Map<string, PlacedControlLabel> {
  const { radius, labelSize } = opts;
  const out = new Map<string, PlacedControlLabel>();
  const placedRects: PlacedControlLabel[] = [];

  const labeled = circles
    .filter((c) => c.label !== undefined && c.label !== "")
    .sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));

  for (const c of labeled) {
    const label = c.label!;
    const estW = label.length * labelSize * CHAR_WIDTH_RATIO;
    const estH = labelSize * LINE_HEIGHT_RATIO;
    const halfDiag = Math.hypot(estW, estH) / 2;

    let best: PlacedControlLabel | null = null;
    let bestCost = Infinity;

    for (let si = 0; si < SLOTS.length; si++) {
      const slot = SLOTS[si];
      const cx = c.x + slot.dx * (radius + estW * 0.55);
      const cy = c.y + slot.dy * (radius + estH * 0.55);
      const dOwn = Math.hypot(cx - c.x, cy - c.y);

      // Deterministic tie-break: earlier slots win exact ties, plus the
      // legacy right/above preference.
      let cost = si * 1e-3;
      if (slot.dx < 0) cost += 2;
      if (slot.dy > 0) cost += 1;

      for (const o of circles) {
        if (o === c) continue;
        const d = Math.hypot(cx - o.x, cy - o.y);

        // Ambiguity: a label closer to a foreign circle than to its own
        // is unreadable — hard-reject. Approaching parity is graded.
        if (d <= dOwn) {
          cost += 300 + ((dOwn - d) / radius) * 50;
        } else {
          const ratio = dOwn / d;
          if (ratio > 0.6) cost += 120 * Math.pow((ratio - 0.6) / 0.4, 2);
        }

        // Physical proximity of the label box to the foreign circle.
        const edge = d - (o.radius ?? radius);
        if (edge < halfDiag) {
          cost += 150;
        } else if (edge < halfDiag * 2.5) {
          cost += 60 * ((halfDiag * 2.5 - edge) / (halfDiag * 1.5));
        }
      }

      for (const lp of placedRects) {
        // Small margin so labels do not visually touch either.
        const mx = estH * 0.15;
        if (
          Math.abs(cx - lp.x) < (estW + lp.w) / 2 + mx &&
          Math.abs(cy - lp.y) < (estH + lp.h) / 2 + mx
        ) {
          cost += 80;
        }
      }

      for (const seg of lines) {
        const d = ptSegDist(cx, cy, seg.x1, seg.y1, seg.x2, seg.y2);
        if (d < estH) cost += 12 + 38 * (1 - d / estH);
      }

      if (cost < bestCost) {
        bestCost = cost;
        best = { x: cx, y: cy, w: estW, h: estH };
      }
    }

    if (best) {
      out.set(c.id, best);
      placedRects.push(best);
    }
  }

  return out;
}
