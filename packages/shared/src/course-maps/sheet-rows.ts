/**
 * Course-map rows → sheets (docs/course-print.md §4.6, §5; course-layout.md
 * §6–§8): a `course_maps` row with its template and course, as one class,
 * one variant or the all-variations page prints it, turned into the
 * `resolveSheet` input — the course's start and finish by the one sequence
 * rule, its controls, crossings, course objects in scope, the shared
 * window of a root's pages, a setter sheet's group. What `maps.pdf` and the
 * editor's `courseMap.resolveSheet` read; pure and isomorphic
 * (docs/course-print.md §1, G13), so the browser builds the same sheets.
 */

import { z } from "zod";
import * as course from "../course/index.js";
import { type StoredCourseObject, objectsInScope } from "../course/objects.js";
import { rowKind } from "../course/sequence.js";
import { type LayoutControlSource, type LayoutTemplateSource, centerOfControls, layoutControlsFromCourseControls, layoutCourseEnds, layoutCrossings } from "./resolve-layout.js";
import { type ResolveSheetInput, type SheetInput, allVariationNumbers, resolveSheet } from "./resolve-sheet.js";
import { courseMapObjectSchema, courseMapOverridesSchema, setterSheetPropsSchema } from "./schema.js";

const mapObjectsSchema = z.array(courseMapObjectSchema);

/** The fields of a `course_maps` row (with template and course) a sheet reads — what `maps.pdf` loads today. */
export interface PrintMapRow {
  name: string;
  kind: string;
  /** `course_maps.section_index`: the part of a course split by map exchanges (course-layer.md §11); absent = 0. */
  sectionIndex?: number;
  /** `course_maps.props`: a setter sheet's group (`setterSheetPropsSchema`, docs/course-layout.md §8); absent = `{}`. */
  props?: unknown;
  overrides: unknown;
  objects: unknown;
  windowCenter: unknown;
  /** F8: the variant this page prints (`rowForVariant`; `{variant}`, course-print.md §4.6). */
  variantKey?: string;
  /** F8: a variant page's root structure (`rowForVariant`): the shared window centres on every alternative. */
  rootStructure?: unknown;
  /** F8: the all-variations page of a root (`allVariationsRow`): its variants' keys. */
  allVariations?: { keys: string[] };
  template: LayoutTemplateSource | null;
  course: {
    id?: string | number | bigint;
    name: string;
    lengthM: number;
    climbM: number;
    orderMode: "ordered" | "free_order";
    /** `courses.structure` JSONB: the sequence's ends and the authored leg gaps (NULL = the columns below). */
    structure?: unknown;
    startName: string;
    finishControlId: string | null;
    firstAsStart: boolean;
    lastAsFinish: boolean;
    descriptionInstructions: unknown;
    classes: Array<{ name: string }>;
    courseControls: Array<{ control: LayoutControlSource; labelDx?: number | null; labelDy?: number | null }>;
  } | null;
}

/** A class's print override (docs/course-layout.md §6; 08 §4.4). */
export interface ClassPrint {
  name: string;
  printScale: number | null;
  /** The class's `sheet_template_id` row. */
  sheetTemplate: LayoutTemplateSource | null;
}

/**
 * A sheet as one class prints it (docs/course-layout.md §6): the
 * description header names that class only. A class sheet
 * (`course_maps.class_id`) already carries the class's template and scale;
 * a course sheet printed for a class (the class has no sheets of its own)
 * takes them here — the template `sheet_template_id ?? the sheet's`, the
 * scale `print_scale ??` the template's. Both pipelines print the result.
 */
export function rowForClass<R extends PrintMapRow>(row: R, cls: ClassPrint, classSheet: boolean): R {
  const course = row.course ? { ...row.course, classes: [{ name: cls.name }] } : null;
  if (classSheet) return { ...row, course };
  const overrides = { ...((row.overrides ?? {}) as Record<string, unknown>) };
  if (cls.printScale !== null) overrides.printScale = cls.printScale;
  else if (cls.sheetTemplate) delete overrides.printScale;
  return { ...row, course, template: cls.sheetTemplate ?? row.template, overrides };
}

