/**
 * Templates by key and auto sheets (docs/course-layout.md §5–§6; research
 * 08 §4.4, §4.6, 09 §5).
 *
 * - Every template carries `auto_key` (`templateAutoKey`); of the templates
 *   sharing a key one is the auto template (`is_extra = false`, at most one
 *   per key — the partial unique index `map_templates_one_auto_per_key`),
 *   the others are extra. `syncTemplateKey` keeps both after any write that
 *   may change a key; a key left without its auto template promotes one of
 *   its extras by decision (3) (`pickAutoTemplate`).
 * - `ensureAutoTemplate` returns the auto template of a key, creating it
 *   named after the key the first time a course or class needs it.
 * - `autoSheets` gives a course its first sheet (the auto template of the
 *   key that fits the course), one own sheet per part of a course split by
 *   map exchanges (`section_index`, F5), and every overriding class of the
 *   course its class sheets (`course_maps.class_id`); `ensureAllControlsSheet`
 *   gives the event its all-controls sheet the same way.
 */

import { TRPCError } from "@trpc/server";
import {
  course as courseLib,
  defaultTemplateSettings,
  fitOrientation,
  fitScale,
  getPaperDimensions,
  groupSites,
  mapTemplateSettingsSchema,
  paperOrientationSchema,
  paperSizeSchema,
  pickAutoTemplate,
  SETTER_DESCRIPTION_CELL_MM,
  setterSheetPropsSchema,
  templateAutoKey,
  templateKeyName,
  type MapTemplateSettings,
  type PaperOrientation,
  type PaperSize,
  type SetterSheetProps,
  type TemplateKeyFields,
  layoutCourseEnds,
} from "@oxygen/shared";
import { Prisma as PrismaNS, type MapTemplate, type Prisma, type PrismaClient } from "../generated/prisma/client.js";
import { nextObjectVersion } from "../course-objects.js";
import { publicControlId } from "../control-id.js";
import { getBaseMapInfoOrNull } from "./map-source.js";

type Db = PrismaClient | Prisma.TransactionClient;

