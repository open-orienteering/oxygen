/**
 * Export ▾ (docs/course-layout.md §7; research 08 §5.2, phase-1 entries):
 * this sheet (Layout mode) · this course · this class · all courses · all
 * controls · setter maps · description sheets · IOF XML · PPen, each on an existing
 * route. The map entries first ensure the sheets (`layout.autoSheets`), so
 * a course without a template, or an event without an all-controls sheet,
 * exports. *Description sheets…* opens a dialog that builds its URL
 * (`descriptionSheetsUrl`; docs/course-print.md §6.4).
 */

import type { DescriptionCopies, DescriptionSheetCell } from "@oxygen/shared";

export type ExportId = "sheet" | "course" | "class" | "all" | "allControls" | "setter" | "descriptions" | "iofxml" | "ppen";

export interface ExportEntry {
  id: ExportId;
  url: string;
  /** `layout.autoSheets` input to run first (`{}`: every course); null: nothing to ensure. */
  ensure: { courseId?: number; allControls?: boolean } | null;
  disabled: boolean;
  /** Opens this dialog instead of downloading `url` at once. */
  dialog?: "descriptions";
}

export interface ExportState {
  nameId: string;
  /** The top bar's course (seq). */
  courseSeq: number | null;
  /** Class view's class (seq). */
  classSeq: number | null;
  /** Layout mode's shown sheet (seq); null outside Layout mode or on a template. */
  sheetSeq: number | null;
  /** `courses.edit`: may create sheets; without it the map entries export what exists. */
  canEdit: boolean;
}

export function exportEntries(s: ExportState): ExportEntry[] {
  const maps = `/api/maps/${encodeURIComponent(s.nameId)}/maps.pdf`;
  const data = (format: "iofxml" | "ppen") => `/api/export/course-data?${new URLSearchParams({ name: s.nameId, format })}`;
  const ensure = (e: { courseId?: number; allControls?: boolean }) => (s.canEdit ? e : null);
  return [
    // The sheet as it is: it exists, so nothing to ensure.
    {
      id: "sheet",
      url: s.sheetSeq === null ? maps : `${maps}?maps=${s.sheetSeq}`,
      ensure: null,
      disabled: s.sheetSeq === null,
    },
    {
      id: "course",
      url: s.courseSeq === null ? maps : `${maps}?courses=${s.courseSeq}`,
      ensure: s.courseSeq === null ? null : ensure({ courseId: s.courseSeq }),
      disabled: s.courseSeq === null,
    },
    {
      id: "class",
      url: s.classSeq === null ? maps : `${maps}?classes=${s.classSeq}`,
      ensure: s.classSeq === null || s.courseSeq === null ? null : ensure({ courseId: s.courseSeq }),
      disabled: s.classSeq === null,
    },
    { id: "all", url: maps, ensure: ensure({}), disabled: false },
    // Without courses.edit and without an all-controls sheet the route answers "No maps found", shown on the error line.
    { id: "allControls", url: `${maps}?allControls=1`, ensure: ensure({ allControls: true }), disabled: false },
    // Every setter sheet (F10). Generating them needs a group count (Layout mode's Setter maps), so nothing is
    // ensured: without any the route's "No setter maps found" shows on the error line.
    { id: "setter", url: `${maps}?setter=1`, ensure: null, disabled: false },
    // Printed on demand from the dialog's options; no sheet row to ensure (course-print.md §6.4).
    { id: "descriptions", url: `/api/maps/${encodeURIComponent(s.nameId)}/descriptions.pdf`, ensure: null, disabled: false, dialog: "descriptions" },
    { id: "iofxml", url: data("iofxml"), ensure: null, disabled: false },
    { id: "ppen", url: data("ppen"), ensure: null, disabled: false },
  ];
}

/** `descriptions.pdf` for the dialog's choice (docs/course-print.md §6.4): always explicit classes. */
export function descriptionSheetsUrl(nameId: string, o: { classSeqs: readonly number[]; copies: DescriptionCopies; cell: DescriptionSheetCell; gap?: number }): string {
  const q = new URLSearchParams({ classes: o.classSeqs.join(","), copies: String(o.copies), cell: String(o.cell) });
  if (o.gap !== undefined) q.set("gap", String(o.gap));
  return `/api/maps/${encodeURIComponent(nameId)}/descriptions.pdf?${q}`;
}