/** The fields of a materialised variant (a child `courses` row, course-layer.md §12) a variant page reads. */
export type VariantCourse = Pick<
  NonNullable<PrintMapRow["course"]>,
  "name" | "lengthM" | "climbM" | "orderMode" | "structure" | "startName" | "finishControlId" | "firstAsStart" | "lastAsFinish" | "descriptionInstructions" | "courseControls"
> & { variantKey: string | null };

/**
 * A root's sheet as one variant prints it (course-print.md §4.6, F8; 08
 * §4.6 "the sheet shared by variants"): the row's layout, template and
 * window, the course drawn and described from the materialised child —
 * its name `<root> <key>` (page label, outline, block header, `{course}`),
 * its linear structure, controls, label offsets, length — and `{variant}`
 * the key. The course's id and classes stay the root's: course objects
 * are scoped to the root, and a class prints its root (`rowForClass` first).
 */
export function rowForVariant<R extends PrintMapRow>(row: R, child: VariantCourse): R {
  if (!row.course) return row;
  // Field by field: a child row carries its own id and (no) classes, which stay the root's.
  const fields: Omit<VariantCourse, "variantKey"> = {
    name: child.name,
    lengthM: child.lengthM,
    climbM: child.climbM,
    orderMode: child.orderMode,
    structure: child.structure,
    startName: child.startName,
    finishControlId: child.finishControlId,
    firstAsStart: child.firstAsStart,
    lastAsFinish: child.lastAsFinish,
    descriptionInstructions: child.descriptionInstructions,
    courseControls: child.courseControls,
  };
  return { ...row, variantKey: child.variantKey ?? "", rootStructure: row.course.structure, course: { ...row.course, ...fields } };
}

/** The keys as the all-variations page names them: `AB/BA`, a long list cut after five (`AA/AB/AC/BA/BB/…`). */
export function allVariationsSuffix(keys: readonly string[]): string {
  return keys.length <= 5 ? keys.join("/") : `${keys.slice(0, 5).join("/")}/…`;
}

/**
 * A root's sheet as the all-variations page (course-print.md §4.6, F8;
 * answer 4): every alternative drawn in the one purple for officials, the
 * name `<root> <keys>`, `{variant}` the keys.
 */
export function allVariationsRow<R extends PrintMapRow>(row: R, keys: readonly string[]): R {
  if (!row.course) return row;
  return { ...row, allVariations: { keys: [...keys] }, course: { ...row.course, name: `${row.course.name} ${allVariationsSuffix(keys)}` } };
}

/**
 * The all-variations page's controls: every control any alternative
 * visits, once, in first-seen order — the root's own rows (label offsets)
 * where it has them, else the event's control — without the course's
 * start and finish. When the variants number alike (F15; the page's
 * `viewOptions.labels`, `allVariationNumbers`) each row carries its number
 * and the rows are listed by it — two rows may share one, first-seen order
 * within a number; unnumbered rows (unplaced) come last.
 */
function allVariationControls(
  c: NonNullable<PrintMapRow["course"]>,
  allControls: MapRowContext["allControls"],
  ends: { start: LayoutControlSource | null; finish: LayoutControlSource | null } | null,
): LayoutControlSource[] {
  const parsed = c.structure ? course.courseStructureSchema.safeParse(c.structure) : null;
  const own = layoutControlsFromCourseControls(c.courseControls);
  if (!parsed?.success) return own;
  const byOwn = new Map(own.map((row) => [row.id, row]));
  const byId = new Map(allControls.map((row) => [row.id, row]));
  const skip = new Set([ends?.start?.id, ends?.finish?.id].filter((id): id is string => !!id));
  const out: LayoutControlSource[] = [];
  const seen = new Set<string>();
  const visit = (siteId: string) => {
    if (seen.has(siteId) || skip.has(siteId)) return;
    seen.add(siteId);
    const row = byOwn.get(siteId) ?? byId.get(siteId);
    if (row) out.push(row);
  };
  for (const item of parsed.data.items) {
    if (item.kind === "variation") for (const alt of item.alternatives) for (const x of alt.items) visit(x.siteId);
    else visit(item.siteId);
  }
  const labels = course.hasVariations(parsed.data)
    ? allVariationNumbers(parsed.data, (id) => {
        const row = byId.get(id);
        return row && { kind: rowKind({ kind: row.kind ?? "control", status: row.status ?? "" }), positioned: row.xpos !== 0 || row.ypos !== 0 };
      })
    : null;
  if (!labels) return out;
  const numbered = out.map((row) => ({ ...row, ...(labels[row.id] !== undefined ? { sequence: Number(labels[row.id]) } : {}) }));
  // Array#sort is stable: first-seen order holds within a number.
  const key = (row: { sequence?: number }) => row.sequence ?? Infinity;
  return numbered.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
}