function json(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

/** Promote the auto template of a key that has none, by decision (3). */
async function promoteAuto(db: Db, eventId: bigint, autoKey: string): Promise<void> {
  const rows = await db.mapTemplate.findMany({
    where: { eventId, autoKey },
    select: { id: true, seq: true, isExtra: true, createdAt: true, _count: { select: { maps: true } } },
  });
  if (rows.length === 0 || rows.some((r) => !r.isExtra)) return;
  const id = pickAutoTemplate(rows.map((r) => ({ id: r.id, seq: r.seq, createdAt: r.createdAt, sheetCount: r._count.maps })));
  if (id) await db.mapTemplate.update({ where: { id }, data: { isExtra: false } });
}

/**
 * After a template write: its `auto_key` from its fields; when the key
 * changed (or the row is new) it is the auto template of the new key unless
 * that key already has one (then extra), and the key it left promotes one
 * of its extras. An unchanged key keeps `is_extra` as it is.
 */
export async function syncTemplateKey(db: Db, templateId: string): Promise<MapTemplate> {
  const row = await db.mapTemplate.findUniqueOrThrow({ where: { id: templateId } });
  const key = templateAutoKey(row);
  if (row.autoKey === key) return row;
  const other = await db.mapTemplate.findFirst({
    where: { eventId: row.eventId, autoKey: key, isExtra: false, id: { not: row.id } },
    select: { id: true },
  });
  const updated = await db.mapTemplate.update({ where: { id: row.id }, data: { autoKey: key, isExtra: other !== null } });
  if (row.autoKey && !row.isExtra) await promoteAuto(db, row.eventId, row.autoKey);
  return updated;
}

/** After a template is deleted: its key promotes one of its extras. */
export async function afterTemplateDeleted(db: Db, eventId: bigint, autoKey: string | null, wasExtra: boolean): Promise<void> {
  if (autoKey && !wasExtra) await promoteAuto(db, eventId, autoKey);
}

/** A free template name: `base`, `base (2)`, … (names are unique per event). */
export async function freeTemplateName(db: Db, eventId: bigint, base: string): Promise<string> {
  const taken = new Set(
    (await db.mapTemplate.findMany({ where: { eventId, name: { startsWith: base } }, select: { name: true } })).map((r) => r.name),
  );
  if (!taken.has(base)) return base;
  for (let i = 2; ; i += 1) if (!taken.has(`${base} (${i})`)) return `${base} (${i})`;
}

export interface KeySpec {
  paper: PaperSize;
  orientation: PaperOrientation;
  printScale: number;
  paperWidthMm?: number | null;
  paperHeightMm?: number | null;
}

function paperOf(spec: TemplateKeyFields) {
  return getPaperDimensions(
    paperSizeSchema.parse(spec.paper),
    paperOrientationSchema.parse(spec.orientation),
    spec.paper === "custom" ? { width: spec.paperWidthMm ?? 0, height: spec.paperHeightMm ?? 0 } : undefined,
  );
}

/**
 * The auto template of `spec`'s key, created when the key has none. A new
 * one is named after the key; it takes `seed`'s margin and appearance, and
 * — when `seed` has the same paper and orientation — its frame, block and
 * objects too (the same page, another scale: a class override).
 */
export async function ensureAutoTemplate(db: Db, eventId: bigint, spec: KeySpec, seed?: MapTemplate | null): Promise<{ template: MapTemplate; created: boolean }> {
  const key = templateAutoKey(spec);
  const existing = await db.mapTemplate.findFirst({ where: { eventId, autoKey: key, isExtra: false } });
  if (existing) return { template: existing, created: false };
  const seedSettings = seed ? mapTemplateSettingsSchema.safeParse(seed.settings) : null;
  const samePage = !!seed && seed.paper === spec.paper && seed.orientation === spec.orientation &&
    (spec.paper !== "custom" || (seed.paperWidthMm === spec.paperWidthMm && seed.paperHeightMm === spec.paperHeightMm));
  const settings: MapTemplateSettings =
    seedSettings?.success && samePage
      ? seedSettings.data
      : defaultTemplateSettings(paperOf(spec), seedSettings?.success ? seedSettings.data.printMarginMm : 3, seedSettings?.success ? seedSettings.data.appearance : undefined);
  const name = await freeTemplateName(db, eventId, templateKeyName(spec));
  // ON CONFLICT DO NOTHING (`skipDuplicates`): a concurrent writer that created the key's auto template
  // first leaves this insert a no-op instead of aborting the caller's transaction (a P2002 would).
  const inserted = await db.mapTemplate.createMany({
    data: {
      eventId,
      name,
      paper: spec.paper,
      paperWidthMm: spec.paper === "custom" ? spec.paperWidthMm ?? null : null,
      paperHeightMm: spec.paper === "custom" ? spec.paperHeightMm ?? null : null,
      orientation: spec.orientation,
      printScale: spec.printScale,
      settings: json(settings),
      objects: json(samePage && seed ? seed.objects : []),
      autoKey: key,
      isExtra: false,
      version: nextObjectVersion(),
    },
    skipDuplicates: true,
  });
  const template = await db.mapTemplate.findFirst({ where: { eventId, autoKey: key, isExtra: false } });
  if (!template) throw new TRPCError({ code: "CONFLICT", message: `Template "${name}" could not be created; try again` });
  return { template, created: inserted.count === 1 };
}

/**
 * The template most sheets use (the event's default look), or null. Setter
 * sheets (F10) do not count, and a template only setter sheets use is not
 * a candidate: their fitted A4 keys are not the event's look.
 */
async function busiestTemplate(db: Db, eventId: bigint): Promise<MapTemplate | null> {
  const [rows, setterOnly] = await Promise.all([
    db.mapTemplate.findMany({ where: { eventId }, include: { _count: { select: { maps: { where: { kind: { not: "setter" } } } } } } }),
    db.courseMap.findMany({ where: { eventId, kind: "setter", templateId: { not: null } }, select: { templateId: true }, distinct: ["templateId"] }),
  ]);
  const setterTemplates = new Set(setterOnly.map((r) => r.templateId));
  const candidates = rows.filter((r) => r._count.maps > 0 || !setterTemplates.has(r.id));
  const id = pickAutoTemplate(candidates.map((r) => ({ id: r.id, seq: r.seq, createdAt: r.createdAt, sheetCount: r._count.maps })));
  return candidates.find((r) => r.id === id) ?? null;
}

function specOf(t: MapTemplate, printScale = t.printScale): KeySpec {
  return {
    paper: paperSizeSchema.parse(t.paper),
    orientation: paperOrientationSchema.parse(t.orientation),
    printScale,
    paperWidthMm: t.paperWidthMm,
    paperHeightMm: t.paperHeightMm,
  };
}

/**
 * The auto template of the key that fits `points` (map mm): the event's
 * busiest template's paper, orientation and scale — A4 portrait at the
 * map's scale without one — turned when the points only fit the other way
 * (`fitOrientation`). Points at (0, 0) are unplaced and left out.
 */
async function fittedAutoTemplate(db: Db, eventId: bigint, controls: Array<{ xpos: number; ypos: number }>): Promise<{ template: MapTemplate; created: boolean }> {
  const busiest = await busiestTemplate(db, eventId);
  const mapInfo = await getBaseMapInfoOrNull(db, eventId);
  const preferred: KeySpec = busiest
    ? specOf(busiest)
    : { paper: "A4", orientation: "portrait", printScale: mapInfo?.scale ?? 10000 };
  const points = controls.filter((c) => c.xpos !== 0 || c.ypos !== 0);
  const xs = points.map((p) => p.xpos), ys = points.map((p) => p.ypos);
  const extent = points.length ? { width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) } : { width: 0, height: 0 };
  const margin = busiest ? mapTemplateSettingsSchema.safeParse(busiest.settings) : null;
  const orientation = fitOrientation(
    extent,
    (mapInfo?.scale ?? preferred.printScale) / preferred.printScale,
    preferred.paper,
    preferred.orientation,
    margin?.success ? margin.data.printMarginMm : 3,
    preferred.paper === "custom" ? { width: preferred.paperWidthMm ?? 0, height: preferred.paperHeightMm ?? 0 } : undefined,
  );
  return ensureAutoTemplate(db, eventId, { ...preferred, orientation }, busiest);
}

