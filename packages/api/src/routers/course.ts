import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router, eventProcedure } from "../trpc.js";
import type { PrismaClient } from "@prisma/client";
import { controlStatusToValue } from "../statusConvert.js";
import {
  type CourseSummary,
  type CourseDetail,
  type ExpectedPosition,
  ControlStatus,
} from "@oxygen/shared";

async function getCourseBySeq(
  db: PrismaClient,
  eventId: bigint,
  seq: number,
) {
  const c = await db.course.findFirst({
    where: { eventId, seq, removed: false },
  });
  if (!c) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: `Course ${seq} not found`,
    });
  }
  return c;
}

async function controlSeqToId(
  db: PrismaClient,
  eventId: bigint,
  seq: number,
): Promise<string> {
  const c = await db.control.findFirst({
    where: { eventId, seq, removed: false },
    select: { id: true },
  });
  if (!c) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: `Control ${seq} not found`,
    });
  }
  return c.id;
}

/**
 * Resolve a course's status-aware ExpectedPosition[] used by the offline
 * matcher and start-list / dashboard pre-computations.
 */
export async function resolveCourseExpectedPositions(
  db: PrismaClient,
  courseId: string,
): Promise<ExpectedPosition[]> {
  const rows = await db.courseControl.findMany({
    where: { courseId },
    include: { control: true },
    orderBy: { position: "asc" },
  });

  const positions: ExpectedPosition[] = [];
  let prevWasBadNoTiming = false;
  for (const row of rows) {
    const ctrl = row.control;
    const codes = (ctrl.codes ?? "")
      .split(";")
      .map((s) => parseInt(s.trim(), 10))
      .filter((n) => !isNaN(n) && n > 0);
    const statusVal = controlStatusToValue(ctrl.status);
    let skip = false;
    let noTiming = false;
    switch (statusVal) {
      case ControlStatus.Bad:
      case ControlStatus.Optional:
      case ControlStatus.BadNoTiming:
        skip = true;
        break;
      case ControlStatus.NoTiming:
        noTiming = true;
        break;
    }
    if (prevWasBadNoTiming && !skip) noTiming = true;
    prevWasBadNoTiming = statusVal === ControlStatus.BadNoTiming;
    positions.push({ codes, skipMatching: skip, noTimingLeg: noTiming });
  }
  return positions;
}

async function loadCourseDetail(
  db: PrismaClient,
  eventId: bigint,
  seq: number,
): Promise<CourseDetail> {
  const c = await getCourseBySeq(db, eventId, seq);
  const ccs = await db.courseControl.findMany({
    where: { courseId: c.id },
    include: { control: { select: { seq: true, codes: true } } },
    orderBy: { position: "asc" },
  });
  const classes = await db.class.findMany({
    where: { eventId, courseId: c.id, removed: false },
    select: { id: true, seq: true, name: true },
  });
  const runnerCounts = classes.length
    ? await db.runner.groupBy({
        by: ["classId"],
        _count: { classId: true },
        where: {
          eventId,
          classId: { in: classes.map((cl) => cl.id) },
          removed: false,
        },
      })
    : [];
  const runnerCountMap = new Map<string, number>(
    runnerCounts.map((rc) => [rc.classId ?? "", rc._count.classId]),
  );
  return {
    id: c.seq,
    name: c.name,
    controls: ccs.map((cc) => String(cc.control.seq)).join(";"),
    controlCount: ccs.length,
    length: c.lengthM,
    climb: c.climbM,
    numberOfMaps: c.numberOfMaps,
    firstAsStart: c.firstAsStart,
    lastAsFinish: c.lastAsFinish,
    controlCodes: ccs.map((cc) => ({
      id: cc.control.seq,
      code: (cc.control.codes ?? "").split(";")[0] ?? "",
    })),
    classes: classes.map((cl) => ({
      classId: cl.seq,
      className: cl.name,
      runnerCount: runnerCountMap.get(cl.id) ?? 0,
    })),
  };
}

