/**
 * Export ▾ (docs/course-layout.md §7; research 08 §5.2, phase-1 entries):
 * this sheet (Layout mode) · this course · this class · all courses · all
 * controls · IOF XML · PPen, each on an existing route. The map entries
 * first ensure the sheets (`layout.autoSheets`), so a course without a
 * template, or an event without an all-controls sheet, exports.
 */

export type ExportId = "sheet" | "course" | "class" | "all" | "allControls" | "iofxml" | "ppen";

export interface ExportEntry {
  id: ExportId;
  url: string;
  /** `layout.autoSheets` input to run first (`{}`: every course); null: nothing to ensure. */
  ensure: { courseId?: number; allControls?: boolean } | null;
  disabled: boolean;
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
    { id: "iofxml", url: data("iofxml"), ensure: null, disabled: false },
    { id: "ppen", url: data("ppen"), ensure: null, disabled: false },
  ];
}
