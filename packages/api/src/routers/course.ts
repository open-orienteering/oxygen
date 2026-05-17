import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router, eventProcedure } from "../trpc.js";
import type { PrismaClient } from "@prisma/client";
import { controlStatusToValue } from "../statusConvert.js";
import {
  WITHDRAWN_STATUSES,
  type CourseSummary,
  type CourseDetail,
  type ExpectedPosition,
  ControlStatus,
} from "@oxygen/shared";

/** Look up a course by per-event seq, returning the full row. */
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

/** Resolve a control seq to its UUID. */
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
 * matcher and the start-list / dashboard pre-computations.
 *
 * Each course_controls row carries one logical position. The status comes
 * from the referenced control. Multi-code controls list comma-separated
 * codes via control.codes.
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
    // If the previous position was BadNoTiming and this one is required,
    // the leg into this position should not count.
    if (prevWasBadNoTiming && !skip) noTiming = true;
    prevWasBadNoTiming = statusVal === ControlStatus.BadNoTiming;
    positions.push({ codes, skipMatching: skip, noTimingLeg: noTiming });
  }
  return positions;
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

  getById: eventProcedure
    .input(z.object({ id: z.number().int() }))
    .query(async ({ ctx, input }): Promise<CourseDetail> => {
      const c = await getCourseBySeq(ctx.db, ctx.event.id, input.id);
      const ccs = await ctx.db.courseControl.findMany({
        where: { courseId: c.id },
        include: { control: { select: { seq: true, codes: true } } },
        orderBy: { position: "asc" },
      });
      const classes = await ctx.db.class.findMany({
        where: { eventId: ctx.event.id, courseId: c.id, removed: false },
        select: { id: true, seq: true, name: true },
      });
      const runnerCounts = classes.length
        ? await ctx.db.runner.groupBy({
            by: ["classId"],
            _count: { classId: true },
            where: {
              eventId: ctx.event.id,
              classId: { in: classes.map((cl) => cl.id) },
              removed: false,
            },
          })
        : [];
      const runnerCountMap = new Map<string, number>(
        runnerCounts.map((rc) => [
          rc.classId ?? "",
          rc._count.classId,
        ]),
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
    }),

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
   * Web side calls this for map overlays; for now we return empty so the
   * map renders without controls overlaid.
   */
  geometry: eventProcedure
    .input(z.object({ id: z.number().int() }))
    .query(async () => ({
      type: "FeatureCollection" as const,
      features: [] as unknown[],
    })),

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
});
