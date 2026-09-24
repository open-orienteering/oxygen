/**
 * Build the IOF control-description sheet row model for a single course.
 *
 * Layout (matches the printed sheet / SOFT example):
 *   header 1  event name (full width)
 *   header 2  class names (full width)
 *   header 3  course name (3) · length km (3) · climb m (2)
 *   start     triangle in A, C–H from the start control's description
 *   controls  A=seq, B=code, C–H from each control
 *   specials  full-width 13.x symbol (+ optional length) inserted after a control
 *   finish    full-width 14.x symbol (+ optional length)
 *
 * Union / all-controls sheets keep a single title row and skip this
 * builder — callers use the simpler path in MapViewer / description-svg.
 */

import type {
  ControlDescription,
  CourseDescriptionInstructions,
} from "../types.js";

export type DescriptionSheetRowKind =
  | "start"
  | "control"
  | "special"
  | "finish";

export interface DescriptionSheetRow {
  kind: DescriptionSheetRowKind;
  /** Sequence number for control rows (1-based); omitted for others. */
  sequence?: number;
  /** Punch code (control) or empty (start / special / finish). */
  code: string;
  description?: ControlDescription | null;
  /** IOF key for special/finish full-width symbols (e.g. "13.1", "14.3"). */
  symbolKey?: string;
  /** Optional length (metres) drawn in the centre of a special/finish row. */
  lengthM?: number;
}

export interface DescriptionSheetHeader {
  eventName: string;
  classNames: string;
  courseName: string;
  /** Pre-formatted, e.g. "4.2 km". */
  lengthKm: string;
  /** Pre-formatted, e.g. "85 m". */
  climbM: string;
}

export interface DescriptionSheetModel {
  header: DescriptionSheetHeader;
  rows: DescriptionSheetRow[];
}

export interface BuildDescriptionSheetInput {
  eventName: string;
  classNames: string[];
  courseName: string;
  lengthM: number;
  climbM: number;
  /** Start control description (optional — triangle always drawn). */
  startDescription?: ControlDescription | null;
  controls: Array<{
    /** Public control id — used to place specials after this control. */
    id: number;
    code: string;
    description?: ControlDescription | null;
  }>;
  instructions?: CourseDescriptionInstructions | null;
  /**
   * Measured last-control → finish distance in metres (from the map
   * geometry). Used for the finish row when the course instructions do
   * not carry an explicit `finish.lengthM`.
   */
  finishLengthM?: number | null;
}

/**
 * IOF control description layout: "A thicker horizontal line should be
 * used after every third description and on either side of any special
 * instruction." Plus the header block, the start row and the finish row
 * are boxed in by thick rules. Returns true when the line *below*
 * `rows[index]` should be drawn thick:
 *  - under the start row,
 *  - under every third control (sequence 3, 6, 9, …),
 *  - above and below a special-instruction row,
 *  - above the finish row.
 */
export function hasThickRuleBelow(
  rows: readonly DescriptionSheetRow[],
  index: number,
): boolean {
  const row = rows[index];
  if (!row) return false;
  if (row.kind === "start" || row.kind === "special") return true;
  if (row.kind === "control" && row.sequence != null && row.sequence % 3 === 0) {
    return true;
  }
  const next = rows[index + 1]?.kind;
  return next === "special" || next === "finish";
}

/**
 * Column groups of the IOF sheet: A B C | D E F | G H. A thick vertical
 * rule follows these 0-based column indices (i.e. after the 3rd and 6th
 * cell).
 */
export const DESCRIPTION_THICK_COLUMNS: readonly number[] = [3, 6];

function formatKm(lengthM: number): string {
  if (!Number.isFinite(lengthM) || lengthM <= 0) return "";
  const km = lengthM / 1000;
  return `${km.toFixed(km >= 10 ? 1 : 2)} km`;
}

function formatClimb(climbM: number): string {
  if (!Number.isFinite(climbM) || climbM <= 0) return "";
  return `${Math.round(climbM)} m`;
}

/**
 * Build the ordered sheet rows for one course. Specials whose
 * `afterControlId` is not in the sequence are dropped.
 */
export function buildDescriptionSheet(
  input: BuildDescriptionSheetInput,
): DescriptionSheetModel {
  const header: DescriptionSheetHeader = {
    eventName: input.eventName,
    classNames: input.classNames.filter(Boolean).join(", "),
    courseName: input.courseName,
    lengthKm: formatKm(input.lengthM),
    climbM: formatClimb(input.climbM),
  };

  const rows: DescriptionSheetRow[] = [];
  const specials = input.instructions?.specials ?? [];

  const afterStart = specials.filter((s) => s.afterControlId == null);
  rows.push({
    kind: "start",
    code: "",
    description: input.startDescription ?? null,
    symbolKey: "start",
  });
  for (const s of afterStart) {
    rows.push({
      kind: "special",
      code: "",
      symbolKey: s.kind,
      lengthM: s.lengthM,
    });
  }

  input.controls.forEach((c, i) => {
    rows.push({
      kind: "control",
      sequence: i + 1,
      code: c.code,
      description: c.description ?? null,
    });
    for (const s of specials.filter((sp) => sp.afterControlId === c.id)) {
      rows.push({
        kind: "special",
        code: "",
        symbolKey: s.kind,
        lengthM: s.lengthM,
      });
    }
  });

  const finish = input.instructions?.finish ?? { kind: "14.3" };
  const measured =
    input.finishLengthM != null &&
    Number.isFinite(input.finishLengthM) &&
    input.finishLengthM > 0
      ? Math.round(input.finishLengthM)
      : undefined;
  rows.push({
    kind: "finish",
    code: "",
    symbolKey: finish.kind,
    lengthM: finish.lengthM ?? measured,
  });

  return { header, rows };
}

/** Drop specials that reference a control no longer on the course. */
export function pruneDescriptionInstructions(
  instructions: CourseDescriptionInstructions | null | undefined,
  controlIds: ReadonlySet<number>,
): CourseDescriptionInstructions | null {
  if (!instructions) return null;
  const specials = (instructions.specials ?? []).filter(
    (s) => s.afterControlId == null || controlIds.has(s.afterControlId),
  );
  const finish = instructions.finish;
  if (specials.length === 0 && !finish) return null;
  return {
    ...(specials.length > 0 ? { specials } : {}),
    ...(finish ? { finish } : {}),
  };
}