/**
 * What a course's first window fits: its controls — for a root with
 * variation groups every site any alternative visits, so the sheet its
 * variants share holds them all (08 §4.6; course-print.md §4.6).
 */
async function fitSitesOf(
  db: Db,
  c: { structure: unknown; courseControls: Array<{ control: { xpos: number; ypos: number } }> },
): Promise<Array<{ xpos: number; ypos: number }>> {
  const own = c.courseControls.map((cc) => cc.control);
  const parsed = c.structure ? courseLib.courseStructureSchema.safeParse(c.structure) : null;
  if (!parsed?.success || !courseLib.hasVariations(parsed.data)) return own;
  const ids = courseLib.structureSiteIds(parsed.data);
  return [...own, ...(await db.control.findMany({ where: { id: { in: ids } }, select: { xpos: true, ypos: true } }))];
}

/**
 * The parts of a course split by map exchanges (course-layer.md §11): its
 * placed exchange visits plus one. Unplaced sites (0, 0) are not drawn, so
 * they split nothing — as `deriveCourse`.
 */
export function partCountOf(controls: ReadonlyArray<{ xpos: number; ypos: number; kind: string }>): number {
  return 1 + controls.filter((c) => c.kind === "map_exchange" && (c.xpos !== 0 || c.ypos !== 0)).length;
}

export interface AutoSheetsResult {
  /** Public ids of the sheets created. */
  createdSheets: number[];
  /** Public ids of the templates created. */
  createdTemplates: number[];
  /** The course's own sheets (`class_id` null), in print order. */
  courseSheets: number[];
  /** Every overriding class's sheets, by class seq. */
  classSheets: Record<number, number[]>;
  /** The event's all-controls sheet when it was asked for (`allControls`), else null. */
  allControlsSheet: number | null;
}

/**
 * `layout.autoSheets { courseId }` (docs/course-layout.md §6; 08 §4.6, §6):
 *
 * 1. The course's sheets. Without one, a first sheet is created on the auto
 *    template of the key that fits the course (`fitOrientation`: the
 *    event's busiest template's paper, orientation and scale — A4 portrait
 *    at the map's scale without one — turned when the course only fits the
 *    other way), its window centred on the course. A sheet without a
 *    template gets that template too. A course split by map exchanges
 *    (course-layer.md §11) has one own sheet per part: a part without a
 *    sheet of its `section_index` gets one on the course's template, named
 *    `<course> · part n` (part 1 the course's name), its window centre NULL
 *    (centred on the part's controls), after the course's other sheets. A
 *    sheet of a part that no longer exists is kept (it prints the whole
 *    course); a deleted part sheet comes back on the next call.
 * 2. Every class of the course with `print_scale` or `sheet_template_id`:
 *    its template is `sheet_template_id`, else the auto template of the
 *    course template's paper and orientation at the class's scale (created
 *    from it). Without class sheets, one per course sheet is created
 *    (window centre, objects and block copied); with some, one per course
 *    sheet of a part the class has no sheet of; existing ones are
 *    re-pointed at the template. A class sheet whose class no longer
 *    overrides, or runs another course, is deleted.
 *
 * Idempotent: a second call creates nothing.
 */
