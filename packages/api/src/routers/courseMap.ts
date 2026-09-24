import { TRPCError } from "@trpc/server";
import {
  courseMapObjectSchema,
  courseMapOverridesSchema,
  mapTemplateSettingsSchema,
  validateCourseMap,
  type CourseMapDocument,
  type CourseMapObject,
  type CourseMapOverrides,
  type CourseOverlayLeg,
  type DescriptionRow,
  type DescriptionSheetHeader,
  type MapPoint,
  type MapWindow,
} from "@oxygen/shared";
import { z } from "zod";
import { Prisma } from "../generated/prisma/client.js";
import { resolveMapLayout } from "../course-maps/resolve-layout.js";
import { getBaseMapInfoOrNull } from "../course-maps/map-source.js";
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
  } | null;
  controls: Array<
    MapPoint & {
      id: string;
      code: string;
      type: "start" | "control" | "finish";
      cuts?: Array<{ start: number; end: number }>;
    }
  >;
  legs: CourseOverlayLeg[];
  descriptionRows: DescriptionRow[];
  /** IOF 3-row header for course maps; null → single title row. */
  descriptionHeader: DescriptionSheetHeader | null;
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

function json(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

function parseMap<T extends {
  windowCenter: unknown;
  overrides: unknown;
  objects: unknown;
}>(row: T) {
  return {
    ...row,
    windowCenter:
      row.windowCenter === null
        ? null
        : windowCenterSchema.parse(row.windowCenter),
    overrides: courseMapOverridesSchema.parse(row.overrides),
    objects: objectsSchema.parse(row.objects),
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
        status: true,
        xpos: true,
        ypos: true,
        description: true,
      },
    });

    const parsed = rows.map(parseMap);
    const windowsByCourse = new Map<string, MapWindow[]>();

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
      const layout = resolveMapLayout({
        kind: row.kind,
        template: row.template,
        overrides: row.overrides,
        objects: row.objects,
        course: row.course
          ? {
              name: row.course.name,
              lengthM: row.course.lengthM,
              climbM: row.course.climbM,
              geometry: row.course.geometry,
              classes: row.course.classes,
              controls: row.course.courseControls.map(
                ({ control }) => control,
              ),
              descriptionInstructions: row.course.descriptionInstructions,
            }
          : null,
        allControls: controlsForAll,
        ...(eventRow ? { event: eventRow } : {}),
        windowCenter: row.windowCenter,
        mapScale: mapInfo?.scale ?? null,
        meridianTiltDeg: mapInfo?.meridianTiltDeg ?? null,
        mapName: row.name,
      });
      const key = row.courseId ?? "all_controls";
      const windows = windowsByCourse.get(key);
      if (windows) windows.push(layout.window);
      else windowsByCourse.set(key, [layout.window]);
      return {
        ...row,
        resolved: { document: layout.document, window: layout.window },
        controls: layout.controls,
        legs: layout.legs,
        descriptionRows: layout.descriptionRows,
        descriptionHeader: layout.descriptionHeader,
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
              windows: windowsByCourse.get(row.courseId ?? "all_controls"),
              variants: [{ key: "", controls: row.controls }],
              descriptionRowCount: row.descriptionRows.length,
              descriptionHeaderRows: row.descriptionHeader ? 3 : 1,
            })
          : row.validation;
      const controls = "controls" in row ? row.controls : [];
      const legs = "legs" in row ? row.legs : [];
      const descriptionRows =
        "descriptionRows" in row ? row.descriptionRows : [];
      const descriptionHeader =
        "descriptionHeader" in row ? row.descriptionHeader : null;
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
          ? { seq: row.template.seq, name: row.template.name }
          : null,
        controls,
        legs,
        descriptionRows,
        descriptionHeader,
        resolved,
        validation,
      };
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
        windowCenter,
        overrides,
        objects,
        templateId,
        ...fields
      } = input;
      void _publicId;
      return parseMap(
        await ctx.db.courseMap.update({
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
          },
        }),
      );
    }),

  saveLayout: coursesEditProcedure
    .input(
      z.object({
        id: z.number().int().positive(),
        windowCenter: windowCenterSchema,
        printScale: z.number().int().positive().max(100_000),
        description: mapTemplateSettingsSchema.shape.description,
        objects: objectsSchema,
        templateObjects: objectsSchema,
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const map = await ctx.db.courseMap.findFirst({
        where: { eventId: ctx.event.id, seq: input.id },
        include: { template: true },
      });
      if (!map) notFound();
      const overrides = courseMapOverridesSchema.parse(map.overrides);
      await ctx.db.$transaction(async (tx) => {
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
          },
        });
        if (map.template) {
          await tx.mapTemplate.update({
            where: { id: map.template.id },
            data: { objects: json(input.templateObjects) },
          });
        }
      });
      return { ok: true as const };
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
            data: { sortOrder },
          }),
        ),
      );
      return { ok: true as const };
    }),
});