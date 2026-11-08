import { TRPCError } from "@trpc/server";
import {
  course,
  courseMapObjectSchema,
  courseMapOverridesSchema,
  mapTemplateSettingsSchema,
  setterSheetPropsSchema,
  validateCourseMap,
  type CourseMapDocument,
  type CourseMapObject,
  type CourseMapOverrides,
  type MapPoint,
  type MapTemplateSettings,
  type MapWindow,
} from "@oxygen/shared";
import { z } from "zod";
import { Prisma } from "../generated/prisma/client.js";
import { layoutControlsFromCourseControls, layoutCourseEnds, resolveMapLayout } from "../course-maps/resolve-layout.js";
import { getBaseMapInfoOrNull } from "../course-maps/map-source.js";
import { publicControlId } from "../control-id.js";
import { type MapRowContext, setterControlIds, sharedWindowCentre, sheetInputForMapRow } from "../course-maps/pdf-page.js";
import { resolveSheet } from "../course-maps/resolve-sheet.js";
import { classesByCourse, loadCourseObjects, nextObjectVersion } from "../course-objects.js";
import { rowForClass, rowForVariant } from "../course-maps/pdf-page.js";
import { baseVersionSchema, versionConflict } from "../version-conflict.js";
import {
  coursesEditProcedure,
  coursesViewProcedure,
  router,
} from "../trpc.js";

const kindSchema = z.enum(["course", "all_controls"]);
const objectsSchema = z.array(courseMapObjectSchema);
const windowCenterSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
});

export interface CourseMapListItem {
  id: string;
  seq: number;
  name: string;
  kind: string;
  courseId: number | null;
  templateId: number | null;
  windowCenter: MapPoint | null;
  overrides: CourseMapOverrides;
  objects: CourseMapObject[];
  sortOrder: number;
  /** The part of a course split by map exchanges the sheet prints (`section_index`, course-layer.md §11). */
  sectionIndex: number;
  /** Concurrency token (docs/course-layout.md §2), a decimal HLC. */
  version: string;
  /** The class whose override the sheet prints (docs/course-layout.md §6); null for a course's own sheet. */
  class: { seq: number; name: string } | null;
  /** A setter sheet's number and its group's placed controls (public ids) in code order (docs/course-layout.md §8); null for other kinds. */
  setter: SetterOfSheet | null;
  course: {
    seq: number;
    name: string;
    lengthM: number;
    climbM: number;
    classes: Array<{ name: string }>;
  } | null;
  template: {
    seq: number;
    name: string;
    autoKey: string | null;
    isExtra: boolean;
  } | null;
  resolved: { document: CourseMapDocument; window: MapWindow } | null;
  validation: {
    valid: boolean;
    issues: Array<{
      code: string;
      message: string;
      controlId?: string;
      objectId?: string;
      variantKey?: string;
    }>;
  };
}

/** A setter sheet's number and its group's drawn controls (public control ids, in the block's code order). */
export interface SetterOfSheet {
  index: number;
  controls: number[];
}

/** The setter part of a row (`props`, `layout.controls` in code order); null unless `kind = 'setter'`. */
function setterOf(row: { kind: string; props: unknown }, drawn: ReadonlyArray<{ id: string }>, seqById: ReadonlyMap<string, number>): SetterOfSheet | null {
  if (row.kind !== "setter") return null;
  const props = setterSheetPropsSchema.safeParse(row.props);
  return {
    index: props.success ? props.data.setter : 0,
    controls: drawn.flatMap((c) => (seqById.has(c.id) ? [seqById.get(c.id)!] : [])),
  };
}

/**
 * One sheet or template as the editor's Layout mode reads it
 * (docs/course-layout.md §1 "What the editor reads"): the resolved
 * document and window, the page the composer would draw (`page`, as
 * `resolveSheet` builds it), and the raw template / sheet parts the
 * editor writes back through `saveLayout` / `mapTemplate.update`.
 */
