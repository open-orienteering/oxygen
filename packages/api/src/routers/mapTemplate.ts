import { TRPCError } from "@trpc/server";
import {
  courseMapObjectSchema,
  mapTemplateSettingsSchema,
  paperOrientationSchema,
  paperSizeSchema,
  type CourseMapObject,
  type MapTemplateSettings,
} from "@oxygen/shared";
import { z } from "zod";
import {
  Prisma,
  type MapTemplate,
} from "../generated/prisma/client.js";
import {
  resolveMapLayout,
  type ResolvedMapLayout,
} from "../course-maps/resolve-layout.js";
import { getBaseMapInfoOrNull } from "../course-maps/map-source.js";
import {
  coursesEditProcedure,
  coursesViewProcedure,
  router,
} from "../trpc.js";

const templateFields = {
  name: z.string().trim().min(1).max(120),
  paper: paperSizeSchema,
  paperWidthMm: z.number().finite().positive().max(2_000).nullable().optional(),
  paperHeightMm: z.number().finite().positive().max(2_000).nullable().optional(),
  orientation: paperOrientationSchema,
  printScale: z.number().int().positive().max(100_000),
  settings: mapTemplateSettingsSchema,
  objects: z.array(courseMapObjectSchema),
};

function json(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

function templateConflict(error: unknown, name: string): never {
  if (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2002"
  ) {
    throw new TRPCError({
      code: "CONFLICT",
      message: `Map template "${name}" already exists`,
    });
  }
  throw error;
}

type ParsedMapTemplate = Omit<MapTemplate, "settings" | "objects"> & {
  settings: MapTemplateSettings;
  objects: CourseMapObject[];
};

function parseTemplate(row: MapTemplate): ParsedMapTemplate {
  return {
    ...row,
    settings: mapTemplateSettingsSchema.parse(row.settings),
    objects: z.array(courseMapObjectSchema).parse(row.objects),
  };
}

export const mapTemplateRouter = router({
  list: coursesViewProcedure.query(async ({ ctx }) => {
    const rows = await ctx.db.mapTemplate.findMany({
      where: { eventId: ctx.event.id },
      orderBy: [{ seq: "asc" }],
    });
    return rows.map(parseTemplate);
  }),

  /**
   * Read-only layout resolution for the template editor. Without `courseId`
   * the template is resolved on its own (no overlay, window centered on the
   * map origin); with one, that course's geometry, controls and classes are
   * used exactly as `courseMap.list` would resolve them.
   */
  previewLayout: coursesViewProcedure
    .input(
      z.object({
        id: z.number().int().positive(),
        courseId: z.number().int().positive().optional(),
      }),
    )
    .query(async ({ ctx, input }): Promise<ResolvedMapLayout> => {
      const [template, event, mapInfo] = await Promise.all([
        ctx.db.mapTemplate.findFirst({
          where: { eventId: ctx.event.id, seq: input.id },
        }),
        ctx.db.event.findUnique({
          where: { id: ctx.event.id },
          select: { name: true, date: true },
        }),
        getBaseMapInfoOrNull(ctx.db, ctx.event.id),
      ]);
      if (!template) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Map template not found",
        });
      }
      const course =
        input.courseId === undefined
          ? null
          : await ctx.db.course.findFirst({
              where: {
                eventId: ctx.event.id,
                seq: input.courseId,
                removed: false,
              },
              include: {
                classes: { select: { name: true } },
                courseControls: {
                  orderBy: { position: "asc" },
                  include: { control: true },
                },
              },
            });
      if (input.courseId !== undefined && !course) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Course not found" });
      }
      return resolveMapLayout({
        kind: "course",
        template,
        course: course
          ? {
              name: course.name,
              lengthM: course.lengthM,
              climbM: course.climbM,
              geometry: course.geometry,
              classes: course.classes,
              controls: course.courseControls.map(({ control }) => control),
            }
          : null,
        mapScale: mapInfo?.scale ?? null,
        meridianTiltDeg: mapInfo?.meridianTiltDeg ?? null,
        mapName: template.name,
        ...(event ? { event } : {}),
      });
    }),

  create: coursesEditProcedure
    .input(
      z
        .object(templateFields)
        .superRefine((value, ctx) => {
          if (
            value.paper === "custom" &&
            (!value.paperWidthMm || !value.paperHeightMm)
          ) {
            ctx.addIssue({
              code: "custom",
              message: "Custom paper requires width and height",
            });
          }
        }),
    )
    .mutation(async ({ ctx, input }) => {
      try {
        const row = await ctx.db.mapTemplate.create({
          data: {
            eventId: ctx.event.id,
            name: input.name,
            paper: input.paper,
            paperWidthMm: input.paperWidthMm,
            paperHeightMm: input.paperHeightMm,
            orientation: input.orientation,
            printScale: input.printScale,
            settings: json(input.settings),
            objects: json(input.objects),
          },
        });
        return parseTemplate(row);
      } catch (error) {
        templateConflict(error, input.name);
      }
    }),

  update: coursesEditProcedure
    .input(
      z
        .object({ id: z.number().int().positive(), ...templateFields })
        .partial()
        .required({ id: true }),
    )
    .mutation(async ({ ctx, input }) => {
      const existing = await ctx.db.mapTemplate.findFirst({
        where: { eventId: ctx.event.id, seq: input.id },
      });
      if (!existing) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Map template not found" });
      }
      const { id: _publicId, settings, objects, ...fields } = input;
      void _publicId;
      try {
        const row = await ctx.db.mapTemplate.update({
          where: { id: existing.id },
          data: {
            ...fields,
            ...(settings === undefined ? {} : { settings: json(settings) }),
            ...(objects === undefined ? {} : { objects: json(objects) }),
          },
        });
        return parseTemplate(row);
      } catch (error) {
        templateConflict(error, input.name ?? existing.name);
      }
    }),

  duplicate: coursesEditProcedure
    .input(z.object({ id: z.number().int().positive(), name: z.string().trim().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const source = await ctx.db.mapTemplate.findFirst({
        where: { seq: input.id, eventId: ctx.event.id },
      });
      if (!source) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Map template not found" });
      }
      try {
        return parseTemplate(
          await ctx.db.mapTemplate.create({
            data: {
              eventId: ctx.event.id,
              name: input.name,
              paper: source.paper,
              paperWidthMm: source.paperWidthMm,
              paperHeightMm: source.paperHeightMm,
              orientation: source.orientation,
              printScale: source.printScale,
              settings: json(source.settings),
              objects: json(source.objects),
            },
          }),
        );
      } catch (error) {
        templateConflict(error, input.name);
      }
    }),

  delete: coursesEditProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      const result = await ctx.db.mapTemplate.deleteMany({
        where: { seq: input.id, eventId: ctx.event.id },
      });
      if (result.count === 0) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Map template not found" });
      }
      return { ok: true as const };
    }),

  applyToCourses: coursesEditProcedure
    .input(
      z.object({
        templateId: z.number().int().positive(),
        courseIds: z.array(z.number().int().positive()).min(1),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const template = await ctx.db.mapTemplate.findFirst({
        where: { seq: input.templateId, eventId: ctx.event.id },
      });
      if (!template) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Map template not found" });
      }
      const courses = await ctx.db.course.findMany({
        where: {
          eventId: ctx.event.id,
          seq: { in: input.courseIds },
          removed: false,
        },
        select: { id: true, name: true },
      });
      if (courses.length !== new Set(input.courseIds).size) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "One or more courses were not found",
        });
      }
      return ctx.db.$transaction(async (tx) => {
        let created = 0;
        let updated = 0;
        for (const course of courses) {
          const existing = await tx.courseMap.findMany({
            where: { eventId: ctx.event.id, courseId: course.id },
            select: { id: true },
          });
          if (existing.length === 0) {
            await tx.courseMap.create({
              data: {
                eventId: ctx.event.id,
                courseId: course.id,
                templateId: template.id,
                name: course.name,
                kind: "course",
              },
            });
            created += 1;
          } else {
            await tx.courseMap.updateMany({
              where: { id: { in: existing.map((map) => map.id) } },
              data: { templateId: template.id },
            });
            updated += existing.length;
          }
        }
        return { created, updated };
      });
    }),

  listClub: coursesViewProcedure.query(async ({ ctx }) => {
    const templates = await ctx.db.clubMapTemplate.findMany({
      orderBy: [{ name: "asc" }],
      select: { id: true, name: true, payload: true },
    });
    return templates.map((template) => {
      const payload = z
        .object({
          paper: paperSizeSchema,
          orientation: paperOrientationSchema,
          printScale: z.number().int().positive(),
        })
        .safeParse(template.payload);
      return {
        id: template.id,
        name: template.name,
        paper: payload.success ? payload.data.paper : null,
        orientation: payload.success ? payload.data.orientation : null,
        printScale: payload.success ? payload.data.printScale : null,
      };
    });
  }),

  saveToClub: coursesEditProcedure
    .input(z.object({ templateId: z.number().int().positive(), name: z.string().trim().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const template = await ctx.db.mapTemplate.findFirst({
        where: { seq: input.templateId, eventId: ctx.event.id },
      });
      if (!template) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Map template not found" });
      }
      const payload = {
        paper: template.paper,
        paperWidthMm: template.paperWidthMm,
        paperHeightMm: template.paperHeightMm,
        orientation: template.orientation,
        printScale: template.printScale,
        settings: template.settings,
        objects: template.objects,
      };
      try {
        return await ctx.db.clubMapTemplate.create({
          data: {
            name: input.name,
            payload: json(payload),
            uploadedBy: ctx.user?.id,
          },
          select: { id: true, name: true },
        });
      } catch (error) {
        templateConflict(error, input.name);
      }
    }),

  loadFromClub: coursesEditProcedure
    .input(
      z.object({
        clubTemplateId: z.coerce.bigint().positive(),
        name: z.string().trim().min(1),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const source = await ctx.db.clubMapTemplate.findUnique({
        where: { id: input.clubTemplateId },
      });
      if (!source) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Club map template not found",
        });
      }
      const payload = z
        .object({
          paper: paperSizeSchema,
          paperWidthMm: z.number().nullable(),
          paperHeightMm: z.number().nullable(),
          orientation: paperOrientationSchema,
          printScale: z.number().int().positive(),
          settings: mapTemplateSettingsSchema,
          objects: z.array(courseMapObjectSchema),
        })
        .parse(source.payload);
      // Map-anchored objects reference the source event's OCAD paper
      // coordinates and would land in nonsense positions on another event's
      // map. Keep page-anchored layout; drop the rest and report the count.
      const pageObjects = payload.objects.filter(
        (object) => object.anchor === "page",
      );
      const removedMapAnchoredCount =
        payload.objects.length - pageObjects.length;
      try {
        const template = parseTemplate(
          await ctx.db.mapTemplate.create({
            data: {
              eventId: ctx.event.id,
              name: input.name,
              paper: payload.paper,
              paperWidthMm: payload.paperWidthMm,
              paperHeightMm: payload.paperHeightMm,
              orientation: payload.orientation,
              printScale: payload.printScale,
              settings: json(payload.settings),
              objects: json(pageObjects),
            },
          }),
        );
        return { template, removedMapAnchoredCount };
      } catch (error) {
        templateConflict(error, input.name);
      }
    }),

  deleteClub: coursesEditProcedure
    .input(z.object({ id: z.coerce.bigint().positive() }))
    .mutation(async ({ ctx, input }) => {
      const result = await ctx.db.clubMapTemplate.deleteMany({
        where: { id: input.id },
      });
      if (result.count === 0) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Club map template not found",
        });
      }
      return { ok: true as const };
    }),
});
