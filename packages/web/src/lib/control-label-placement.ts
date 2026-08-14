/**
 * Control-number label placement for the map overlay.
 *
 * Each control's code (or sequence number in description mode) is drawn
 * next to its circle. In congested clusters a naive placement easily
 * produces ambiguous maps — a number sitting closer to a *neighbouring*
 * circle than that circle's own number. This module chooses, for every
 * labeled circle, a position around it in two stages:
 *
 * GEOMETRY — candidates lie on rings around the circle: 16 evenly
 * spaced directions, with the label BOX EDGE at a fixed clearance
 * (`gap`) from the circle edge. The box center distance along the
 * direction is solved exactly (per closest-feature region of the box)
 * so the closest point of the box is `radius + gap` from the circle
 * center in *every* direction. This makes the visual distance identical
 * for every label on the map, regardless of direction and digit count —
 * coherent placement. Directions are ordered by preference (right/above
 * first), so uncontested controls look conventional.
 *
 * CONSTRAINTS — a candidate whose box would intersect any circle or an
 * already-placed label box is rejected outright (closest-point tests,
 * not center heuristics). Survivors are ranked by soft costs:
 *
 *  - ambiguity: being close to a foreign circle relative to one's own
 *    (heavily penalized when the label is outright closer to the
 *    neighbour),
 *  - claim intrusion: sitting closer to a labeled neighbour than that
 *    neighbour's own label can ever be (its "claim radius": innermost
 *    ring, narrowest box axis) — guaranteed to misread; heavily
 *    penalized, but soft, because in pathological packs the only sane
 *    slot may intrude and exiling the label outward reads worse,
 *  - crowding: the box passing near a foreign circle or another label,
 *  - proximity to drawn course lines (all courses on screen),
 *  - a small direction-preference bias as a tie-break.
 *
 * If a ring yields no valid candidate (clusters whose circles overlap),
 * wider rings are tried (`gap + labelSize`, `gap + 2·labelSize`). If
 * even those fail, the least-bad candidate overall is used — a number
 * is never dropped.
 *
 * LEADER LINES — when the chosen spot is contested (some foreign circle
 * ends up closer to the label than its own; provably unavoidable in
 * packs where circles overlap), the label gets a leader line from its
 * box edge to its own circle edge so the association stays readable.
 *
 * All thresholds are ratios of the input dimensions, so the result is
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
  /**
   * Leader line from the label box edge (x1, y1) to the edge of the
   * label's own circle (x2, y2). Present only when the label is
   * contested — some foreign circle is closer to the label than its own
   * — so the line resolves what proximity cannot. Absent on ordinary
   * maps.
   */
  leader?: { x1: number; y1: number; x2: number; y2: number };
}

/** Keep in sync with the SVG renderer's font metrics. */
const CHAR_WIDTH_RATIO = 0.65;
const LINE_HEIGHT_RATIO = 1.2;

/** Clearance between circle edge and label box edge, per font unit. */
const GAP_RATIO = 0.2;

/**
 * The 32 candidate directions (degrees, screen convention: 0 = east,
 * positive = down), in preference order: the 16 primary directions
 * first (right side, then above; left and below last), then the 16
 * intermediate half-step angles in the same order — congested clusters
 * can thread needles the primary grid misses. The index doubles as a
 * small cost bias so near-equivalent spots resolve toward the
 * conventional up-right.
 */
const PRIMARY_DEG = [
  -45, 0, -90, -22.5, -67.5, 45, 22.5, -135,
  -112.5, 90, 67.5, 180, -157.5, 157.5, 112.5, 135,
];
const DIRECTION_DEG = [...PRIMARY_DEG, ...PRIMARY_DEG.map((d) => d + 11.25)];

const DIRECTIONS = DIRECTION_DEG.map((deg) => {
  const rad = (deg * Math.PI) / 180;
  return { ux: Math.cos(rad), uy: Math.sin(rad) };
});

/** Extra ring clearances tried when a ring yields no valid candidate. */
const RING_EXTRAS = [0, 0.5, 1, 1.5, 2]; // × labelSize

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

/** Distance from a point to the closest point of an axis-aligned box. */
function ptRectDist(
  px: number, py: number,
  cx: number, cy: number, w: number, h: number,
): number {
  const dx = Math.max(Math.abs(px - cx) - w / 2, 0);
  const dy = Math.max(Math.abs(py - cy) - h / 2, 0);
  return Math.hypot(dx, dy);
}

/**
 * Distance from the circle center to the box center, along direction
 * (a, b) = (|ux|, |uy|), such that the box's closest point to the
 * center is exactly R away. Solved per closest-feature region (x-edge,
 * y-edge, corner) so the visual clearance is identical in every
 * direction — the coherence rule taken literally.
 */
