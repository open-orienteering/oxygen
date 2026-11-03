/**
 * Export ▾ (docs/course-layout.md §7; research 08 §5.2, phase-1 entries):
 * this course · this class · all courses · all controls · IOF XML · PPen,
 * each on an existing route. The map entries first ensure the sheets
 * (`layout.autoSheets`), so a course without a template exports.
 */

export type ExportId = "course" | "class" | "all" | "allControls" | "iofxml" | "ppen";

export interface ExportEntry {
  id: ExportId;
  url: string;
  /** `layout.autoSheets` input to run first (`{}`: every course); null: nothing to ensure. */
  ensure: { courseId?: number } | null;
  disabled: boolean;
}

export interface ExportState {
  nameId: string;
  /** The top bar's course (seq). */
  courseSeq: number | null;
  /** Class view's class (seq). */
  classSeq: number | null;
  /** `courses.edit`: may create sheets; without it the map entries export what exists. */
  canEdit: boolean;
}

export function exportEntries(s: ExportState): ExportEntry[] {
  const maps = `/api/maps/${encodeURIComponent(s.nameId)}/maps.pdf`;
  const data = (format: "iofxml" | "ppen") => `/api/export/course-data?${new URLSearchParams({ name: s.nameId, format })}`;
  const ensure = (e: { courseId?: number }) => (s.canEdit ? e : null);
  return [
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
    // Without an all-controls sheet the route answers "No maps found", shown on the error line.
    { id: "allControls", url: `${maps}?allControls=1`, ensure: null, disabled: false },
    { id: "iofxml", url: data("iofxml"), ensure: null, disabled: false },
    { id: "ppen", url: data("ppen"), ensure: null, disabled: false },
  ];
}