export const courseRouter = router({
  list: eventProcedure.query(async ({ ctx }): Promise<CourseSummary[]> => {
    const eventId = ctx.event.id;
    const courses = await ctx.db.course.findMany({
      where: { eventId, removed: false },
      orderBy: { name: "asc" },
    });
    const counts = courses.length
      ? await ctx.db.courseControl.groupBy({
          by: ["courseId"],
          _count: { courseId: true },
          where: { courseId: { in: courses.map((c) => c.id) } },
        })
      : [];
    const countMap = new Map<string, number>(
      counts.map((c) => [c.courseId, c._count.courseId]),
    );
    return courses.map(
      (c): CourseSummary => ({
        id: c.seq,
        name: c.name,
        controls: "",
        controlCount: countMap.get(c.id) ?? 0,
        length: c.lengthM,
        climb: c.climbM,
        numberOfMaps: c.numberOfMaps,
        firstAsStart: c.firstAsStart,
        lastAsFinish: c.lastAsFinish,
      }),
    );
  }),

  detail: eventProcedure
    .input(z.object({ id: z.number().int() }))
    .query(async ({ ctx, input }) =>
      loadCourseDetail(ctx.db, ctx.event.id, input.id),
    ),

  getById: eventProcedure
    .input(z.object({ id: z.number().int() }))
    .query(async ({ ctx, input }) =>
      loadCourseDetail(ctx.db, ctx.event.id, input.id),
    ),

  create: eventProcedure
    .input(
      z.object({
        name: z.string().min(1),
        length: z.number().int().optional().default(0),
        climb: z.number().int().optional().default(0),
        numberOfMaps: z.number().int().optional().default(0),
        firstAsStart: z.boolean().optional().default(false),
        lastAsFinish: z.boolean().optional().default(false),
        controlIds: z.array(z.number().int()).optional().default([]),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const created = await ctx.db.course.create({
        data: {
          eventId: ctx.event.id,
          name: input.name,
          lengthM: input.length,
          climbM: input.climb,
          numberOfMaps: input.numberOfMaps,
          firstAsStart: input.firstAsStart,
          lastAsFinish: input.lastAsFinish,
        },
        select: { id: true, seq: true },
      });
      if (input.controlIds.length > 0) {
        const controlUuids = await Promise.all(
          input.controlIds.map((seq) =>
            controlSeqToId(ctx.db, ctx.event.id, seq),
          ),
        );
        await ctx.db.courseControl.createMany({
          data: controlUuids.map((uuid, idx) => ({
            courseId: created.id,
            position: idx + 1,
            controlId: uuid,
          })),
        });
      }
      return { id: created.seq };
    }),

  update: eventProcedure
    .input(
      z.object({
        id: z.number().int(),
        name: z.string().min(1).optional(),
        length: z.number().int().optional(),
        climb: z.number().int().optional(),
        numberOfMaps: z.number().int().optional(),
        firstAsStart: z.boolean().optional(),
        lastAsFinish: z.boolean().optional(),
        controlIds: z.array(z.number().int()).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const c = await getCourseBySeq(ctx.db, ctx.event.id, input.id);
      const data: Record<string, unknown> = {};
      if (input.name !== undefined) data.name = input.name;
      if (input.length !== undefined) data.lengthM = input.length;
      if (input.climb !== undefined) data.climbM = input.climb;
      if (input.numberOfMaps !== undefined)
        data.numberOfMaps = input.numberOfMaps;
      if (input.firstAsStart !== undefined)
        data.firstAsStart = input.firstAsStart;
      if (input.lastAsFinish !== undefined)
        data.lastAsFinish = input.lastAsFinish;
      await ctx.db.course.update({ where: { id: c.id }, data });

      if (input.controlIds !== undefined) {
        await ctx.db.courseControl.deleteMany({ where: { courseId: c.id } });
        if (input.controlIds.length > 0) {
          const controlUuids = await Promise.all(
            input.controlIds.map((seq) =>
              controlSeqToId(ctx.db, ctx.event.id, seq),
            ),
          );
          await ctx.db.courseControl.createMany({
            data: controlUuids.map((uuid, idx) => ({
              courseId: c.id,
              position: idx + 1,
              controlId: uuid,
            })),
          });
        }
      }
      return { ok: true };
    }),

  bulkUpdate: eventProcedure
    .input(
      z.object({
        ids: z.array(z.number().int()),
        numberOfMaps: z.number().int().optional(),
        climb: z.number().int().optional(),
        firstAsStart: z.boolean().optional(),
        lastAsFinish: z.boolean().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const rows = await ctx.db.course.findMany({
        where: { eventId: ctx.event.id, seq: { in: input.ids } },
        select: { id: true },
      });
      const data: Record<string, unknown> = {};
      if (input.numberOfMaps !== undefined)
        data.numberOfMaps = input.numberOfMaps;
      if (input.climb !== undefined) data.climbM = input.climb;
      if (input.firstAsStart !== undefined)
        data.firstAsStart = input.firstAsStart;
      if (input.lastAsFinish !== undefined)
        data.lastAsFinish = input.lastAsFinish;
      await ctx.db.course.updateMany({
        where: { id: { in: rows.map((r) => r.id) } },
        data,
      });
      return { ok: true as const, count: rows.length };
    }),

  delete: eventProcedure
    .input(z.object({ id: z.number().int() }))
    .mutation(async ({ ctx, input }) => {
      const c = await getCourseBySeq(ctx.db, ctx.event.id, input.id);
      await ctx.db.course.update({
        where: { id: c.id },
        data: { removed: true },
      });
      return { ok: true };
    }),

  /**
   * Course geometry — placeholder until the OCD course importer is ported.
   */
  geometry: eventProcedure
    .input(z.object({ id: z.number().int() }))
    .query(async () => ({
      type: "FeatureCollection" as const,
      features: [] as unknown[],
    })),

  /** Geometry for many courses at once. */
  courseGeometries: eventProcedure
    .input(z.object({ ids: z.array(z.number().int()).optional() }).optional())
    .query(async () => {
      // Returns empty per-course geometry until the OCD parser is re-ported.
      return [] as Array<{
        courseId: number;
        type: "FeatureCollection";
        features: unknown[];
      }>;
    }),

  /** Map metadata used by the tracks / replay pages. */
  mapMetadata: eventProcedure.query(async ({ ctx }) => {
    const map = await ctx.db.renderedMap.findFirst({
      where: { eventId: ctx.event.id },
      orderBy: { renderedAt: "desc" },
      select: { bounds: true, mapScale: true, width: true, height: true },
    });
    if (!map) return null;
    return {
      bounds: map.bounds,
      mapScale: map.mapScale,
      width: map.width,
      height: map.height,
    };
  }),

  /** Info about the uploaded OCAD map file (if any). */
  mapFileInfo: eventProcedure.query(async ({ ctx }) => {
    const f = await ctx.db.mapFile.findFirst({
      where: { eventId: ctx.event.id },
      orderBy: { uploadedAt: "desc" },
      select: { id: true, fileName: true, uploadedAt: true },
    });
    if (!f) return null;
    return {
      id: Number(f.id),
      fileName: f.fileName,
      uploadedAt: f.uploadedAt.toISOString(),
    };
  }),

  /** Cached projected control coordinates from the OCD parser. */
  controlCoordinates: eventProcedure.query(async ({ ctx }) => {
    const controls = await ctx.db.control.findMany({
      where: { eventId: ctx.event.id, removed: false },
      select: { seq: true, codes: true, lat: true, lng: true, xpos: true, ypos: true },
    });
    return controls.map((c) => ({
      controlId: c.seq,
      code: parseInt((c.codes ?? "").split(";")[0] ?? "0", 10) || 0,
      lat: c.lat,
      lng: c.lng,
      xpos: c.xpos,
      ypos: c.ypos,
    }));
  }),

  /**
   * Completion status per control — placeholder until the punch matcher
   * lands. Returns empty so the dashboard renders the "Pending" state.
   */
  controlCompletionStatus: eventProcedure
    .input(z.object({ courseId: z.number().int().optional() }).optional())
    .query(async () => {
      return [] as Array<{
        controlId: number;
        code: number;
        total: number;
        passed: number;
      }>;
    }),

  /** Upload an OCAD map file (stub — full parser pending). */
  uploadMap: eventProcedure
    .input(z.object({ fileName: z.string(), data: z.string() }))
    .mutation(async () => {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: "OCAD map upload pending re-port.",
      });
    }),

  /** Preview an IOF XML / OCD course bundle import (stub). */
  previewImport: eventProcedure
    .input(z.object({ data: z.string() }))
    .mutation(async () => {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: "Course-bundle preview pending re-port.",
      });
    }),

  /** Commit a previously-previewed import (stub). */
  importCourses: eventProcedure
    .input(z.object({ data: z.string() }))
    .mutation(async () => {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: "Course import pending re-port.",
      });
    }),
});