export async function autoSheets(db: Db, eventId: bigint, courseUuid: string): Promise<AutoSheetsResult> {
  const course = await db.course.findFirst({
    where: { id: courseUuid, eventId, removed: false },
    include: {
      courseControls: { include: { control: { select: { xpos: true, ypos: true, kind: true } } }, orderBy: { position: "asc" } },
      classes: { where: { removed: false }, select: { id: true, seq: true, name: true, printScale: true, sheetTemplateId: true } },
    },
  });
  if (!course) throw new TRPCError({ code: "NOT_FOUND", message: "Course not found" });
  // A variant prints on its root's sheets (course-print.md §4.6, F8): it gets none of its own.
  if (course.parentCourseId) return autoSheets(db, eventId, course.parentCourseId);
  const createdSheets: number[] = [];
  const createdTemplates: number[] = [];
  const stamp = () => nextObjectVersion();

  // ─── 1. The course's own sheets ─────────────────────────
  let sheets = await db.courseMap.findMany({
    where: { eventId, courseId: courseUuid, classId: null, kind: "course" },
    include: { template: true },
    orderBy: [{ sortOrder: "asc" }, { seq: "asc" }],
  });
  let base = sheets.find((s) => s.template)?.template ?? null;
  if (!base) {
    const ensured = await fittedAutoTemplate(db, eventId, await fitSitesOf(db, course));
    if (ensured.created) createdTemplates.push(ensured.template.seq);
    base = ensured.template;
    if (sheets.length === 0) {
      const sheet = await db.courseMap.create({
        data: { eventId, courseId: courseUuid, templateId: base.id, name: course.name, kind: "course", version: stamp() },
      });
      createdSheets.push(sheet.seq);
    } else {
      await db.courseMap.updateMany({ where: { id: { in: sheets.map((s) => s.id) } }, data: { templateId: base.id, version: stamp() } });
    }
    sheets = await db.courseMap.findMany({
      where: { eventId, courseId: courseUuid, classId: null, kind: "course" },
      include: { template: true },
      orderBy: [{ sortOrder: "asc" }, { seq: "asc" }],
    });
  }
  // Parts (course-layer.md §11): one per placed map exchange of the course, plus one — as the layer splits it.
  const parts = partCountOf(course.courseControls.map((cc) => cc.control));
  if (parts >= 2) {
    const has = new Set(sheets.map((s) => s.sectionIndex));
    let sortOrder = Math.max(-1, ...sheets.map((s) => s.sortOrder));
    let added = false;
    for (let part = 0; part < parts; part++) {
      if (has.has(part)) continue;
      sortOrder += 1;
      const sheet = await db.courseMap.create({
        data: {
          eventId,
          courseId: courseUuid,
          templateId: base.id,
          name: part === 0 ? course.name : `${course.name} · part ${part + 1}`,
          kind: "course",
          sectionIndex: part,
          sortOrder,
          version: stamp(),
        },
      });
      createdSheets.push(sheet.seq);
      added = true;
    }
    if (added) {
      sheets = await db.courseMap.findMany({
        where: { eventId, courseId: courseUuid, classId: null, kind: "course" },
        include: { template: true },
        orderBy: [{ sortOrder: "asc" }, { seq: "asc" }],
      });
    }
  }

  // ─── 2. Class sheets ────────────────────────────────────
  const overriding = course.classes.filter((c) => c.printScale !== null || c.sheetTemplateId !== null);
  const keep = new Set(overriding.map((c) => c.id));
  // Class sheets of this course whose class stopped overriding or left the course.
  await db.courseMap.deleteMany({
    where: { eventId, courseId: courseUuid, classId: { not: null }, NOT: { classId: { in: [...keep] } } },
  });
  const classSheets: Record<number, number[]> = {};
  for (const cls of overriding) {
    const explicit = cls.sheetTemplateId ? await db.mapTemplate.findUnique({ where: { id: cls.sheetTemplateId } }) : null;
    let template: MapTemplate;
    if (explicit) template = explicit;
    else {
      const ensured = await ensureAutoTemplate(db, eventId, specOf(base, cls.printScale ?? base.printScale), base);
      if (ensured.created) createdTemplates.push(ensured.template.seq);
      template = ensured.template;
    }
    // With an explicit template and a scale, the sheet overrides the template's scale.
    const scale = explicit && cls.printScale !== null && cls.printScale !== explicit.printScale ? cls.printScale : null;
    // Sheets the class kept from a course it no longer runs.
    await db.courseMap.deleteMany({ where: { eventId, classId: cls.id, NOT: { courseId: courseUuid } } });
    const existing = await db.courseMap.findMany({ where: { eventId, classId: cls.id }, orderBy: [{ sortOrder: "asc" }, { seq: "asc" }] });
    // Without class sheets, one per course sheet; with some, one per course sheet of a part the class lacks (F5).
    const classParts = new Set(existing.map((s) => s.sectionIndex));
    const missing = existing.length === 0 ? sheets : sheets.filter((s) => !classParts.has(s.sectionIndex));
    if (missing.length > 0) {
      for (const s of missing) {
        const overrides = { ...(s.overrides as Record<string, unknown>) };
        delete overrides.printScale;
        if (scale !== null) overrides.printScale = scale;
        const row = await db.courseMap.create({
          data: {
            eventId,
            courseId: courseUuid,
            classId: cls.id,
            templateId: template.id,
            name: `${s.name} · ${cls.name}`,
            kind: "course",
            windowCenter: s.windowCenter === null ? undefined : json(s.windowCenter),
            overrides: json(overrides),
            objects: json(s.objects),
            sortOrder: s.sortOrder,
            sectionIndex: s.sectionIndex,
            version: stamp(),
          },
        });
        createdSheets.push(row.seq);
      }
    }
    // The class's existing sheets follow its template and scale.
    for (const s of existing) {
      const overrides = { ...(s.overrides as Record<string, unknown>) };
      const want = scale ?? undefined;
      const same = s.templateId === template.id && overrides.printScale === want;
      if (same) continue;
      if (want === undefined) delete overrides.printScale;
      else overrides.printScale = want;
      await db.courseMap.update({ where: { id: s.id }, data: { templateId: template.id, overrides: json(overrides), version: stamp() } });
    }
    classSheets[cls.seq] = (
      await db.courseMap.findMany({ where: { eventId, classId: cls.id }, orderBy: [{ sortOrder: "asc" }, { seq: "asc" }], select: { seq: true } })
    ).map((r) => r.seq);
  }

  return { createdSheets, createdTemplates, courseSheets: sheets.map((s) => s.seq), classSheets, allControlsSheet: null };
}

