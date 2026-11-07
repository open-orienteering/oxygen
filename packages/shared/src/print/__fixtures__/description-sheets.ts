/**
 * Description-sheet fixtures (docs/course-print.md §6.4, §7.5): blocks
 * built by `buildDescriptionSheet` as the map page builds them, and the
 * `descriptions-a4` golden scene — one class at 6 mm cells, `fill`, so
 * a full A4 of 3 × 4 blocks.
 */

import { buildDescriptionSheet } from "../../course-maps/description-rows.js";
import type { ControlDescription } from "../../types.js";
import type { DescriptionSheetBlock, DescriptionSheetOptions } from "../description-sheet.js";

const DESCRIPTIONS: ControlDescription[] = [
  { d: "1.010" },
  { c: "0.003", d: "3.002", g: "11.104" },
  { d: "2.004", s: "1,5" },
  { d: "1.010", e: "8.001" },
];

/**
 * One class's block: start, `controls` controls (codes 31…) and the
 * finish, under the IOF header — the sprint page's rows when `controls` = 4.
 */
export function descriptionSheetBlock(label: string, opts: { controls?: number; count?: number; classNames?: string[] } = {}): DescriptionSheetBlock {
  const n = opts.controls ?? 4;
  const sheet = buildDescriptionSheet({
    eventName: "Sprint-SM",
    classNames: opts.classNames ?? [label],
    courseName: "A",
    lengthM: 2400,
    climbM: 15,
    controls: Array.from({ length: n }, (_, i) => ({ id: i + 1, code: String(31 + i), description: DESCRIPTIONS[i % DESCRIPTIONS.length] })),
    finishLengthM: 120,
  });
  return { label, rows: sheet.rows, header: sheet.header, title: "A", count: opts.count ?? 1 };
}

/** The `descriptions-a4` golden: one class, 6 mm cells, 5 mm gap, a filled sheet (12 blocks). */
export function descriptionSheetScene(): { blocks: DescriptionSheetBlock[]; options: DescriptionSheetOptions } {
  return { blocks: [descriptionSheetBlock("H21")], options: { cellSizeMm: 6, gapMm: 5, copies: "fill" } };
}