export interface EditorSheet {
  scope: "sheet" | "template";
  /** The sheet row; null in template scope. */
  sheet: {
    seq: number;
    name: string;
    kind: string;
    courseSeq: number | null;
    /** The class of a class sheet (docs/course-layout.md §6). */
    classSeq: number | null;
    /** The part of the course it prints (`section_index`, course-layer.md §11). */
    sectionIndex: number;
    /** A setter sheet's number and group (§8); null for other kinds. */
    setter: SetterOfSheet | null;
    version: string;
    windowCenter: MapPoint | null;
    overrides: CourseMapOverrides;
    objects: CourseMapObject[];
  } | null;
  template: {
    seq: number;
    name: string;
    paper: string;
    orientation: string;
    paperWidthMm: number | null;
    paperHeightMm: number | null;
    printScale: number;
    settings: MapTemplateSettings;
    objects: CourseMapObject[];
    autoKey: string | null;
    isExtra: boolean;
    version: string;
  };
  /**
   * Class view (docs/course-layout.md §6): the class read, and whether it
   * is the class's own sheet or its course's sheet with the override applied.
   */
  classView: { classSeq: number; className: string; printScale: number | null; ownSheet: boolean } | null;
  /**
   * The variant drawn (F8; course-print.md §4.6): a root's sheet read with
   * `variantKey` is that variant's page — its course, numbering, block and
   * `{variant}`; null for any other read.
   */
  variantKey: string | null;
  /** The previewed course in template scope, the sheet's course in sheet scope. */
  courseSeq: number | null;
  document: CourseMapDocument;
  window: MapWindow;
  /** The page part of the composer's input: paper, frame, window, the (page-anchored) layout objects, text values, the description block. */
  page: Omit<course.PageLayerInput, "context" | "paper"> & { paper: { widthMm: number; heightMm: number } };
  /** The description block's content whether shown or not (the editor toggles it): rows, header, title. */
  block: Pick<NonNullable<course.PageLayerInput["description"]>, "rows" | "header" | "title">;
  appearance: course.CourseAppearance;
  labelMode: "sequence" | "code";
  /** Windows of every sheet of the same course (validation: a control must lie in one of them). */
  windows: MapWindow[];
  /** Control positions on the sheet (validation). */
  controls: Array<MapPoint & { id: string; code: string }>;
  descriptionRowCount: number;
  descriptionHeaderRows: number;
  mapScale: number | null;
}

/**
 * A root's variants as the map validation reads them (F8; `validateCourseMap`
 * names an outside control by its key): each variant's placed sites; null
 * for a course without groups (its own controls are the one variant).
 */
function variantControlsOf(
  structure: unknown,
  controls: ReadonlyArray<{ id: string; seq: number; codes: string; xpos: number; ypos: number; kind: string }>,
): { key: string; controls: Array<MapPoint & { id: string; code: string }> }[] | null {
  const parsed = structure ? course.courseStructureSchema.safeParse(structure) : null;
  if (!parsed?.success || !course.hasVariations(parsed.data)) return null;
  const byId = new Map(controls.map((c) => [c.id, c]));
  return course.materialiseVariants(parsed.data).map((v) => ({
    key: v.key,
    controls: [...new Set(v.items.map((i) => i.siteId))].flatMap((id) => {
      const c = byId.get(id);
      return c && (c.xpos !== 0 || c.ypos !== 0) ? [{ id, code: c.codes.split(";")[0]?.trim() || String(c.seq), x: c.xpos, y: c.ypos }] : [];
    }),
  }));
}

