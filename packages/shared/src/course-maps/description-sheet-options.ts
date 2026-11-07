/**
 * The options of a description-sheet print (docs/course-print.md §6.4):
 * one definition for the route (`descriptions.pdf`), the tiling
 * (`@oxygen/shared/print`) and the web dialog, which must not import the
 * print module at runtime (it keeps the PDF library out of the bundle).
 */

/** The cell sizes offered, mm (08 §4.6: 5–7 mm). */
export const DESCRIPTION_SHEET_CELLS = [5, 6, 7] as const;
export type DescriptionSheetCell = (typeof DESCRIPTION_SHEET_CELLS)[number];
/** The default cell size, mm. */
export const DESCRIPTION_SHEET_DEFAULT_CELL: DescriptionSheetCell = 6;
/** Default space between two blocks, mm. */
export const DESCRIPTION_SHEET_DEFAULT_GAP_MM = 5;
/** Largest space between two blocks, mm. */
export const DESCRIPTION_SHEET_MAX_GAP_MM = 30;
/** Most copies one `copies=<n>` asks for. */
export const DESCRIPTION_SHEET_MAX_COPIES = 500;

/** `count`: the class's runners + vacancies; `fill`: one sheet's worth; a number: that many. */
export type DescriptionCopies = "count" | "fill" | number;