function ringDistance(
  a: number, b: number,
  halfW: number, halfH: number,
  R: number,
): number {
  if (a > 0) {
    const t = (R + halfW) / a;
    if (t * b <= halfH) return t;
  }
  if (b > 0) {
    const t = (R + halfH) / b;
    if (t * a <= halfW) return t;
  }
  const support = a * halfW + b * halfH;
  const disc = R * R - Math.pow(b * halfW - a * halfH, 2);
  return support + Math.sqrt(Math.max(disc, 0));
}

function rectsOverlap(
  a: PlacedControlLabel,
  b: PlacedControlLabel,
  margin: number,
): boolean {
  return (
    Math.abs(a.x - b.x) < (a.w + b.w) / 2 + margin &&
    Math.abs(a.y - b.y) < (a.h + b.h) / 2 + margin
  );
}

/**
 * Place one label per labeled circle. Greedy, most-crowded circle first
 * (ties broken by numeric-aware id compare, so the result is
 * independent of input order): the tightest-boxed controls get first
 * pick of the scarce pockets, and roomy controls can always fall back
 * to another free direction.
 */
export function placeControlLabels(
  circles: PlacementCircle[],
  lines: PlacementSeg[],
  opts: PlacementOpts,
): Map<string, PlacedControlLabel> {
  const { radius, labelSize } = opts;
  const gap = labelSize * GAP_RATIO;
  const out = new Map<string, PlacedControlLabel>();
  const placedRects: PlacedControlLabel[] = [];

  // Crowding pressure: how many circles sit close enough to interfere
  // with this circle's first label ring.
  const pressureReach = 2 * radius + 2 * labelSize;
  const pressure = (c: PlacementCircle): number => {
    let n = 0;
    for (const o of circles) {
      if (o !== c && Math.hypot(o.x - c.x, o.y - c.y) < pressureReach) n++;
    }
    return n;
  };

  const labeled = circles
    .filter((c) => c.label !== undefined && c.label !== "")
    .map((c) => ({ c, p: pressure(c) }))
    .sort(
      (a, b) =>
        b.p - a.p || a.c.id.localeCompare(b.c.id, undefined, { numeric: true }),
    )
    .map((e) => e.c);

  // A labeled circle's "claim radius": the smallest center distance its
  // own label can ever have (innermost ring, narrowest box axis). Any
  // foreign label sitting closer than this is *guaranteed* to read as
  // that circle's number — no placement of the rightful label can win —
  // so such candidates are hard-rejected.
  const halfH = (labelSize * LINE_HEIGHT_RATIO) / 2;
  const claimRadius = (o: PlacementCircle): number =>
    (o.radius ?? radius) +
    gap +
    Math.min((o.label!.length * labelSize * CHAR_WIDTH_RATIO) / 2, halfH);

  for (const c of labeled) {
    const label = c.label!;
    const estW = label.length * labelSize * CHAR_WIDTH_RATIO;
    const estH = labelSize * LINE_HEIGHT_RATIO;

    // Soft cost of a candidate, assuming it already passed the hard
    // collision checks. Shared by ring selection and the last-resort
    // fallback (which adds collision penalties on top).
    const softCost = (
      rect: PlacedControlLabel,
      dirIndex: number,
    ): number => {
      let cost = dirIndex * 0.1;
      const dOwn = Math.hypot(rect.x - c.x, rect.y - c.y);
      for (const o of circles) {
        if (o === c) continue;
        const d = Math.hypot(rect.x - o.x, rect.y - o.y);
        // Ambiguity: a label closer to a foreign circle than to its own
        // is unreadable — effectively reject. Approaching parity grades.
        if (d <= dOwn) {
          cost += 300 + ((dOwn - d) / radius) * 50;
        } else {
          const ratio = dOwn / d;
          if (ratio > 0.6) cost += 120 * Math.pow((ratio - 0.6) / 0.4, 2);
        }
        // Claim intrusion: sitting closer to a labeled neighbour than
        // that neighbour's own label can ever be guarantees the
        // neighbour's circle misreads. Heavy soft cost (not hard): in
        // pathological packs the only slot at a sane distance may
        // intrude, and taking it beats exiling the label outward.
        if (o.label !== undefined && o.label !== "") {
          const claim = claimRadius(o);
          if (d < claim) cost += 150 + 250 * ((claim - d) / claim);
        }
        // Crowding: box passing near a foreign circle's edge.
        const edge = ptRectDist(o.x, o.y, rect.x, rect.y, rect.w, rect.h) - (o.radius ?? radius);
        if (edge < labelSize) cost += 40 * (1 - Math.max(edge, 0) / labelSize);
      }
      for (const lp of placedRects) {
        // Graded crowding cost for sitting close to another label:
        // touching boxes are legal (intersection is the hard limit) but
        // cost more the closer they get.
        const sepX = Math.abs(rect.x - lp.x) - (rect.w + lp.w) / 2;
        const sepY = Math.abs(rect.y - lp.y) - (rect.h + lp.h) / 2;
        const s = Math.max(sepX, sepY);
        if (s < estH) cost += 25 * (1 - Math.max(s, 0) / estH);
      }
      for (const seg of lines) {
        const d = ptSegDist(rect.x, rect.y, seg.x1, seg.y1, seg.x2, seg.y2);
        if (d < estH) cost += 12 + 38 * (1 - d / estH);
      }
      return cost;
    };

    // Hard collision penalties for the last-resort fallback ranking.
    const collisionPenalty = (rect: PlacedControlLabel): number => {
      let penalty = 0;
      for (const o of circles) {
        if (o === c) continue;
        if (ptRectDist(o.x, o.y, rect.x, rect.y, rect.w, rect.h) < (o.radius ?? radius)) {
          penalty += 1000;
        }
        if (
          o.label !== undefined &&
          o.label !== "" &&
          Math.hypot(rect.x - o.x, rect.y - o.y) < claimRadius(o)
        ) {
          penalty += 400;
        }
      }
      for (const lp of placedRects) {
        if (rectsOverlap(rect, lp, 0)) penalty += 800;
      }
      return penalty;
    };

    let best: PlacedControlLabel | null = null;
    let fallback: PlacedControlLabel | null = null;
    let fallbackCost = Infinity;

    for (const ringExtra of RING_EXTRAS) {
      let ringBest: PlacedControlLabel | null = null;
      let ringBestCost = Infinity;

      for (let di = 0; di < DIRECTIONS.length; di++) {
        const { ux, uy } = DIRECTIONS[di];
        const clearance = gap + ringExtra * labelSize;
        const dist = ringDistance(
          Math.abs(ux), Math.abs(uy),
          estW / 2, estH / 2,
          radius + clearance,
        );
        const rect: PlacedControlLabel = {
          x: c.x + ux * dist,
          y: c.y + uy * dist,
          w: estW,
          h: estH,
        };

        // Hard constraints: the box must not intersect any circle or an
        // already-placed label box. (The own circle is safe by
        // construction: the box's closest point is exactly radius+gap
        // from the center.)
        let collides = false;
        for (const o of circles) {
          if (o === c) continue;
          if (ptRectDist(o.x, o.y, rect.x, rect.y, rect.w, rect.h) < (o.radius ?? radius)) {
            collides = true;
            break;
          }
        }
        if (!collides) {
          for (const lp of placedRects) {
            if (rectsOverlap(rect, lp, 0)) {
              collides = true;
              break;
            }
          }
        }

        const cost = softCost(rect, di) + ringExtra * 5;
        if (!collides && cost < ringBestCost) {
          ringBestCost = cost;
          ringBest = rect;
        }
        // Last-resort tracking across all rings, collisions penalized
        // (not forbidden): a number is never dropped.
        const penalized = cost + collisionPenalty(rect);
        if (penalized < fallbackCost) {
          fallbackCost = penalized;
          fallback = rect;
        }
      }

      if (ringBest) {
        best = ringBest;
        break;
      }
    }

    const chosen = best ?? fallback;
    if (chosen) {
      // Contested label: some foreign circle is closer to the chosen
      // spot than the label's own circle. Proximity alone would misread,
      // so attach a leader line from the box edge to the own circle edge.
      const dOwn = Math.hypot(chosen.x - c.x, chosen.y - c.y);
      const contested = circles.some(
        (o) => o !== c && Math.hypot(chosen.x - o.x, chosen.y - o.y) < dOwn,
      );
      if (contested) {
        // Box-boundary point nearest the own circle center...
        const bx = Math.max(
          chosen.x - chosen.w / 2,
          Math.min(c.x, chosen.x + chosen.w / 2),
        );
        const by = Math.max(
          chosen.y - chosen.h / 2,
          Math.min(c.y, chosen.y + chosen.h / 2),
        );
        // ...pulled slightly into the box so the tick visually connects
        // with the digits (the box has padding around the glyphs)...
        const toCenter = Math.hypot(chosen.x - bx, chosen.y - by);
        const inset = Math.min(labelSize * 0.35, toCenter);
        const sx = bx + ((chosen.x - bx) / toCenter) * inset;
        const sy = by + ((chosen.y - by) / toCenter) * inset;
        // ...connected to the circle-edge point facing it.
        const len = Math.hypot(sx - c.x, sy - c.y);
        const ownR = c.radius ?? radius;
        chosen.leader = {
          x1: sx,
          y1: sy,
          x2: c.x + ((sx - c.x) / len) * ownR,
          y2: c.y + ((sy - c.y) / len) * ownR,
        };
      }
      out.set(c.id, chosen);
      placedRects.push(chosen);
    }
  }

  return out;
}
