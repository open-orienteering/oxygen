/**
 * The course import's plan (review package 17, decision D3,
 * course-layer.md §6.4 "Import semantics"): what a course file would do to
 * the event, worked out before anything is written. `previewImport` returns
 * it as the dialog's consequence list for both modes; `importCourses`
 * rebuilds it inside its transaction and writes exactly what it says.
 *
 * Pure apart from `loadImportState`, which reads the event's rows.
 */
import { course as courseShared, isStartOrFinish } from "@oxygen/shared";
import type { Prisma, PrismaClient } from "./generated/prisma/client.js";
import type { ParsedControl, ParsedCourse, ParsedCourseData } from "./iof-course-parser.js";

type Db = PrismaClient | Prisma.TransactionClient;

// ─── State ──────────────────────────────────────────────────

export interface StateControl {
  id: string;
  seq: number;
  name: string;
  codes: string;
  kind: string;
  status: string;
  removed: boolean;
  xpos: number;
  ypos: number;
}

export interface StateCourse {
  id: string;
  name: string;
  removed: boolean;
  lengthM: number;
  /** Has a variation in its structure or a live materialised variant (§12). */
  forked: boolean;
  /** Live variant course ids. */
  variantIds: string[];
}

export interface StateClass {
  id: string;
  seq: number;
  name: string;
  courseId: string | null;
}

export interface ImportState {
  /** Live rows first, then removed ones newest first. */
  controls: StateControl[];
  /** Root courses: live first, then removed newest first. */
  courses: StateCourse[];
  classes: StateClass[];
  /** Live runners per `course_id`. */
  runnersByCourse: Map<string, number>;
}

export async function loadImportState(db: Db, eventId: bigint): Promise<ImportState> {
  const [controls, roots, variants, classes, runners] = await Promise.all([
    db.control.findMany({
      where: { eventId },
      orderBy: [{ removed: "asc" }, { updatedAt: "desc" }, { seq: "desc" }],
      select: { id: true, seq: true, name: true, codes: true, kind: true, status: true, removed: true, xpos: true, ypos: true },
    }),
    db.course.findMany({
      where: { eventId, parentCourseId: null },
      orderBy: [{ removed: "asc" }, { updatedAt: "desc" }, { seq: "desc" }],
      select: { id: true, name: true, removed: true, lengthM: true, structure: true },
    }),
    db.course.findMany({
      where: { eventId, removed: false, parentCourseId: { not: null } },
      select: { id: true, parentCourseId: true },
    }),
    db.class.findMany({
      where: { eventId, removed: false },
      orderBy: { seq: "asc" },
      select: { id: true, seq: true, name: true, courseId: true },
    }),
    db.runner.groupBy({
      by: ["courseId"],
      where: { eventId, removed: false, courseId: { not: null } },
      _count: { _all: true },
    }),
  ]);
  const variantsOf = new Map<string, string[]>();
  for (const v of variants) {
    const list = variantsOf.get(v.parentCourseId!) ?? [];
    list.push(v.id);
    variantsOf.set(v.parentCourseId!, list);
  }
  return {
    controls: controls.map((c) => ({ ...c, kind: String(c.kind), status: String(c.status) })),
    courses: roots.map((c) => {
      const parsed = c.structure ? courseShared.courseStructureSchema.safeParse(c.structure) : null;
      const variantIds = c.removed ? [] : variantsOf.get(c.id) ?? [];
      const forked = !c.removed && ((parsed?.success && courseShared.hasVariations(parsed.data)) || variantIds.length > 0);
      return { id: c.id, name: c.name, removed: c.removed, lengthM: c.lengthM, forked, variantIds };
    }),
    classes,
    runnersByCourse: new Map(runners.map((r) => [r.courseId!, r._count._all])),
  };
}

// ─── File checks ────────────────────────────────────────────

export type ImportBlockerCode =
  | "no_courses"
  | "duplicate_control"
  | "duplicate_start_finish"
  | "duplicate_crossing"
  | "duplicate_course"
  | "held_code";

export interface ImportBlocker {
  code: ImportBlockerCode;
  ids: string[];
  /** held_code: the start / finish holding each code, by index. */
  holders?: string[];
}

/** The name Oxygen gives an imported start / finish ("Start 2", "Mål 1"). */
export function startFinishName(pc: Pick<ParsedControl, "id" | "type">): string {
  const suffix = pc.id.match(/(\d+)\s*$/)?.[1] ?? "1";
  const n = parseInt(suffix, 10);
  return pc.type === "Start" ? (n > 1 ? `Start ${suffix}` : "Start 1") : n > 1 ? `Mål ${suffix}` : "Mål 1";
}