/**
 * The window centre a root's pages share (course-print.md §4.6): the
 * middle of every site any alternative visits and the course's ends —
 * what a NULL centre of the all-variations page is, so every variant page
 * shows the same window. Null (the page centres as any course) without
 * groups, or for a course split by map exchanges (its parts centre on
 * their own controls, course-layer.md §11).
 */
export function sharedWindowCentre(
  structure: unknown,
  ends: { start: LayoutControlSource | null; finish: LayoutControlSource | null } | null,
  allControls: MapRowContext["allControls"],
): { x: number; y: number } | null {
  const parsed = structure ? course.courseStructureSchema.safeParse(structure) : null;
  if (!parsed?.success || !course.hasVariations(parsed.data)) return null;
  const ids = new Set([...course.structureSiteIds(parsed.data), ends?.start?.id, ends?.finish?.id]);
  const sites = allControls.filter((c) => ids.has(c.id) && (c.xpos !== 0 || c.ypos !== 0) && c.kind !== "crossing_point" && c.kind !== "map_issue");
  if (sites.some((c) => c.kind === "map_exchange")) return null;
  return centerOfControls(sites.map((c) => ({ x: c.xpos, y: c.ypos })));
}

/** What `sheetForMapRow` and the editor's `courseMap.resolveSheet` read besides the row. */
export interface MapRowContext {
  event: { name: string; date: Date };
  /** The event's live controls; `name` and `kind` resolve a course's start and finish (`layoutCourseEnds`). */
  allControls: Array<LayoutControlSource & { name: string; kind: string }>;
  /** Null fields without a base map (the editor's read; `maps.pdf` always has one). */
  mapInfo: { scale: number | null; meridianTiltDeg: number | null };
  courseObjects?: readonly StoredCourseObject[];
  classesByCourse?: ReadonlyMap<string, string[]>;
  /** `Event.autoOverprintCuts`; `false` = no automatic cuts on the sheet (course-layer.md §3.4). Absent = on. */
  autoCuts?: boolean;
}

/**
 * One map row → the `resolveSheet` input: the course's start and finish
 * by the one sequence rule over `ctx.allControls` (`layoutCourseEnds`;
 * docs/course-print.md §5.2), never the stored GeoJSON. `courseObjects` are the
 * event's (`loadCourseObjects`); the sheet takes those in scope of its
 * course, or the `all`-scoped ones for an all-controls sheet
 * (course-layer.md §8.3).
 */
