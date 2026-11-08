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
 * builder — `resolve-layout.ts` builds their rows directly.
 */

import type {
  ControlDescription,
  CourseDescriptionInstructions,
  CourseOrderMode,
} from "../types.js";

/**
 * One row of a sheet's description block as `resolve-layout.ts` answers
 * it and `print/description.ts` draws it.
 */
export interface DescriptionRow {
  sequence?: number;
  code: string;
  description?: ControlDescription | null;
  /**
   * Row kind. Absent / "control" draws a normal A–H row; "start" draws
   * the triangle in A; "special" and "finish" draw `symbolKey` across the
   * full width with `lengthM`.
   */
  kind?: "start" | "control" | "special" | "finish";
  symbolKey?: string;
  lengthM?: number;
}

/** The block's size in page mm: 8 cells wide, rows plus header rows high. */
export function descriptionBlockSize(
  rowCount: number,
  cellSizeMm: number,
  headerRows = 1,
): { width: number; height: number } {
  return {
    width: cellSizeMm * 8,
    height: cellSizeMm * (rowCount + headerRows),
  };
}

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
  /**
   * Visit-order mode. Free-order sheets omit the A-column sequence
   * number on control rows (controls are listed by code only).
   */
  orderMode?: CourseOrderMode;
  /**
   * The course's legs through crossing points (`LegProps.crossing`,
   * course-layer.md §10.3), each anchored after the control the leg leaves
   * (null: the start). They derive a 13.3 row (13.4 for a section) that
   * replaces a hand-placed row of the same kind at the same anchor and
   * keeps its length; other hand-placed rows stay.
   */
  crossings?: ReadonlyArray<{ afterControlId: number | null; section: boolean }>;
  /**
   * The course's map exchanges (course-layer.md §11), each the public id
   * of the exchange control. They derive a 13.5 row after it, as the
   * crossings do (in place of a hand-placed 13.5 at the same anchor).
   */
  exchanges?: ReadonlyArray<{ afterControlId: number }>;
}

type Special = NonNullable<CourseDescriptionInstructions["specials"]>[number];

/**
 * The stored specials with the derived rows merged in (in place of a
 * same-kind row at the anchor, else after the anchor's rows): the map
 * exchanges' 13.5 first, then the crossings' 13.3 / 13.4 (the leg that
 * leaves the anchor comes after the exchange at it).
 */
export function mergeDerivedSpecials(
  stored: readonly Special[],
  crossings: BuildDescriptionSheetInput["crossings"] = [],
  exchanges: BuildDescriptionSheetInput["exchanges"] = [],
): Special[] {
  const out: Special[] = stored.map((s) => ({ ...s }));
  const derived = new Set<Special>();
  // A row per anchor and kind: the sheet repeats an anchor's rows at every visit of its control.
  const seen = new Set<string>();
  const rows = [
    ...exchanges.map((e) => ({ afterControlId: e.afterControlId as number | null, kind: "13.5" })),
    ...crossings.map((c) => ({ afterControlId: c.afterControlId, kind: c.section ? "13.4" : "13.3" })),
  ];
  for (const c of rows) {
    const kind = c.kind;
    if (seen.has(`${c.afterControlId}:${kind}`)) continue;
    seen.add(`${c.afterControlId}:${kind}`);
    const same = out.findIndex((s) => !derived.has(s) && s.kind === kind && (s.afterControlId ?? null) === c.afterControlId);
    const row: Special = { afterControlId: c.afterControlId, kind, ...(same >= 0 && out[same].lengthM !== undefined ? { lengthM: out[same].lengthM } : {}) };
    if (same >= 0) out[same] = row;
    else out.push(row);
    derived.add(row);
  }
  return out;
}

/**
 * IOF control description layout: "A thicker horizontal line should be
 * used after every third description and on either side of any special
 * instruction." Plus the header block, the start row and the finish row
 * are boxed in by thick rules. Returns true when the line *below*
 * `rows[index]` should be drawn thick:
 *  - under the start row,
 *  - under every third control (1-based ordinal among control rows —
 *    works for free-order sheets that omit `sequence`),
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
  if (row.kind === "control") {
    let ordinal = 0;
    for (let i = 0; i <= index; i++) {
      if (rows[i]?.kind === "control") ordinal++;
    }
    if (ordinal > 0 && ordinal % 3 === 0) return true;
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
  const specials = mergeDerivedSpecials(input.instructions?.specials ?? [], input.crossings, input.exchanges);

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

  const freeOrder = input.orderMode === "free_order";
  input.controls.forEach((c, i) => {
    rows.push({
      kind: "control",
      ...(freeOrder ? {} : { sequence: i + 1 }),
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