/**
 * `layout.autoSheets { allControls: true }` (docs/course-layout.md §6): the
 * event's one all-controls sheet (`kind = 'all_controls'`, named "All
 * controls", window centre null = centred on the controls), created on the
 * auto template of the key that fits every placed control
 * (`fittedAutoTemplate`); one without a template gets that template.
 * Idempotent.
 */
export async function ensureAllControlsSheet(
  db: Db,
  eventId: bigint,
): Promise<{ sheet: number; createdSheet: boolean; createdTemplate: number | null }> {
  const existing = await db.courseMap.findFirst({ where: { eventId, kind: "all_controls" }, select: { id: true, seq: true, templateId: true } });
  if (existing?.templateId) return { sheet: existing.seq, createdSheet: false, createdTemplate: null };
  const controls = await db.control.findMany({ where: { eventId, removed: false }, select: { xpos: true, ypos: true } });
  const ensured = await fittedAutoTemplate(db, eventId, controls);
  const createdTemplate = ensured.created ? ensured.template.seq : null;
  if (existing) {
    await db.courseMap.update({ where: { id: existing.id }, data: { templateId: ensured.template.id, version: nextObjectVersion() } });
    return { sheet: existing.seq, createdSheet: false, createdTemplate };
  }
  const last = await db.courseMap.findFirst({ where: { eventId, courseId: null }, orderBy: { sortOrder: "desc" }, select: { sortOrder: true } });
  const row = await db.courseMap.create({
    data: {
      eventId,
      kind: "all_controls",
      name: "All controls",
      templateId: ensured.template.id,
      sortOrder: (last?.sortOrder ?? -1) + 1,
      version: nextObjectVersion(),
    },
  });
  return { sheet: row.seq, createdSheet: true, createdTemplate };
}