function duplicates(keys: Array<[key: string, label: string]>): string[][] {
  const groups = new Map<string, string[]>();
  for (const [key, label] of keys) {
    const list = groups.get(key) ?? [];
    list.push(label);
    groups.set(key, list);
  }
  return [...groups.values()].filter((g) => g.length > 1);
}

/**
 * The refusals a file earns on its own (course-layer.md §6.4): nothing is
 * written when any applies, in either mode.
 */
export function fileBlockers(parsed: Pick<ParsedCourseData, "controls" | "courses">, opts: { replaceAll: boolean }): ImportBlocker[] {
  const out: ImportBlocker[] = [];
  // Zero courses would wipe the event under Replace all (a map file picked
  // by mistake); under Merge a file of controls only updates their positions.
  if (parsed.courses.length === 0 && (opts.replaceAll || parsed.controls.length === 0)) {
    out.push({ code: "no_courses", ids: [] });
  }
  const norm = (s: string) => s.trim().toLowerCase();
  for (const g of duplicates(parsed.controls.filter((c) => c.type === "Control").map((c) => [norm(c.id), c.id]))) {
    out.push({ code: "duplicate_control", ids: g });
  }
  for (const g of duplicates(
    parsed.controls.filter((c) => c.type === "Start" || c.type === "Finish").map((c) => [startFinishName(c).toLowerCase(), c.id]),
  )) {
    out.push({ code: "duplicate_start_finish", ids: g });
  }
  for (const g of duplicates(parsed.controls.filter((c) => c.type === "CrossingPoint").map((c) => [norm(c.id), c.id]))) {
    out.push({ code: "duplicate_crossing", ids: g });
  }
  for (const g of duplicates(parsed.courses.map((c) => [norm(c.name), c.name]))) {
    out.push({ code: "duplicate_course", ids: g });
  }
  return out;
}

/** A file control whose code a live start / finish holds (F32): refused. */
export function heldCodeBlockers(parsed: Pick<ParsedCourseData, "controls">, state: ImportState): ImportBlocker[] {
  const held = new Map<number, string>();
  for (const c of state.controls) {
    if (c.removed || !isStartOrFinish(c)) continue;
    for (const part of c.codes.split(";")) {
      const n = parseInt(part.trim(), 10);
      if (Number.isFinite(n) && n > 0) held.set(n, c.name);
    }
  }
  const ids: string[] = [];
  const holders: string[] = [];
  for (const pc of parsed.controls) {
    if (pc.type !== "Control") continue;
    const n = parseInt(pc.id, 10);
    if (String(n) === pc.id.trim() && held.has(n)) {
      ids.push(String(n));
      holders.push(held.get(n)!);
    }
  }
  return ids.length ? [{ code: "held_code", ids, holders }] : [];
}

/**
 * A class may follow one course: a mapping that puts one class under two
 * course names is refused (the last would silently win). Returns the
 * offending class seq with its course names, or null.
 */
export function classMappingConflict(mapping: Record<string, number[]> | undefined): { classSeq: number; courseNames: string[] } | null {
  if (!mapping) return null;
  const coursesOf = new Map<number, Set<string>>();
  for (const [courseName, seqs] of Object.entries(mapping)) {
    for (const seq of seqs) {
      if (seq <= 0) continue;
      const set = coursesOf.get(seq) ?? new Set<string>();
      set.add(courseName);
      coursesOf.set(seq, set);
    }
  }
  for (const [classSeq, names] of coursesOf) {
    if (names.size > 1) return { classSeq, courseNames: [...names] };
  }
  return null;
}

// ─── Plan ───────────────────────────────────────────────────

export interface ModeConsequences {
  coursesAdded: string[];
  coursesUpdated: string[];
  coursesRestored: string[];
  coursesRemoved: string[];
  /** Merge: a local forked course is left as it is (the file cannot carry forks). */
  coursesSkippedForked: string[];
  /** Replace all: a local forked course becomes the file's linear course. */
  coursesFlattened: Array<{ name: string; variants: number; runners: number }>;
  /** Stated length differs from the stored one. */
  coursesLengthChanged: Array<{ name: string; fromM: number; toM: number }>;
  /** The file states no length: the stored one stays. */
  coursesKeepingLength: string[];
  /** A new course with no stated length: derived from its controls. */
  coursesLengthDerived: string[];
  controlsAdded: number;
  controlsUpdated: number;
  controlsRestored: number;
  controlsRemoved: string[];
  /** Matched controls that keep a non-OK status or extra codes. */
  controlsKeepingSettings: Array<{ code: string; status: string; codes: string }>;
  controlsMovedFar: Array<{ code: string; metres: number }>;
  runnersLosingVariant: number;
  runnersOnRemovedCourse: number;
  /** Classes whose course goes, before the operator's mapping is applied. */
  classesUnassigned: Array<{ seq: number; name: string; courseName: string }>;
}