function json(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

type ParsedMap<T> = Omit<T, "version" | "windowCenter" | "overrides" | "objects"> & {
  version: string;
  windowCenter: MapPoint | null;
  overrides: CourseMapOverrides;
  objects: CourseMapObject[];
};

function parseMap<T extends {
  windowCenter: unknown;
  overrides: unknown;
  objects: unknown;
  version: bigint;
}>(row: T): ParsedMap<T> {
  return {
    ...row,
    version: row.version.toString(),
    windowCenter:
      row.windowCenter === null
        ? null
        : windowCenterSchema.parse(row.windowCenter),
    overrides: courseMapOverridesSchema.parse(row.overrides),
    objects: objectsSchema.parse(row.objects),
  };
}

function editorSheet(
  scope: EditorSheet["scope"],
  { layout, sheet }: ReturnType<typeof resolveSheet>,
  rest: {
    sheet: EditorSheet["sheet"];
    template: { seq: number; name: string; paper: string; orientation: string; paperWidthMm: number | null; paperHeightMm: number | null; printScale: number; settings: unknown; objects: unknown; autoKey: string | null; isExtra: boolean; version: bigint };
    courseSeq: number | null;
    classView?: EditorSheet["classView"];
    variantKey?: string | null;
    windows: MapWindow[];
    mapScale: number | null;
  },
): EditorSheet {
  const t = rest.template;
  return {
    scope,
    sheet: rest.sheet,
    template: {
      seq: t.seq,
      name: t.name,
      paper: t.paper,
      orientation: t.orientation,
      paperWidthMm: t.paperWidthMm,
      paperHeightMm: t.paperHeightMm,
      printScale: t.printScale,
      settings: mapTemplateSettingsSchema.parse(t.settings),
      objects: objectsSchema.parse(t.objects),
      autoKey: t.autoKey,
      isExtra: t.isExtra,
      version: t.version.toString(),
    },
    classView: rest.classView ?? null,
    variantKey: rest.variantKey ?? null,
    courseSeq: rest.courseSeq,
    document: layout.document,
    window: layout.window,
    page: { paper: sheet.paper, frame: sheet.frame, window: sheet.window, objects: sheet.objects, textValues: sheet.textValues, description: sheet.description },
    block: { rows: layout.descriptionRows, header: layout.descriptionHeader, title: sheet.label },
    appearance: sheet.course.appearance,
    labelMode: layout.labelMode,
    windows: rest.windows,
    controls: layout.controls.map((c) => ({ id: c.id, code: c.code, x: c.x, y: c.y })),
    descriptionRowCount: layout.descriptionRows.length,
    descriptionHeaderRows: layout.descriptionHeader ? 3 : 1,
    mapScale: rest.mapScale,
  };
}

function notFound(): never {
  throw new TRPCError({ code: "NOT_FOUND", message: "Course map not found" });
}

export const courseMapRouter = router({
  list: coursesViewProcedure.query(async ({ ctx }): Promise<CourseMapListItem[]> => {
    const [rows, mapInfo, eventRow] = await Promise.all([
      ctx.db.courseMap.findMany({
        where: { eventId: ctx.event.id },
        include: {
          template: true,
          class: { select: { seq: true, name: true } },
          course: {
            include: {
              classes: { select: { name: true } },
              courseControls: {
                orderBy: { position: "asc" },
                include: { control: true },
              },
            },
          },
        },
        orderBy: [
          { course: { seq: "asc" } },
          { sortOrder: "asc" },
          { seq: "asc" },
        ],
      }),
      getBaseMapInfoOrNull(ctx.db, ctx.event.id),
      ctx.db.event.findUnique({
        where: { id: ctx.event.id },
        select: { name: true, date: true },
      }),
    ]);

    const controlsForAll = await ctx.db.control.findMany({
      where: { eventId: ctx.event.id, removed: false },
      select: {
        id: true,
        seq: true,
        codes: true,
        name: true,
        status: true,
        kind: true,
        xpos: true,
        ypos: true,
        description: true,
      },
    });

    const parsed = rows.map(parseMap);
    const windowsByCourse = new Map<string, MapWindow[]>();
    const seqById = new Map(controlsForAll.map((c) => [c.id, publicControlId(c)]));
    const windowsKey = (row: { kind: string; seq: number; courseId: string | null; classId: string | null }) =>
      row.kind === "setter" ? `setter:${row.seq}` : `${row.courseId ?? "all_controls"}:${row.classId ?? ""}`;

    const data = parsed.map((row) => {
      if (!row.template) {
        return {
          ...row,
          validation: {
            valid: false,
            issues: [
              {
                code: "template_missing" as const,
                message: "No map template is assigned",
              },
            ],
          },
        };
      }
      // A setter sheet (§8) lists its group's sites only and draws no course.
      const group = row.kind === "setter" ? setterControlIds(row.props) : null;
      // A root's sheet is shared by its variants (F8): a NULL centre centres on every alternative, as it prints.
      const ends = row.course && !group ? layoutCourseEnds(row.course, row.course.courseControls.map((cc) => cc.control.id), controlsForAll) : null;
      const shared = !row.windowCenter && row.kind === "course" && row.course ? sharedWindowCentre(row.course.structure, ends, controlsForAll) : null;
      const layout = resolveMapLayout({
        kind: row.kind,
        template: row.template,
        overrides: row.overrides,
        objects: row.objects,
        course: row.course && !group
          ? {
              name: row.course.name,
              lengthM: row.course.lengthM,
              climbM: row.course.climbM,
              orderMode: row.course.orderMode,
              ...ends,
              classes: row.course.classes,
              controls: layoutControlsFromCourseControls(
                row.course.courseControls,
              ),
              descriptionInstructions: row.course.descriptionInstructions,
            }
          : null,
        allControls: group ? controlsForAll.filter((c) => group.has(c.id)) : controlsForAll,
        ...(eventRow ? { event: eventRow } : {}),
        windowCenter: row.windowCenter ?? shared,
        mapScale: mapInfo?.scale ?? null,
        meridianTiltDeg: mapInfo?.meridianTiltDeg ?? null,
        mapName: row.name,
        ...(row.kind === "course" ? { section: row.sectionIndex } : {}),
      });
      // A class's sheets are validated among themselves (another scale); a setter sheet alone (its controls are its group's).
      const key = windowsKey(row);
      const windows = windowsByCourse.get(key);
      if (windows) windows.push(layout.window);
      else windowsByCourse.set(key, [layout.window]);
      return {
        ...row,
        resolved: { document: layout.document, window: layout.window },
        controls: layout.controls,
        descriptionRowCount: layout.descriptionRows.length,
        descriptionHeaderRows: layout.descriptionHeader ? 3 : 1,
        variants: row.kind === "course" && row.course ? variantControlsOf(row.course.structure, controlsForAll) : null,
        validation: { valid: true, issues: [] },
      };
    });

    return data.map((row): CourseMapListItem => {
      const validation =
        "resolved" in row && "controls" in row
          ? validateCourseMap({
              document: row.resolved.document,
              mapScale: mapInfo?.scale ?? null,
              window: row.resolved.window,
              windows: windowsByCourse.get(windowsKey(row)),
              // A root's sheet: every variant's controls, named by key (F8).
              variants: row.variants ?? [{ key: "", controls: row.controls }],
              descriptionRowCount: row.descriptionRowCount,
              descriptionHeaderRows: row.descriptionHeaderRows,
            })
          : row.validation;
      const resolved = "resolved" in row ? row.resolved : null;
      return {
        id: row.id,
        seq: row.seq,
        name: row.name,
        kind: row.kind,
        courseId: row.course?.seq ?? null,
        templateId: row.template?.seq ?? null,
        windowCenter: row.windowCenter,
        overrides: row.overrides,
        objects: row.objects,
        sortOrder: row.sortOrder,
        sectionIndex: row.sectionIndex,
        version: row.version,
        class: row.class ? { seq: row.class.seq, name: row.class.name } : null,
        setter: setterOf(row, "controls" in row ? row.controls : [], seqById),
        course: row.course
          ? {
              seq: row.course.seq,
              name: row.course.name,
              lengthM: row.course.lengthM,
              climbM: row.course.climbM,
              classes: row.course.classes.map(({ name }) => ({ name })),
            }
          : null,
        template: row.template
          ? { seq: row.template.seq, name: row.template.name, autoKey: row.template.autoKey, isExtra: row.template.isExtra }
          : null,
        resolved,
        validation,
      };
    });
  }),

  /**
   * Layout mode's read (docs/course-layout.md §1; research 08 §4.6
   * `resolveSheet`): `{ seq }` a sheet, `{ templateSeq, courseSeq? }` a
   * template previewed with a course (or alone, centred on the map origin),
   * `{ classSeq }` Class view (§6): the class's first sheet, else its
   * course's first sheet as the class prints it (`rowForClass`).
   */
  resolveSheet: coursesViewProcedure
    .input(
      z.union([
        z.object({ seq: z.number().int().positive(), variantKey: z.string().min(1).max(64).optional() }),
        z.object({ templateSeq: z.number().int().positive(), courseSeq: z.number().int().positive().optional() }),
        z.object({ classSeq: z.number().int().positive(), variantKey: z.string().min(1).max(64).optional() }),
      ]),
    )
    .query(async ({ ctx, input }): Promise<EditorSheet> => {
      const courseInclude = {
        classes: { select: { name: true } },
        courseControls: { orderBy: { position: "asc" as const }, include: { control: true } },
      };
      const [mapInfo, eventRow, allControls, courseObjects, byCourse] = await Promise.all([
        getBaseMapInfoOrNull(ctx.db, ctx.event.id),
        ctx.db.event.findUnique({ where: { id: ctx.event.id }, select: { name: true, date: true, autoOverprintCuts: true } }),
        ctx.db.control.findMany({
          where: { eventId: ctx.event.id, removed: false },
          select: { id: true, seq: true, codes: true, name: true, status: true, kind: true, xpos: true, ypos: true, description: true },
        }),
        loadCourseObjects(ctx.db, ctx.event.id),
        classesByCourse(ctx.db, ctx.event.id),
      ]);
      const event = { name: eventRow?.name ?? "", date: eventRow?.date ?? new Date(0) };
      const rowCtx: MapRowContext = {
        event,
        allControls,
        mapInfo: { scale: mapInfo?.scale ?? null, meridianTiltDeg: mapInfo?.meridianTiltDeg ?? null },
        courseObjects,
        classesByCourse: byCourse,
        autoCuts: eventRow?.autoOverprintCuts ?? true,
      };
      const sheetInclude = { template: true, class: { select: { seq: true } }, course: { include: courseInclude } } as const;

      if ("seq" in input || "classSeq" in input) {
        let row;
        let classView: EditorSheet["classView"] = null;
        let print: Parameters<typeof rowForClass>[1] | null = null;
        if ("seq" in input) {
          row = await ctx.db.courseMap.findUnique({ where: { eventId_seq: { eventId: ctx.event.id, seq: input.seq } }, include: sheetInclude });
        } else {
          const cls = await ctx.db.class.findFirst({
            where: { eventId: ctx.event.id, seq: input.classSeq, removed: false },
            include: { sheetTemplate: true },
          });
          if (!cls) throw new TRPCError({ code: "NOT_FOUND", message: "Class not found" });
          const order = [{ sortOrder: "asc" as const }, { seq: "asc" as const }];
          const own = await ctx.db.courseMap.findFirst({ where: { eventId: ctx.event.id, classId: cls.id }, include: sheetInclude, orderBy: order });
          row =
            own ??
            (cls.courseId
              ? await ctx.db.courseMap.findFirst({
                  where: { eventId: ctx.event.id, courseId: cls.courseId, classId: null, kind: "course" },
                  include: sheetInclude,
                  orderBy: order,
                })
              : null);
          print = { name: cls.name, printScale: cls.printScale, sheetTemplate: cls.sheetTemplate };
          classView = { classSeq: cls.seq, className: cls.name, printScale: cls.printScale, ownSheet: !!own };
          if (row) row = rowForClass(row, print, !!own);
        }
        if (!row) notFound();
        if (!row.template) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "No map template is assigned" });
        // A root's sheet as one variant prints it (course-print.md §4.6, F8). A key the sheet's course has no live
        // variant of (any other sheet, or one the editor's structure has before the write lands) reads the sheet as is.
        const child =
          input.variantKey && row.kind === "course" && row.course
            ? await ctx.db.course.findFirst({ where: { parentCourseId: row.course.id, variantKey: input.variantKey, removed: false }, include: courseInclude })
            : null;
        const variantKey = child ? input.variantKey! : null;
        const sheetRow = child ? rowForVariant(row, child) : row;
        // The course's other sheets as this variant prints them (the shared window, `rowForVariant`).
        const variantOf = child && row.course ? { variantKey: child.variantKey ?? "", rootStructure: row.course.structure } : {};
        const resolved = resolveSheet(sheetInputForMapRow(sheetRow, rowCtx));
        // Windows of the same set's other sheets (the course's, or the class's), for the "outside every sheet" check.
        // A setter sheet stands alone: its controls are its group's (§8).
        const siblings = row.kind === "setter" ? [] : await ctx.db.courseMap.findMany({
          where: { eventId: ctx.event.id, kind: row.kind, courseId: row.courseId, classId: row.classId, seq: { not: row.seq }, templateId: { not: null } },
          include: { template: true },
        });
        const windows = [
          resolved.layout.window,
          ...siblings.map((s) => resolveMapLayout(sheetInputForMapRow(print && !row.classId ? rowForClass({ ...s, ...variantOf, course: sheetRow.course }, print, false) : { ...s, ...variantOf, course: sheetRow.course }, rowCtx)).window),
        ];
        const parsed = parseMap(row);
        return editorSheet("sheet", resolved, {
          sheet: {
            seq: row.seq,
            name: row.name,
            kind: row.kind,
            courseSeq: row.course?.seq ?? null,
            classSeq: row.class?.seq ?? null,
            sectionIndex: row.sectionIndex,
            setter: setterOf(row, resolved.layout.controls, new Map(allControls.map((c) => [c.id, publicControlId(c)]))),
            version: parsed.version,
            windowCenter: parsed.windowCenter,
            overrides: parsed.overrides,
            objects: parsed.objects,
          },
          template: row.template,
          courseSeq: row.course?.seq ?? null,
          classView,
          variantKey,
          windows,
          mapScale: mapInfo?.scale ?? null,
        });
      }

      const template = await ctx.db.mapTemplate.findFirst({ where: { eventId: ctx.event.id, seq: input.templateSeq } });
      if (!template) throw new TRPCError({ code: "NOT_FOUND", message: "Map template not found" });
      const previewCourse =
        input.courseSeq === undefined
          ? null
          : await ctx.db.course.findFirst({ where: { eventId: ctx.event.id, seq: input.courseSeq, removed: false }, include: courseInclude });
      if (input.courseSeq !== undefined && !previewCourse) throw new TRPCError({ code: "NOT_FOUND", message: "Course not found" });
      const resolved = resolveSheet(
        sheetInputForMapRow(
          { name: template.name, kind: "course", overrides: {}, objects: [], windowCenter: null, template, course: previewCourse },
          rowCtx,
        ),
      );
      return editorSheet("template", resolved, {
        sheet: null,
        template,
        courseSeq: previewCourse?.seq ?? null,
        windows: [resolved.layout.window],
        mapScale: mapInfo?.scale ?? null,
      });
    }),

  get: coursesViewProcedure
    .input(z.object({ seq: z.number().int().positive() }))
    .query(async ({ ctx, input }) => {
      const row = await ctx.db.courseMap.findUnique({
        where: { eventId_seq: { eventId: ctx.event.id, seq: input.seq } },
        include: { template: true, course: true },
      });
      if (!row) notFound();
      return parseMap(row);
    }),

  create: coursesEditProcedure
    .input(
      z.object({
        name: z.string().trim().min(1).max(120).optional(),
        kind: kindSchema.default("course"),
        courseId: z.number().int().positive().nullable().optional(),
        templateId: z.number().int().positive().nullable().optional(),
        windowCenter: windowCenterSchema.nullable().optional(),
        overrides: courseMapOverridesSchema.default({}),
        objects: objectsSchema.default([]),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (
        (input.kind === "course" && !input.courseId) ||
        (input.kind === "all_controls" && input.courseId)
      ) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Course maps require a course; all-controls maps cannot have one",
        });
      }
      const [course, template, last] = await Promise.all([
        input.courseId
          ? ctx.db.course.findFirst({
              where: {
                seq: input.courseId,
                eventId: ctx.event.id,
                removed: false,
              },
              select: { id: true, name: true },
            })
          : null,
        input.templateId
          ? ctx.db.mapTemplate.findFirst({
              where: { seq: input.templateId, eventId: ctx.event.id },
              select: { id: true },
            })
          : null,
        ctx.db.courseMap.findFirst({
          where: {
            eventId: ctx.event.id,
            course: input.courseId ? { seq: input.courseId } : null,
          },
          orderBy: { sortOrder: "desc" },
          select: { sortOrder: true },
        }),
      ]);
      if (input.courseId && !course) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Course not found" });
      }
      if (input.templateId && !template) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Map template not found" });
      }
      try {
        return parseMap(
          await ctx.db.courseMap.create({
            data: {
              eventId: ctx.event.id,
              name:
                input.name ??
                (input.kind === "all_controls"
                  ? "All controls"
                  : course?.name ?? "Map"),
              kind: input.kind,
              courseId: course?.id,
              templateId: template?.id,
              windowCenter:
                input.windowCenter === undefined || input.windowCenter === null
                  ? undefined
                  : json(input.windowCenter),
              overrides: json(input.overrides),
              objects: json(input.objects),
              sortOrder: (last?.sortOrder ?? -1) + 1,
              version: nextObjectVersion(),
            },
          }),
        );
      } catch (error) {
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === "P2002" &&
          input.kind === "all_controls"
        ) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "This event already has an all-controls map",
          });
        }
        throw error;
      }
    }),

  update: coursesEditProcedure
    .input(
      z
        .object({
          id: z.number().int().positive(),
          name: z.string().trim().min(1).max(120),
          templateId: z.number().int().positive().nullable(),
          windowCenter: windowCenterSchema.nullable(),
          overrides: courseMapOverridesSchema,
          objects: objectsSchema,
          sortOrder: z.number().int().min(0),
          /** The sheet's `version` the client edits from (docs/course-layout.md §2); omitted: last writer wins. */
          baseVersion: baseVersionSchema,
        })
        .partial()
        .required({ id: true }),
    )
    .mutation(async ({ ctx, input }) => {
      const existing = await ctx.db.courseMap.findFirst({
        where: { seq: input.id, eventId: ctx.event.id },
      });
      if (!existing) notFound();
      const updateTemplate =
        input.templateId === undefined || input.templateId === null
          ? null
          : await ctx.db.mapTemplate.findFirst({
              where: { seq: input.templateId, eventId: ctx.event.id },
            });
      if (input.templateId && !updateTemplate) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "Map template not found",
          });
      }
      const {
        id: _publicId,
        baseVersion,
        windowCenter,
        overrides,
        objects,
        templateId,
        ...fields
      } = input;
      void _publicId;
      return ctx.db.$transaction(async (tx) => {
        const rows = await tx.$queryRaw<{ version: bigint }[]>`
          SELECT "version" FROM "oxygen"."course_maps" WHERE "id" = ${existing.id}::uuid FOR UPDATE`;
        const now = rows[0]?.version;
        if (baseVersion !== undefined && now !== undefined && now !== BigInt(baseVersion)) {
          const current = await tx.courseMap.findUniqueOrThrow({ where: { id: existing.id } });
          throw versionConflict({ kind: "sheet", id: existing.seq, version: now.toString(), current: parseMap(current), differing: null });
        }
        return parseMap(
        await tx.courseMap.update({
          where: { id: existing.id },
          data: {
            ...fields,
            ...(templateId === undefined
              ? {}
              : { templateId: templateId === null ? null : updateTemplate!.id }),
            ...(windowCenter === undefined
              ? {}
              : {
                  windowCenter:
                    windowCenter === null ? Prisma.JsonNull : json(windowCenter),
                }),
            ...(overrides === undefined ? {} : { overrides: json(overrides) }),
            ...(objects === undefined ? {} : { objects: json(objects) }),
            version: nextObjectVersion(),
          },
        }),
        );
      });
    }),

  saveLayout: coursesEditProcedure
    .input(
      z.object({
        id: z.number().int().positive(),
        windowCenter: windowCenterSchema,
        printScale: z.number().int().positive().max(100_000),
        description: mapTemplateSettingsSchema.shape.description,
        objects: objectsSchema,
        /** The sheet's `version` the client edits from (docs/course-layout.md §2); omitted: last writer wins. */
        baseVersion: baseVersionSchema.optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const map = await ctx.db.courseMap.findFirst({
        where: { eventId: ctx.event.id, seq: input.id },
      });
      if (!map) notFound();
      const overrides = courseMapOverridesSchema.parse(map.overrides);
      const version = nextObjectVersion();
      await ctx.db.$transaction(async (tx) => {
        const rows = await tx.$queryRaw<{ version: bigint }[]>`
          SELECT "version" FROM "oxygen"."course_maps" WHERE "id" = ${map.id}::uuid FOR UPDATE`;
        const now = rows[0]?.version;
        if (input.baseVersion !== undefined && now !== undefined && now !== BigInt(input.baseVersion)) {
          const current = await tx.courseMap.findUniqueOrThrow({ where: { id: map.id } });
          throw versionConflict({ kind: "sheet", id: map.seq, version: now.toString(), current: parseMap(current), differing: null });
        }
        await tx.courseMap.update({
          where: { id: map.id },
          data: {
            windowCenter: json(input.windowCenter),
            overrides: json({
              ...overrides,
              printScale: input.printScale,
              description: input.description,
            }),
            objects: json(input.objects),
            version,
          },
        });
      });
      return { ok: true as const, version: version.toString() };
    }),

  delete: coursesEditProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      const result = await ctx.db.courseMap.deleteMany({
        where: { seq: input.id, eventId: ctx.event.id },
      });
      if (result.count === 0) notFound();
      return { ok: true as const };
    }),

  reorder: coursesEditProcedure
    .input(
      z.object({
        courseId: z.number().int().positive().nullable(),
        mapIds: z.array(z.number().int().positive()),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const maps = await ctx.db.courseMap.findMany({
        where: {
          eventId: ctx.event.id,
          course: input.courseId === null ? null : { seq: input.courseId },
          seq: { in: input.mapIds },
        },
        select: { id: true, seq: true },
      });
      if (maps.length !== new Set(input.mapIds).size) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Map order contains an unknown map",
        });
      }
      await ctx.db.$transaction(
        input.mapIds.map((seq, sortOrder) =>
          ctx.db.courseMap.update({
            where: { id: maps.find((map) => map.seq === seq)!.id },
            data: { sortOrder, version: nextObjectVersion() },
          }),
        ),
      );
      return { ok: true as const };
    }),
});