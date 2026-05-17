import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router, eventProcedure } from "../trpc.js";
import type { PrismaClient } from "@prisma/client";
import {
  controlStatusToValue,
  valueToControlStatus,
} from "../statusConvert.js";
import type {
  ControlInfo,
  ControlDetail,
  ControlConfig,
  ControlUnit as ControlUnitDto,
} from "@oxygen/shared";

/** Resolve a control by its per-event seq. */
async function getControlBySeq(
  db: PrismaClient,
  eventId: bigint,
  seq: number,
) {
  const c = await db.control.findFirst({
    where: { eventId, seq, removed: false },
  });
  if (!c) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: `Control ${seq} not found`,
    });
  }
  return c;
}

function unitToDto(u: {
  stationSerial: number;
  lastProgrammedCode: number | null;
  batteryVoltageMv: number | null;
  batteryLow: boolean;
  checkedAt: Date | null;
  memoryClearedAt: Date | null;
  firmwareVersion: string | null;
  modelId: number | null;
  modelName: string | null;
  lastSeenAt: Date | null;
}): ControlUnitDto {
  return {
    stationSerial: u.stationSerial,
    lastProgrammedCode: u.lastProgrammedCode,
    batteryVoltage: u.batteryVoltageMv != null ? u.batteryVoltageMv / 1000 : null,
    batteryLow: u.batteryLow,
    checkedAt: u.checkedAt?.toISOString() ?? null,
    memoryClearedAt: u.memoryClearedAt?.toISOString() ?? null,
    firmwareVersion: u.firmwareVersion,
    modelId: u.modelId,
    modelName: u.modelName,
    lastSeenAt: u.lastSeenAt?.toISOString() ?? null,
  };
}

function aggregateConfig(units: ControlUnitDto[], radioType: string, airPlus: string): ControlConfig | null {
  if (units.length === 0) return null;
  // Aggregate battery: lowest mv across units, OR'd low flag
  const voltages = units.map((u) => u.batteryVoltage).filter((v): v is number => v != null);
  const batteryVoltage = voltages.length ? Math.min(...voltages) : null;
  const batteryLow = units.some((u) => u.batteryLow);
  const checkedAt = units
    .map((u) => u.checkedAt)
    .filter((d): d is string => !!d)
    .sort()
    .at(-1) ?? null;
  const memoryClearedAt = units
    .map((u) => u.memoryClearedAt)
    .filter((d): d is string => !!d)
    .sort()
    .at(-1) ?? null;
  return {
    radioType: radioType as ControlConfig["radioType"],
    airPlus: airPlus as ControlConfig["airPlus"],
    autosendMode: "default" as ControlConfig["autosendMode"],
    batteryVoltage,
    batteryLow,
    checkedAt,
    memoryClearedAt,
  };
}