export interface ImportPlan {
  /** Parsed control id → the row it updates (undefined: created). */
  controlMatch: Map<string, StateControl | undefined>;
  /** Parsed course name → the root it updates (undefined: created). */
  courseMatch: Map<string, StateCourse | undefined>;
  /** Parsed course names whose row and structure are left alone (Merge, forked). */
  skippedCourseNames: Set<string>;
  removeCourseIds: string[];
  removeControlIds: string[];
  unassignClassIds: string[];
  consequences: ModeConsequences;
}

/** A control the file moves this far under the same code may be another control. */
export const MOVED_FAR_METRES = 50;

const label = (c: StateControl) => c.codes.split(";")[0] || c.name || c.id;

/** A length the file states (a 0 or missing `<Length>` is none). */
export const statedLength = (pc: Pick<ParsedCourse, "length">) => Math.round(pc.length) > 0;

export function planCourseImport(
  parsed: Pick<ParsedCourseData, "controls" | "courses" | "mapScale">,
  state: ImportState,
  opts: { replaceAll: boolean; comparePositions: boolean },
): ImportPlan {
  const { replaceAll } = opts;
  const c: ModeConsequences = {
    coursesAdded: [], coursesUpdated: [], coursesRestored: [], coursesRemoved: [], coursesSkippedForked: [],
    coursesFlattened: [], coursesLengthChanged: [], coursesKeepingLength: [], coursesLengthDerived: [],
    controlsAdded: 0, controlsUpdated: 0, controlsRestored: 0, controlsRemoved: [], controlsKeepingSettings: [],
    controlsMovedFar: [], runnersLosingVariant: 0, runnersOnRemovedCourse: 0, classesUnassigned: [],
  };

  // ── Controls: a live row before a removed one (state order) ──
  const ordinary = new Map<string, StateControl>();
  const ends = new Map<string, StateControl>();
  const crossings = new Map<string, StateControl>();
  for (const row of state.controls) {
    if (row.kind === "crossing_point") {
      const key = row.name.toLowerCase();
      if (key && !crossings.has(key)) crossings.set(key, row);
    } else if (isStartOrFinish(row)) {
      // A start / finish is keyed by its name only: its unit code (F32) is never a file id.
      const key = row.name.toLowerCase();
      if (key && !ends.has(key)) ends.set(key, row);
    } else {
      for (const code of row.codes.split(";").map((s) => s.trim().toLowerCase()).filter(Boolean)) {
        if (!ordinary.has(code)) ordinary.set(code, row);
      }
    }
  }
  const controlMatch = new Map<string, StateControl | undefined>();
  const matchedControlIds = new Set<string>();
  for (const pc of parsed.controls) {
    const row =
      pc.type === "CrossingPoint"
        ? crossings.get(pc.id.toLowerCase())
        : pc.type === "Control"
          ? ordinary.get(pc.id.trim().toLowerCase())
          : ends.get(startFinishName(pc).toLowerCase());
    controlMatch.set(pc.id, row);
    if (!row) {
      c.controlsAdded++;
      continue;
    }
    if (matchedControlIds.has(row.id)) continue; // two file ids on one site ("31;131")
    matchedControlIds.add(row.id);
    if (row.removed) c.controlsRestored++;
    else c.controlsUpdated++;
    if (pc.type === "Control" && (row.status !== "ok" || row.codes.includes(";"))) {
      c.controlsKeepingSettings.push({ code: pc.id, status: row.status, codes: row.codes });
    }
    if (
      opts.comparePositions &&
      pc.type === "Control" &&
      !row.removed &&
      (row.xpos !== 0 || row.ypos !== 0) &&
      (pc.mapX !== 0 || pc.mapY !== 0)
    ) {
      const metres = (Math.hypot(pc.mapX - row.xpos, pc.mapY - row.ypos) * (parsed.mapScale || 0)) / 1000;
      if (metres > MOVED_FAR_METRES) c.controlsMovedFar.push({ code: pc.id, metres: Math.round(metres) });
    }
  }

  // ── Courses ──
  const byName = new Map<string, StateCourse>();
  for (const row of state.courses) {
    const key = row.name.toLowerCase();
    if (!byName.has(key)) byName.set(key, row);
  }
  const forkedRootNames = new Set(state.courses.filter((r) => r.forked).map((r) => r.name.toLowerCase()));
  const runnersOn = (ids: string[]) => ids.reduce((n, id) => n + (state.runnersByCourse.get(id) ?? 0), 0);

  const courseMatch = new Map<string, StateCourse | undefined>();
  const skippedCourseNames = new Set<string>();
  const matchedCourseIds = new Set<string>();
  for (const pc of parsed.courses) {
    const row = byName.get(pc.name.toLowerCase());
    courseMatch.set(pc.name, row);
    if (row) matchedCourseIds.add(row.id);
    // Merge leaves a local fork alone, and a file variant of it (an Oxygen
    // export lists "A AB" with family "A") is not a new top-level course.
    if (!replaceAll && (row?.forked || (!row && pc.family && forkedRootNames.has(pc.family.toLowerCase())))) {
      skippedCourseNames.add(pc.name);
      c.coursesSkippedForked.push(pc.name);
      continue;
    }
    if (!row) c.coursesAdded.push(pc.name);
    else if (row.removed) c.coursesRestored.push(pc.name);
    else c.coursesUpdated.push(pc.name);
    if (row?.forked) {
      const runners = runnersOn(row.variantIds);
      c.coursesFlattened.push({ name: row.name, variants: row.variantIds.length, runners });
      c.runnersLosingVariant += runners;
    }
    if (statedLength(pc)) {
      if (row && !row.removed && row.lengthM > 0 && row.lengthM !== Math.round(pc.length)) {
        c.coursesLengthChanged.push({ name: pc.name, fromM: row.lengthM, toM: Math.round(pc.length) });
      }
    } else if (row) c.coursesKeepingLength.push(pc.name);
    else c.coursesLengthDerived.push(pc.name);
  }

  // ── What Replace all removes ──
  const removeCourseIds: string[] = [];
  const removeControlIds: string[] = [];
  const unassignClassIds: string[] = [];
  if (replaceAll) {
    const removedById = new Map<string, string>();
    for (const row of state.courses) {
      if (row.removed || matchedCourseIds.has(row.id)) continue;
      removeCourseIds.push(row.id, ...row.variantIds);
      removedById.set(row.id, row.name);
      for (const v of row.variantIds) removedById.set(v, row.name);
      c.coursesRemoved.push(row.name);
      c.runnersLosingVariant += runnersOn(row.variantIds);
      c.runnersOnRemovedCourse += state.runnersByCourse.get(row.id) ?? 0;
    }
    for (const row of state.controls) {
      if (row.removed || matchedControlIds.has(row.id)) continue;
      removeControlIds.push(row.id);
      c.controlsRemoved.push(label(row));
    }
    for (const cl of state.classes) {
      const courseName = cl.courseId ? removedById.get(cl.courseId) : undefined;
      if (courseName === undefined) continue;
      unassignClassIds.push(cl.id);
      c.classesUnassigned.push({ seq: cl.seq, name: cl.name, courseName });
    }
  }

  return { controlMatch, courseMatch, skippedCourseNames, removeCourseIds, removeControlIds, unassignClassIds, consequences: c };
}