// ─── Setter maps and the recalculation (docs/course-layout.md §6, §8; F10) ──

/** `groups` of `layout.setterMaps`: at most this many setter maps per scope. */
export const MAX_SETTER_GROUPS = 20;

type SiteRow = { id: string; seq: number; codes: string; xpos: number; ypos: number };

const placed = (c: { xpos: number; ypos: number }) => c.xpos !== 0 || c.ypos !== 0;

function extentOf(points: ReadonlyArray<{ xpos: number; ypos: number }>): { width: number; height: number } {
  if (points.length === 0) return { width: 0, height: 0 };
  const xs = points.map((p) => p.xpos), ys = points.map((p) => p.ypos);
  return { width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
}

/**
 * The auto template of the key fitted to `points` (08 §4.6 "compute scale,
 * orientation … to fit everything on A4"): `page`'s paper, the orientation
 * and the standard scale `fitScale` picks (`page.orientation` first), with
 * the margin and look of `seed` (`ensureAutoTemplate`).
 */
async function scaleFittedTemplate(
  db: Db,
  eventId: bigint,
  points: ReadonlyArray<{ xpos: number; ypos: number }>,
  page: { paper: PaperSize; orientation: PaperOrientation; paperWidthMm?: number | null; paperHeightMm?: number | null },
  seed: MapTemplate | null,
): Promise<{ template: MapTemplate; created: boolean }> {
  const mapInfo = await getBaseMapInfoOrNull(db, eventId);
  const settings = seed ? mapTemplateSettingsSchema.safeParse(seed.settings) : null;
  const custom = page.paper === "custom" ? { width: page.paperWidthMm ?? 0, height: page.paperHeightMm ?? 0 } : undefined;
  const fit = fitScale(extentOf(points.filter(placed)), mapInfo?.scale ?? 10000, page.paper, page.orientation, settings?.success ? settings.data.printMarginMm : 3, custom);
  return ensureAutoTemplate(db, eventId, { ...page, orientation: fit.orientation, printScale: fit.printScale }, seed);
}

/**
 * The sites a setter visits in a scope (§8): event-wide every placed site;
 * for a course its placed start, controls and finish (the one sequence
 * rule, `layoutCourseEnds`) and the crossing points its legs run through —
 * and, in both scopes, the event's map-issue points (702 belongs to no
 * course and is what a setter fixes on the way).
 */
async function setterScopeSites(db: Db, eventId: bigint, courseUuid: string | null): Promise<SiteRow[]> {
  const controls = await db.control.findMany({ where: { eventId, removed: false } });
  if (courseUuid === null) return controls.filter(placed);
  const c = await db.course.findFirst({
    where: { id: courseUuid, eventId, removed: false },
    include: { courseControls: { orderBy: { position: "asc" }, select: { controlId: true } } },
  });
  if (!c) throw new TRPCError({ code: "NOT_FOUND", message: "Course not found" });
  const ids = new Set(c.courseControls.map((cc) => cc.controlId));
  const all = controls.map((r) => ({ ...r, name: r.name ?? "" }));
  const ends = layoutCourseEnds(c, c.courseControls.map((cc) => cc.controlId), all);
  if (ends.start) ids.add(ends.start.id);
  if (ends.finish) ids.add(ends.finish.id);
  const parsed = c.structure ? courseLib.courseStructureSchema.safeParse(c.structure) : null;
  if (parsed?.success) {
    for (const item of courseLib.structureControlItems(parsed.data)) {
      const crossing = item.leg?.crossing?.controlId;
      if (crossing) ids.add(crossing);
    }
  }
  return controls.filter((r) => placed(r) && (ids.has(r.id) || r.kind === "map_issue"));
}

export interface SetterMapsResult {
  /** The setter sheets written, by setter number: seq, number, the group's public control ids (control-id.ts). */
  sheets: Array<{ seq: number; setter: number; controls: number[] }>;
  createdTemplates: number[];
}

/**
 * `layout.setterMaps { courseId?, groups }` (docs/course-layout.md §8; 08
 * §4.6, §6): the scope's setter sheets replaced by `groups` new ones — the
 * scope's sites (`setterScopeSites`) in deterministic k-means groups
 * (`groupSites`, west → east), one `kind = 'setter'` row per group on the
 * A4 auto template fitted to it (`fitScale`, the busiest template's
 * orientation preferred and its look seeded), window centre NULL
 * (centred on the group), 5 mm description cells
 * (`overrides.description.cellSizeMm`), `props { setter, controlIds }`,
 * named `Setter n` (event) / `<course> · Setter n` (English, as *All
 * controls*), after the scope's other sheets.
 */
export async function setterMaps(db: Db, eventId: bigint, opts: { courseUuid: string | null; groups: number }): Promise<SetterMapsResult> {
  const course = opts.courseUuid === null ? null : await db.course.findFirst({ where: { id: opts.courseUuid, eventId, removed: false }, select: { id: true, name: true } });
  if (opts.courseUuid !== null && !course) throw new TRPCError({ code: "NOT_FOUND", message: "Course not found" });
  const sites = await setterScopeSites(db, eventId, opts.courseUuid);
  if (sites.length === 0) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "No placed controls to group into setter maps" });
  const most = Math.min(MAX_SETTER_GROUPS, sites.length);
  if (opts.groups < 1 || opts.groups > most) {
    throw new TRPCError({ code: "BAD_REQUEST", message: `Choose 1–${most} setter maps for ${sites.length} controls` });
  }
  await db.courseMap.deleteMany({ where: { eventId, kind: "setter", courseId: opts.courseUuid } });
  const groups = groupSites(sites.map((s) => ({ ...s, x: s.xpos, y: s.ypos })), opts.groups);
  const busiest = await busiestTemplate(db, eventId);
  const preferred: PaperOrientation = busiest ? paperOrientationSchema.parse(busiest.orientation) : "portrait";
  const last = await db.courseMap.findFirst({ where: { eventId, courseId: opts.courseUuid }, orderBy: { sortOrder: "desc" }, select: { sortOrder: true } });
  const out: SetterMapsResult = { sheets: [], createdTemplates: [] };
  for (const [i, group] of groups.entries()) {
    const fitted = await scaleFittedTemplate(db, eventId, group, { paper: "A4", orientation: preferred }, busiest);
    if (fitted.created) out.createdTemplates.push(fitted.template.seq);
    const setter = i + 1;
    const props: SetterSheetProps = { setter, controlIds: group.map((s) => s.id) };
    const row = await db.courseMap.create({
      data: {
        eventId,
        courseId: opts.courseUuid,
        kind: "setter",
        name: course ? `${course.name} · Setter ${setter}` : `Setter ${setter}`,
        templateId: fitted.template.id,
        overrides: json({ description: { cellSizeMm: SETTER_DESCRIPTION_CELL_MM } }),
        props: json(props),
        sortOrder: (last?.sortOrder ?? -1) + setter,
        version: nextObjectVersion(),
      },
    });
    out.sheets.push({ seq: row.seq, setter, controls: group.map((s) => publicControlId(s)) });
  }
  return out;
}

