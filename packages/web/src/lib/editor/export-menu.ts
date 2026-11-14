/**
 * Export ▾ (docs/course-layout.md §7; research 08 §5.2, phase-1 entries):
 * this sheet (Layout mode) · this course · for a root (F8) this variant,
 * all variations and one map per runner · this class · all courses · all
 * controls · setter maps · description sheets · IOF XML · PPen, each on an existing
 * route. The map entries first ensure the sheets (`layout.autoSheets`), so
 * a course without a template, or an event without an all-controls sheet,
 * exports. *Description sheets…* opens a dialog that builds its URL
 * (`descriptionSheetsUrl`; docs/course-print.md §6.4). *Make maps available
 * offline* (G17) stores every map export of the event on the device
 * (`offlineMapQueries`; course-print.md §8.6 "Offline").
 */

import type { DescriptionCopies, DescriptionSheetCell } from "@oxygen/shared";
import { normaliseQuery } from "../../print/offline-store";

export type ExportId = "sheet" | "course" | "variant" | "allVariations" | "courseRunners" | "class" | "all" | "allControls" | "setter" | "offline" | "descriptions" | "iofxml" | "ppen";

export interface ExportEntry {
  id: ExportId;
  url: string;
  /** `layout.autoSheets` input to run first (`{}`: every course); null: nothing to ensure. */
  ensure: { courseId?: number; allControls?: boolean } | null;
  disabled: boolean;
  /** Opens this dialog instead of downloading `url` at once. */
  dialog?: "descriptions";
  /** Runs this action instead of a download (G17: store the event's map exports on the device). */
  action?: "offline";
  /** Values the entry's label interpolates (F8: the variants' count, a key and its runners). */
  labelValues?: { count: number; key?: string };
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
  /** The course's variants in key order with their assigned runners (`course.variantList`, F8); empty or absent without groups. */
  variants?: readonly { key: string; runnerCount: number }[];
  /** The variant the view shows (Variant view's, or Class view / Layout mode's drawn one); null otherwise. */
  variantKey?: string | null;
}

/**
 * F8 (course-layout.md §7; 08 §5.2 "variants… · loops composite"): a
 * root's *This variant* (the view's key, `?variants=`), *All variations*
 * (the officials' page in the one purple, `?allVariations=`) and *One
 * map per runner* (the hand-out stack, `&copies=runners`), each ensuring
 * the root's sheets first; none for a course without variants.
 */
function variantEntries(
  s: ExportState,
  maps: string,
  ensure: (e: { courseId?: number }) => ExportEntry["ensure"],
  variants: readonly { key: string; runnerCount: number }[],
): ExportEntry[] {
  if (s.courseSeq === null || variants.length === 0) return [];
  const course = s.courseSeq;
  const shown = variants.find((v) => v.key === s.variantKey);
  const runners = variants.reduce((n, v) => n + v.runnerCount, 0);
  return [
    {
      id: "variant",
      url: shown ? `${maps}?${new URLSearchParams({ variants: `${course}:${shown.key}` })}` : maps,
      ensure: ensure({ courseId: course }),
      disabled: !shown,
      labelValues: { key: shown?.key ?? "", count: shown?.runnerCount ?? 0 },
    },
    { id: "allVariations", url: `${maps}?allVariations=${course}`, ensure: ensure({ courseId: course }), disabled: false },
    {
      id: "courseRunners",
      url: `${maps}?courses=${course}&copies=runners`,
      ensure: ensure({ courseId: course }),
      // No runner assigned: the route has nothing to print.
      disabled: runners === 0,
      labelValues: { count: runners },
    },
  ];
}

export function exportEntries(s: ExportState): ExportEntry[] {
  const variants = s.variants ?? [];
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
      // A root prints as its variants (course-print.md §4.6): the label says how many.
      ...(variants.length > 0 ? { labelValues: { count: variants.length } } : {}),
    },
    ...variantEntries(s, maps, ensure, variants),
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
    // Stores every map export of the event on this device (G17); the step ensures the sheets itself.
    { id: "offline", url: "", ensure: null, disabled: false, action: "offline" },
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

/** The entries that print `maps.pdf`, the ones a device can store (G17). */
const MAP_EXPORTS: ReadonlySet<ExportId> = new Set(["sheet", "course", "variant", "allVariations", "courseRunners", "class", "all", "allControls", "setter"]);

export interface OfflineQueryInput {
  nameId: string;
  /** `course.list`: a variant (`parentSeq` set) prints through its root. */
  courses: readonly { seq: number; parentSeq: number | null }[];
  /** A root's variants with their runners (`course.variantList`), by root seq. */
  variants: ReadonlyMap<number, readonly { key: string; runnerCount: number }[]>;
  /** `class.list`: the class and its course. */
  classes: readonly { seq: number; courseSeq: number | null }[];
  /** `courseMap.list`: every sheet. */
  sheetSeqs: readonly number[];
}

/**
 * Every `maps.pdf` query Export ▾ and the Courses page can issue for the
 * event (course-print.md §8.6 "Offline" step 2; the user's answer
 * 2026-11-14): `exportEntries` over each course (a root once per variant
 * shown), each class and each sheet, the map entries not disabled,
 * normalised and deduplicated in first-seen order. So the stored set
 * cannot drift from the menu.
 */
export function offlineMapQueries(input: OfflineQueryInput): string[] {
  const out = new Set<string>();
  const base: ExportState = { nameId: input.nameId, courseSeq: null, classSeq: null, sheetSeq: null, canEdit: false };
  const prefix = `/api/maps/${encodeURIComponent(input.nameId)}/maps.pdf`;
  const add = (s: ExportState) => {
    for (const e of exportEntries(s)) {
      if (!MAP_EXPORTS.has(e.id) || e.disabled || !e.url.startsWith(prefix)) continue;
      out.add(normaliseQuery(e.url.slice(prefix.length)));
    }
  };
  add(base);
  for (const c of input.courses) {
    if (c.parentSeq !== null) continue;
    const variants = input.variants.get(c.seq) ?? [];
    add({ ...base, courseSeq: c.seq, variants });
    for (const v of variants) add({ ...base, courseSeq: c.seq, variants, variantKey: v.key });
  }
  for (const k of input.classes) add({ ...base, classSeq: k.seq, courseSeq: k.courseSeq });
  for (const seq of input.sheetSeqs) add({ ...base, sheetSeq: seq });
  return [...out];
}
