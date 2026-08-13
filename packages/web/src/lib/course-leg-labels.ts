/**
 * Leg labels for multi-course map display.
 *
 * With several courses highlighted at once it is hard to tell which lines
 * belong to which course. Course-setting software solves this by writing
 * the class names along the connection lines — this module computes those
 * label placements.
 *
 * Labels are keyed by CONTROL PAIR from each course's control sequence,
 * not by the drawn line geometry. That guarantees exactly one label per
 * leg, centered between its two controls, regardless of how the overprint
 * is cut into segments (circle clips, crossing slits, per-course cuts) —
 * and legs shared by several courses merge into one label carrying the
 * union of their classes ("Öppen 1, Öppen 2").
 *
 * Pure module — no React, no DOM — so placement is unit-testable.
 */

export interface Pt {
  x: number;
  y: number;
}

export interface CourseLegSequence {
  /** Label for this course's legs (classes, or course name). */
  text: string;
  /** Ordered control ids (start/finish included), as drawn on the map. */
  controlIds: string[];
}

export interface PlacedLegLabel {
  x: number;
  y: number;
  /** Rotation in degrees, normalized so text is never upside-down. */
  angleDeg: number;
  text: string;
  /**
   * Font size for this label: the base size, shrunk when the text would
   * otherwise be longer than its leg (long class lists on short legs).
   */
  fontSize: number;
}

/** Pill width per character, per font px (keep in sync with pillHalfWidth). */
const CHAR_WIDTH_RATIO = 0.64;
/** Fixed pill padding (both ends combined), per font px. */
const PILL_PAD_RATIO = 1.1;

/**
 * Half the rendered pill width for a label. The single source of truth
 * shared by the fit computation here and the SVG renderer, so "fits on
 * the line" is judged on the actual pill, not just the text.
 */
export function pillHalfWidth(textLength: number, fontSize: number): number {
  return (textLength * fontSize * CHAR_WIDTH_RATIO + fontSize * PILL_PAD_RATIO) / 2;
}

/**
 * Normalize a text rotation (screen degrees) into (-90, 90] so labels are
 * never upside-down. `extraRotationDeg` is the map layer's own rotation
 * (north offset): the label lives inside the rotated layer, so uprightness
 * must be judged in final screen space, then mapped back to layer space.
 */
export function uprightAngle(layerDeg: number, extraRotationDeg = 0): number {
  let screen = (layerDeg + extraRotationDeg) % 360;
  if (screen > 180) screen -= 360;
  if (screen <= -180) screen += 360;
  if (screen > 90) screen -= 180;
  else if (screen <= -90) screen += 180;
  return screen - extraRotationDeg;
}

/** Merge two label texts: union of comma-separated parts, stable order. */
function mergeTexts(a: string, b: string): string {
  const parts = new Set(
    [...a.split(","), ...b.split(",")].map((s) => s.trim()).filter(Boolean),
  );
  return [...parts].sort((x, y) => x.localeCompare(y, undefined, { numeric: true })).join(", ");
}

/**
 * Compute one placed label per unique leg (control pair) across all the
 * given courses. Labels render at `baseFontSize`; when the PILL would be
 * wider than the visible line, the label shrinks until it fits — and if
 * fitting would take it below `minFontSize`, it is dropped instead (an
 * unreadable speck helps nobody).
 *
 * `clearance(id)` gives the radius around a control's center where the
 * line is not drawn (circle clip). The usable span of a leg is the
 * center-to-center distance minus both clearances, and the label is
 * centered on that VISIBLE span — noticeable at the finish, whose double
 * circle is much larger than a regular control's.
 */
export function buildCourseLegLabels(
  courses: CourseLegSequence[],
  positions: ReadonlyMap<string, Pt>,
  opts: {
    baseFontSize: number;
    minFontSize: number;
    mapRotationDeg?: number;
    clearance?: (controlId: string) => number;
  },
): PlacedLegLabel[] {
  const byPair = new Map<
    string,
    { idA: string; idB: string; a: Pt; b: Pt; text: string }
  >();
  for (const course of courses) {
    if (!course.text) continue;
    for (let i = 0; i < course.controlIds.length - 1; i++) {
      const idA = course.controlIds[i];
      const idB = course.controlIds[i + 1];
      if (idA === idB) continue;
      const a = positions.get(idA);
      const b = positions.get(idB);
      if (!a || !b) continue;
      const key = idA < idB ? `${idA}|${idB}` : `${idB}|${idA}`;
      const existing = byPair.get(key);
      if (existing) {
        existing.text = mergeTexts(existing.text, course.text);
      } else {
        byPair.set(key, { idA, idB, a, b, text: course.text });
      }
    }
  }

  const out: PlacedLegLabel[] = [];
  for (const { idA, idB, a, b, text } of byPair.values()) {
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len < 1) continue;
    const clearA = opts.clearance?.(idA) ?? 0;
    const clearB = opts.clearance?.(idB) ?? 0;
    const usable = len - clearA - clearB;
    if (usable <= 0) continue;
    // Largest font at which the whole pill fits on the visible line.
    const maxFitting = usable / (text.length * CHAR_WIDTH_RATIO + PILL_PAD_RATIO);
    const fontSize = Math.min(opts.baseFontSize, maxFitting);
    if (fontSize < opts.minFontSize) continue;
    // Center on the visible span (between the circle edges), not on the
    // center-to-center segment.
    const ux = (b.x - a.x) / len;
    const uy = (b.y - a.y) / len;
    const midT = clearA + usable / 2;
    const angleDeg = (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
    out.push({
      x: a.x + ux * midT,
      y: a.y + uy * midT,
      angleDeg: uprightAngle(angleDeg, opts.mapRotationDeg ?? 0),
      text,
      fontSize,
    });
  }
  return out;
}

/**
 * The label text for a course's legs: its classes when any are assigned
 * (all of them — several classes can share a course), the course name
 * otherwise.
 */
export function courseLegLabelText(
  courseName: string,
  classNames: readonly string[] | undefined,
): string {
  if (classNames && classNames.length > 0) {
    return [...new Set(classNames)]
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
      .join(", ");
  }
  return courseName;
}