export interface RecalculatedSheet {
  seq: number;
  version: string;
  /** The template the sheet now uses (its seq), and whether it was created. */
  templateSeq: number;
  createdTemplate: number | null;
}

/**
 * `layout.recalculateSheet { sheet }` (docs/course-layout.md §6, §8; 08
 * §4.6 "can be recalculated; moved items stay fixed until recalculated"):
 * an all-controls or setter sheet re-pointed at the auto template fitted to
 * its sites (`fitScale` on the sheet's paper, its orientation preferred,
 * its template seeding the look) — every placed control of the event, or
 * the setter's group — its window centre back to NULL (centred), its
 * `overrides.printScale` dropped and the block's position back to the
 * template's (`visible` and the cell size stay). Other kinds: BAD_REQUEST.
 */
export async function recalculateSheet(db: Db, eventId: bigint, seq: number): Promise<RecalculatedSheet> {
  const row = await db.courseMap.findFirst({ where: { eventId, seq }, include: { template: true } });
  if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "Course map not found" });
  if (row.kind !== "all_controls" && row.kind !== "setter") {
    throw new TRPCError({ code: "BAD_REQUEST", message: "Only the all-controls sheet and setter maps are recalculated" });
  }
  const controls = await db.control.findMany({ where: { eventId, removed: false }, select: { id: true, xpos: true, ypos: true } });
  const group = row.kind === "setter" ? new Set(setterSheetPropsSchema.safeParse(row.props).data?.controlIds ?? []) : null;
  const sites = controls.filter((c) => placed(c) && (!group || group.has(c.id)));
  const base = row.template ?? (await busiestTemplate(db, eventId));
  const page = base
    ? { paper: paperSizeSchema.parse(base.paper), orientation: paperOrientationSchema.parse(base.orientation), paperWidthMm: base.paperWidthMm, paperHeightMm: base.paperHeightMm }
    : { paper: "A4" as const, orientation: "portrait" as const };
  const fitted = await scaleFittedTemplate(db, eventId, sites, page, base);
  const overrides = { ...((row.overrides ?? {}) as Record<string, unknown>) };
  delete overrides.printScale;
  if (overrides.description && typeof overrides.description === "object") {
    const description = { ...(overrides.description as Record<string, unknown>) };
    delete description.x;
    delete description.y;
    overrides.description = description;
  }
  const version = nextObjectVersion();
  await db.courseMap.update({ where: { id: row.id }, data: { templateId: fitted.template.id, windowCenter: PrismaNS.JsonNull, overrides: json(overrides), version } });
  return { seq: row.seq, version: version.toString(), templateSeq: fitted.template.seq, createdTemplate: fitted.created ? fitted.template.seq : null };
}