// ─── Class pre-selection ────────────────────────────────────

export type ClassPreselectWarning = {
  code: "class_on_fork_variants" | "class_on_several_courses";
  className: string;
  courseNames: string[];
};

/**
 * Which preview rows the dialog pre-selects. A substring match is shown
 * but never pre-selected ("D1" is not "D10"); an event class the file puts
 * on several courses is pre-selected on none, since the server refuses a
 * class mapped twice. When those courses are one file family (Oxygen's own
 * export lists a class once per fork variant) the class stays unassigned
 * with its own message: forks are not imported.
 */
export function classPreselection(
  rows: Array<{ courseName: string; className: string; dbClassSeq: number; matchType: string }>,
  familyOf: (courseName: string) => string | undefined,
): { preselect: boolean[]; warnings: ClassPreselectWarning[] } {
  const preselect = rows.map((r) => r.dbClassSeq > 0 && (r.matchType === "exact" || r.matchType === "normalized"));
  const coursesOf = new Map<number, Set<string>>();
  rows.forEach((r, i) => {
    if (!preselect[i]) return;
    const set = coursesOf.get(r.dbClassSeq) ?? new Set<string>();
    set.add(r.courseName);
    coursesOf.set(r.dbClassSeq, set);
  });
  const warnings: ClassPreselectWarning[] = [];
  for (const [seq, names] of coursesOf) {
    if (names.size < 2) continue;
    const courseNames = [...names];
    const families = new Set(courseNames.map((n) => familyOf(n)));
    const sameFamily = families.size === 1 && !families.has(undefined);
    const className = rows.find((r) => r.dbClassSeq === seq && preselect[rows.indexOf(r)])!.className;
    warnings.push({ code: sameFamily ? "class_on_fork_variants" : "class_on_several_courses", className, courseNames });
    rows.forEach((r, i) => {
      if (r.dbClassSeq === seq) preselect[i] = false;
    });
  }
  return { preselect, warnings };
}