export const controlRouter = router({
  list: eventProcedure.query(async ({ ctx }): Promise<ControlInfo[]> => {
    const eventId = ctx.event.id;
    const controls = await ctx.db.control.findMany({
      where: { eventId, removed: false },
      orderBy: { seq: "asc" },
    });
    const units = await ctx.db.controlUnit.findMany({ where: { eventId } });
    const unitsByControl = new Map<string, typeof units>();
    for (const u of units) {
      if (!u.controlId) continue;
      const arr = unitsByControl.get(u.controlId) ?? [];
      arr.push(u);
      unitsByControl.set(u.controlId, arr);
    }

    // For each control, the number of runners on courses that include it.
    const ccs = await ctx.db.courseControl.findMany({
      select: { controlId: true, courseId: true },
    });
    const coursesByControl = new Map<string, Set<string>>();
    for (const cc of ccs) {
      const set = coursesByControl.get(cc.controlId) ?? new Set();
      set.add(cc.courseId);
      coursesByControl.set(cc.controlId, set);
    }
    const runnerCountByCourse = await ctx.db.class.findMany({
      where: { eventId, removed: false, courseId: { not: null } },
      select: { id: true, courseId: true },
    });
    const courseToClasses = new Map<string, Set<string>>();
    for (const cls of runnerCountByCourse) {
      if (!cls.courseId) continue;
      const set = courseToClasses.get(cls.courseId) ?? new Set();
      set.add(cls.id);
      courseToClasses.set(cls.courseId, set);
    }
    const allClassIds = [...new Set(runnerCountByCourse.map((c) => c.id))];
    const runnerCounts = allClassIds.length
      ? await ctx.db.runner.groupBy({
          by: ["classId"],
          _count: { classId: true },
          where: {
            eventId,
            removed: false,
            classId: { in: allClassIds },
          },
        })
      : [];
    const runnerCountByClass = new Map<string, number>(
      runnerCounts.map((rc) => [rc.classId ?? "", rc._count.classId]),
    );

    return controls.map((c): ControlInfo => {
      const u = (unitsByControl.get(c.id) ?? []).map(unitToDto);
      const courseSet = coursesByControl.get(c.id) ?? new Set();
      let runners = 0;
      for (const courseId of courseSet) {
        const classes = courseToClasses.get(courseId) ?? new Set();
        for (const clsId of classes) {
          runners += runnerCountByClass.get(clsId) ?? 0;
        }
      }
      return {
        id: c.seq,
        name: c.name,
        codes: c.codes,
        status: controlStatusToValue(c.status),
        timeAdjust: c.timeAdjust,
        minTime: c.minTime,
        runnerCount: runners,
        config: aggregateConfig(u, c.radioType, c.airPlus),
        units: u,
      };
    });
  }),

  getById: eventProcedure
    .input(z.object({ id: z.number().int() }))
    .query(async ({ ctx, input }): Promise<ControlDetail> => {
      const c = await getControlBySeq(ctx.db, ctx.event.id, input.id);
      const units = await ctx.db.controlUnit.findMany({
        where: { eventId: ctx.event.id, controlId: c.id },
      });
      const u = units.map(unitToDto);
      const ccs = await ctx.db.courseControl.findMany({
        where: { controlId: c.id },
        include: { course: { select: { id: true, seq: true, name: true } } },
      });
      const courseOccurrences = new Map<string, { seq: number; name: string; count: number }>();
      for (const cc of ccs) {
        const existing = courseOccurrences.get(cc.course.id);
        if (existing) existing.count++;
        else
          courseOccurrences.set(cc.course.id, {
            seq: cc.course.seq,
            name: cc.course.name,
            count: 1,
          });
      }
      const courses = await Promise.all(
        [...courseOccurrences.entries()].map(async ([courseId, info]) => {
          const classes = await ctx.db.class.findMany({
            where: { eventId: ctx.event.id, courseId, removed: false },
            select: { id: true },
          });
          const runnerCount = classes.length
            ? await ctx.db.runner.count({
                where: {
                  eventId: ctx.event.id,
                  removed: false,
                  classId: { in: classes.map((cl) => cl.id) },
                },
              })
            : 0;
          return {
            courseId: info.seq,
            courseName: info.name,
            occurrences: info.count,
            runnerCount,
          };
        }),
      );
      return {
        id: c.seq,
        name: c.name,
        codes: c.codes,
        status: controlStatusToValue(c.status),
        timeAdjust: c.timeAdjust,
        minTime: c.minTime,
        runnerCount: courses.reduce((sum, c) => sum + c.runnerCount, 0),
        config: aggregateConfig(u, c.radioType, c.airPlus),
        units: u,
        courses,
      };
    }),

  create: eventProcedure
    .input(
      z.object({
        name: z.string().optional().default(""),
        codes: z.string().min(1),
        status: z.number().int().optional().default(0),
        timeAdjust: z.number().int().optional().default(0),
        minTime: z.number().int().optional().default(0),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const created = await ctx.db.control.create({
        data: {
          eventId: ctx.event.id,
          name: input.name,
          codes: input.codes,
          status: valueToControlStatus(input.status),
          timeAdjust: input.timeAdjust,
          minTime: input.minTime,
        },
        select: { seq: true },
      });
      return { id: created.seq };
    }),

  update: eventProcedure
    .input(
      z.object({
        id: z.number().int(),
        name: z.string().optional(),
        codes: z.string().optional(),
        status: z.number().int().optional(),
        timeAdjust: z.number().int().optional(),
        minTime: z.number().int().optional(),
        radioType: z.string().optional(),
        airPlus: z.string().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const c = await getControlBySeq(ctx.db, ctx.event.id, input.id);
      const data: Record<string, unknown> = {};
      if (input.name !== undefined) data.name = input.name;
      if (input.codes !== undefined) data.codes = input.codes;
      if (input.status !== undefined)
        data.status = valueToControlStatus(input.status);
      if (input.timeAdjust !== undefined) data.timeAdjust = input.timeAdjust;
      if (input.minTime !== undefined) data.minTime = input.minTime;
      if (input.radioType !== undefined) data.radioType = input.radioType;
      if (input.airPlus !== undefined) data.airPlus = input.airPlus;
      await ctx.db.control.update({ where: { id: c.id }, data });
      return { ok: true };
    }),

  delete: eventProcedure
    .input(z.object({ id: z.number().int() }))
    .mutation(async ({ ctx, input }) => {
      const c = await getControlBySeq(ctx.db, ctx.event.id, input.id);
      await ctx.db.control.update({
        where: { id: c.id },
        data: { removed: true },
      });
      return { ok: true };
    }),
});