/**
 * `layout.moveToSetter { controlId, sheet }` (docs/course-layout.md §8; 08
 * §4.6 "a manual 'move to next setter' click"): the control leaves the
 * setter sheet of `sheet`'s scope that holds it and joins `sheet`. Both
 * rows get a new version; windows are untouched (moved items stay fixed
 * until *Recalculate*). The same sheet is a no-op; a control in none of the
 * scope's setter maps is BAD_REQUEST.
 */
export async function moveToSetter(
  db: Db,
  eventId: bigint,
  opts: { controlId: number; sheetSeq: number },
): Promise<{ from: number; to: number; sheets: Array<{ seq: number; version: string }> }> {
  const target = await db.courseMap.findFirst({ where: { eventId, seq: opts.sheetSeq, kind: "setter" } });
  if (!target) throw new TRPCError({ code: "NOT_FOUND", message: "Setter map not found" });
  // The public id (first code, else seq; control-id.ts), as every control-facing endpoint.
  const control = (await db.control.findMany({ where: { eventId, removed: false }, select: { id: true, codes: true, seq: true } }))
    .find((c) => publicControlId(c) === opts.controlId);
  if (!control) throw new TRPCError({ code: "NOT_FOUND", message: "Control not found" });
  // One mover at a time over the event's setter rows: two `props` read, changed and written.
  await db.$queryRaw`SELECT "id" FROM "oxygen"."course_maps" WHERE "event_id" = ${eventId} AND "kind" = 'setter' FOR UPDATE`;
  const scope = await db.courseMap.findMany({ where: { eventId, kind: "setter", courseId: target.courseId } });
  const propsOf = (r: { props: unknown }): SetterSheetProps => setterSheetPropsSchema.safeParse(r.props).data ?? { setter: 1, controlIds: [] };
  const from = scope.find((r) => propsOf(r).controlIds.includes(control.id));
  if (!from) throw new TRPCError({ code: "BAD_REQUEST", message: "The control is in none of these setter maps" });
  const to = scope.find((r) => r.id === target.id) ?? target;
  if (from.id === to.id) return { from: from.seq, to: to.seq, sheets: [{ seq: to.seq, version: to.version.toString() }] };
  const fromProps = propsOf(from), toProps = propsOf(to);
  const v1 = nextObjectVersion(), v2 = nextObjectVersion();
  await db.courseMap.update({ where: { id: from.id }, data: { props: json({ ...fromProps, controlIds: fromProps.controlIds.filter((id) => id !== control.id) }), version: v1 } });
  await db.courseMap.update({ where: { id: to.id }, data: { props: json({ ...toProps, controlIds: [...toProps.controlIds, control.id] }), version: v2 } });
  return { from: from.seq, to: to.seq, sheets: [{ seq: from.seq, version: v1.toString() }, { seq: to.seq, version: v2.toString() }] };
}