export function sheetInputForMapRow(row: PrintMapRow, ctx: MapRowContext): ResolveSheetInput {
  if (!row.template) throw new Error(`Map "${row.name}" has no template`);
  if (row.kind === "setter") return setterSheetInput(row, ctx);
  const courseUuid = row.kind === "course" && row.course?.id !== undefined ? String(row.course.id) : null;
  const inScope = ctx.courseObjects ? objectsInScope(ctx.courseObjects, courseUuid, ctx.classesByCourse ?? new Map()) : [];
  const ends = row.course
    ? layoutCourseEnds(
        { ...row.course, structure: row.course.structure ?? null },
        row.course.courseControls.map((cc) => cc.control.id),
        ctx.allControls,
      )
    : null;
  const all = row.kind === "course" && !!row.allVariations && !!row.course;
  const stored = row.windowCenter && typeof row.windowCenter === "object" ? z.object({ x: z.number(), y: z.number() }).parse(row.windowCenter) : null;
  // A root's pages share one window (F8): a NULL centre centres on every alternative — its own read too.
  const shared = !stored && row.course && row.kind === "course" ? sharedWindowCentre(row.rootStructure ?? row.course.structure, ends, ctx.allControls) : null;
  return {
    kind: row.kind,
    template: row.template,
    overrides: courseMapOverridesSchema.parse(row.overrides),
    objects: mapObjectsSchema.parse(row.objects),
    course: row.course
      ? {
          name: row.course.name,
          lengthM: row.course.lengthM,
          climbM: row.course.climbM,
          // The all-variations block lists each control once, by code — or by the number the variants share (F15, `allVariationControls`).
          orderMode: all ? "free_order" : row.course.orderMode,
          start: ends?.start ?? null,
          finish: ends?.finish ?? null,
          classes: row.course.classes,
          controls: all ? allVariationControls(row.course, ctx.allControls, ends) : layoutControlsFromCourseControls(row.course.courseControls),
          descriptionInstructions: row.course.descriptionInstructions,
          crossings: layoutCrossings(row.course.structure ?? null, ctx.allControls),
        }
      : null,
    allControls: ctx.allControls,
    windowCenter: stored ?? shared,
    mapScale: ctx.mapInfo.scale,
    meridianTiltDeg: ctx.mapInfo.meridianTiltDeg,
    event: ctx.event,
    mapName: row.name,
    ...(row.kind === "course" ? { section: row.sectionIndex ?? 0 } : {}),
    ...(row.variantKey !== undefined ? { variantKey: row.variantKey } : {}),
    ...(all ? { allVariations: true, variantKey: allVariationsSuffix(row.allVariations!.keys) } : {}),
    structure: row.course?.structure ?? null,
    ...(row.course?.id !== undefined ? { courseId: String(row.course.id) } : {}),
    courseObjects: inScope.map(({ id: _uuid, scope: _scope, z: _z, version: _v, seq, ...body }) => ({ ...body, id: seq }) as course.CourseLayerObject),
    ...(ctx.autoCuts === false ? { autoCuts: false } : {}),
  };
}

/** A setter sheet's group: the uuids of `props.controlIds`, empty when the props are not a setter's. */
export function setterControlIds(props: unknown): Set<string> {
  const parsed = setterSheetPropsSchema.safeParse(props);
  return new Set(parsed.success ? parsed.data.controlIds : []);
}

/**
 * A setter sheet (docs/course-layout.md §8; 08 §4.6): the sites of its
 * group only (`props.controlIds` among `ctx.allControls`) as the
 * all-controls sheet lists sites — codes, 702 / 710 by kind, the block in
 * code order — with no course (a course-scoped setter map draws no legs),
 * the `all`-scoped course objects, titled by the row's name.
 */
function setterSheetInput(row: PrintMapRow, ctx: MapRowContext): ResolveSheetInput {
  const group = setterControlIds(row.props);
  const inScope = ctx.courseObjects ? objectsInScope(ctx.courseObjects, null, ctx.classesByCourse ?? new Map()) : [];
  return {
    kind: "setter",
    template: row.template!,
    overrides: courseMapOverridesSchema.parse(row.overrides),
    objects: mapObjectsSchema.parse(row.objects),
    course: null,
    allControls: ctx.allControls.filter((c) => group.has(c.id)),
    windowCenter: row.windowCenter && typeof row.windowCenter === "object" ? z.object({ x: z.number(), y: z.number() }).parse(row.windowCenter) : null,
    mapScale: ctx.mapInfo.scale,
    meridianTiltDeg: ctx.mapInfo.meridianTiltDeg,
    event: ctx.event,
    mapName: row.name,
    structure: null,
    courseObjects: inScope.map(({ id: _uuid, scope: _scope, z: _z, version: _v, seq, ...body }) => ({ ...body, id: seq }) as course.CourseLayerObject),
    ...(ctx.autoCuts === false ? { autoCuts: false } : {}),
  };
}

/** One map row → its sheet (`sheetInputForMapRow` through `resolveSheet`). */
export function sheetForMapRow(row: PrintMapRow, ctx: MapRowContext): SheetInput {
  return resolveSheet(sheetInputForMapRow(row, ctx)).sheet;
}
