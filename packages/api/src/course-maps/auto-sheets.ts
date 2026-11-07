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
 *   key that fits the course) and every overriding class of the course its
 *   class sheets (`course_maps.class_id`); `ensureAllControlsSheet` gives
 *   the event its all-controls sheet the same way.
 */

import { TRPCError } from "@trpc/server";
import {
  defaultTemplateSettings,
  fitOrientation,
  getPaperDimensions,
  mapTemplateSettingsSchema,
  paperOrientationSchema,
  paperSizeSchema,
  pickAutoTemplate,
  templateAutoKey,
  templateKeyName,
  type MapTemplateSettings,
  type PaperOrientation,
  type PaperSize,
  type TemplateKeyFields,
} from "@oxygen/shared";
import type { MapTemplate, Prisma, PrismaClient } from "../generated/prisma/client.js";
import { nextObjectVersion } from "../course-objects.js";
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

/** The template most sheets use (the event's default look), or null. */
async function busiestTemplate(db: Db, eventId: bigint): Promise<MapTemplate | null> {
  const rows = await db.mapTemplate.findMany({ where: { eventId }, include: { _count: { select: { maps: true } } } });
  const id = pickAutoTemplate(rows.map((r) => ({ id: r.id, seq: r.seq, createdAt: r.createdAt, sheetCount: r._count.maps })));
  return rows.find((r) => r.id === id) ?? null;
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
 *    template gets that template too.
 * 2. Every class of the course with `print_scale` or `sheet_template_id`:
 *    its template is `sheet_template_id`, else the auto template of the
 *    course template's paper and orientation at the class's scale (created
 *    from it). Without class sheets, one per course sheet is created
 *    (window centre, objects and block copied); existing ones are
 *    re-pointed at the template. A class sheet whose class no longer
 *    overrides, or runs another course, is deleted.
 *
 * Idempotent: a second call creates nothing.
 */
export async function autoSheets(db: Db, eventId: bigint, courseUuid: string): Promise<AutoSheetsResult> {
  const course = await db.course.findFirst({
    where: { id: courseUuid, eventId, removed: false },
    include: {
      courseControls: { include: { control: { select: { xpos: true, ypos: true } } } },
      classes: { where: { removed: false }, select: { id: true, seq: true, name: true, printScale: true, sheetTemplateId: true } },
    },
  });
  if (!course) throw new TRPCError({ code: "NOT_FOUND", message: "Course not found" });
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
    const ensured = await fittedAutoTemplate(db, eventId, course.courseControls.map((cc) => cc.control));
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
    if (existing.length === 0) {
      for (const s of sheets) {
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
    } else {
      for (const s of existing) {
        const overrides = { ...(s.overrides as Record<string, unknown>) };
        const want = scale ?? undefined;
        const same = s.templateId === template.id && overrides.printScale === want;
        if (same) continue;
        if (want === undefined) delete overrides.printScale;
        else overrides.printScale = want;
        await db.courseMap.update({ where: { id: s.id }, data: { templateId: template.id, overrides: json(overrides), version: stamp() } });
      }
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
