import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router, eventProcedure, raceProcedure } from "../trpc.js";
import {
  WITHDRAWN_STATUSES,
  type ClassSummary,
  type ClassManageDetail,
} from "@oxygen/shared";
import { valueToRunnerStatus, runnerStatusToValue } from "../statusConvert.js";
import { emitClassUpserted } from "../referenceJournal.js";

async function getClassBySeq(
  db: import("@prisma/client").PrismaClient,
  eventId: bigint,
  seq: number,
) {
  const c = await db.class.findFirst({
    where: { eventId, seq, removed: false },
  });
  if (!c) {
    throw new TRPCError({ code: "NOT_FOUND", message: `Class ${seq} not found` });
  }
  return c;
}

async function courseSeqToId(
  db: import("@prisma/client").PrismaClient,
  eventId: bigint,
  seq: number,
): Promise<string> {
  const c = await db.course.findFirst({
    where: { eventId, seq, removed: false },
    select: { id: true },
  });
  if (!c) {
    throw new TRPCError({ code: "NOT_FOUND", message: `Course ${seq} not found` });
  }
  return c.id;
}

const withdrawnEnums = WITHDRAWN_STATUSES.map(valueToRunnerStatus);

async function loadClassDetail(
  db: import("@prisma/client").PrismaClient,
  eventId: bigint,
  seq: number,
): Promise<ClassManageDetail> {
  const c = await getClassBySeq(db, eventId, seq);
  const course = c.courseId
    ? await db.course.findUnique({
        where: { id: c.courseId },
        select: { name: true, seq: true, lengthM: true },
      })
    : null;
  const courseControlCount = c.courseId
    ? await db.courseControl.count({ where: { courseId: c.courseId } })
    : 0;
  const runners = await db.runner.findMany({
    where: { eventId, classId: c.id, removed: false },
    select: { id: true, seq: true, name: true, status: true },
    orderBy: { startNo: "asc" },
  });
  return {
    id: c.seq,
    name: c.name,
    longName: c.longName,
    courseId: course?.seq ?? 0,
    courseName: course?.name ?? "",
    courseIds: course ? [course.seq] : [],
    courseNames: course ? [course.name] : [],
    courseLength: course?.lengthM ?? 0,
    controlCount: courseControlCount,
    runnerCount: runners.length,
    sortIndex: c.sortIndex,
    sex: c.sex,
    lowAge: c.lowAge,
    highAge: c.highAge,
    freeStart: c.freeStart,
    noTiming: c.noTiming,
    allowQuickEntry: c.allowQuickEntry,
    classType: c.classType,
    classFee: c.classFeeCents,
    maxTime: c.maxTime,
    firstStart: c.firstStart,
    startInterval: c.startInterval,
    runners: runners.map((r) => ({
      id: r.seq,
      name: r.name,
      status: runnerStatusToValue(r.status),
    })),
  };
}

export const classRouter = router({
  list: eventProcedure
    .input(z.object({ search: z.string().optional() }).optional())
    .query(async ({ ctx, input }): Promise<ClassSummary[]> => {
      const eventId = ctx.event.id;
      const classes = await ctx.db.class.findMany({
        where: { eventId, removed: false },
        include: { course: { select: { name: true, lengthM: true, seq: true } } },
        orderBy: { sortIndex: "asc" },
      });

      const runners = await ctx.db.runner.findMany({
        where: { eventId, removed: false, status: { notIn: withdrawnEnums } },
        select: { classId: true },
      });
      const counts = new Map<string, number>();
      for (const r of runners) {
        if (r.classId) counts.set(r.classId, (counts.get(r.classId) ?? 0) + 1);
      }

      const courseIds = classes
        .map((c) => c.courseId)
        .filter((id): id is string => !!id);
      const grouped = courseIds.length
        ? await ctx.db.courseControl.groupBy({
            by: ["courseId"],
            _count: { courseId: true },
            where: { courseId: { in: courseIds } },
          })
        : [];
      const controlCountMap = new Map<string, number>(
        grouped.map((g) => [g.courseId, g._count.courseId]),
      );
      void controlCountMap;

      const result = classes.map((c): ClassSummary => {
        const courseSeq = c.course?.seq ?? 0;
        const courseName = c.course?.name ?? "";
        return {
          id: c.seq,
          name: c.name,
          courseId: courseSeq,
          courseName,
          courseIds: courseSeq ? [courseSeq] : [],
          courseNames: courseSeq ? [courseName] : [],
          runnerCount: counts.get(c.id) ?? 0,
          sortIndex: c.sortIndex,
          sex: c.sex,
          lowAge: c.lowAge,
          highAge: c.highAge,
          freeStart: c.freeStart,
          noTiming: c.noTiming,
          allowQuickEntry: c.allowQuickEntry,
          classType: c.classType,
          classFee: c.classFeeCents,
          maxTime: c.maxTime,
        };
      });

      if (input?.search) {
        const s = input.search.toLowerCase();
        return result.filter((c) => c.name.toLowerCase().includes(s));
      }
      return result;
    }),

  detail: eventProcedure
    .input(z.object({ id: z.number().int() }))
    .query(async ({ ctx, input }) => loadClassDetail(ctx.db, ctx.event.id, input.id)),

  getById: eventProcedure
    .input(z.object({ id: z.number().int() }))
    .query(async ({ ctx, input }) => loadClassDetail(ctx.db, ctx.event.id, input.id)),

  create: raceProcedure
    .input(
      z.object({
        name: z.string().min(1),
        longName: z.string().optional().default(""),
        courseId: z.number().int().optional(),
        sortIndex: z.number().int().optional().default(0),
        sex: z.string().optional().default(""),
        lowAge: z.number().int().optional().default(0),
        highAge: z.number().int().optional().default(0),
        classFee: z.number().int().optional().default(0),
        allowQuickEntry: z.boolean().optional().default(false),
        firstStart: z.number().int().optional().default(0),
        startInterval: z.number().int().optional().default(0),
        maxTime: z.number().int().optional().default(0),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const courseUuid = input.courseId
        ? await courseSeqToId(ctx.db, ctx.event.id, input.courseId)
        : null;
      // Table write + class.upserted journal entry commit together.
      const created = await ctx.db.$transaction(async (tx) => {
        const c = await tx.class.create({
          data: {
            eventId: ctx.event.id,
            name: input.name,
            longName: input.longName,
            courseId: courseUuid,
            sortIndex: input.sortIndex,
            sex: input.sex,
            lowAge: input.lowAge,
            highAge: input.highAge,
            classFeeCents: input.classFee,
            allowQuickEntry: input.allowQuickEntry,
            firstStart: input.firstStart,
            startInterval: input.startInterval,
            maxTime: input.maxTime,
          },
          select: { id: true, seq: true },
        });
        await emitClassUpserted(tx, ctx.event.id, c.id);
        return c;
      });
      return { id: created.seq };
    }),

  update: raceProcedure
    .input(
      z.object({
        id: z.number().int(),
        name: z.string().min(1).optional(),
        longName: z.string().optional(),
        courseId: z.number().int().nullable().optional(),
        sortIndex: z.number().int().optional(),
        sex: z.string().optional(),
        lowAge: z.number().int().optional(),
        highAge: z.number().int().optional(),
        classFee: z.number().int().optional(),
        allowQuickEntry: z.boolean().optional(),
        firstStart: z.number().int().optional(),
        startInterval: z.number().int().optional(),
        maxTime: z.number().int().optional(),
        noTiming: z.boolean().optional(),
        classType: z.string().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const c = await getClassBySeq(ctx.db, ctx.event.id, input.id);
      const data: Record<string, unknown> = {};
      if (input.name !== undefined) data.name = input.name;
      if (input.longName !== undefined) data.longName = input.longName;
      if (input.courseId !== undefined) {
        data.courseId =
          input.courseId === null
            ? null
            : await courseSeqToId(ctx.db, ctx.event.id, input.courseId);
      }
      if (input.sortIndex !== undefined) data.sortIndex = input.sortIndex;
      if (input.sex !== undefined) data.sex = input.sex;
      if (input.lowAge !== undefined) data.lowAge = input.lowAge;
      if (input.highAge !== undefined) data.highAge = input.highAge;
      if (input.classFee !== undefined) data.classFeeCents = input.classFee;
      if (input.allowQuickEntry !== undefined)
        data.allowQuickEntry = input.allowQuickEntry;
      if (input.firstStart !== undefined) data.firstStart = input.firstStart;
      if (input.startInterval !== undefined)
        data.startInterval = input.startInterval;
      if (input.maxTime !== undefined) data.maxTime = input.maxTime;
      if (input.noTiming !== undefined) data.noTiming = input.noTiming;
      if (input.classType !== undefined) data.classType = input.classType;
      await ctx.db.$transaction(async (tx) => {
        await tx.class.update({ where: { id: c.id }, data });
        await emitClassUpserted(tx, ctx.event.id, c.id);
      });
      return { ok: true };
    }),

  bulkUpdate: raceProcedure
    .input(
      z.object({
        ids: z.array(z.number().int()),
        courseId: z.number().int().nullable().optional(),
        sortIndex: z.number().int().optional(),
        classFee: z.number().int().optional(),
        firstStart: z.number().int().optional(),
        startInterval: z.number().int().optional(),
        maxTime: z.number().int().optional(),
        allowQuickEntry: z.boolean().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const rows = await ctx.db.class.findMany({
        where: { eventId: ctx.event.id, seq: { in: input.ids } },
        select: { id: true },
      });
      const data: Record<string, unknown> = {};
      if (input.courseId !== undefined) {
        data.courseId =
          input.courseId === null
            ? null
            : await courseSeqToId(ctx.db, ctx.event.id, input.courseId);
      }
      if (input.sortIndex !== undefined) data.sortIndex = input.sortIndex;
      if (input.classFee !== undefined) data.classFeeCents = input.classFee;
      if (input.firstStart !== undefined) data.firstStart = input.firstStart;
      if (input.startInterval !== undefined)
        data.startInterval = input.startInterval;
      if (input.maxTime !== undefined) data.maxTime = input.maxTime;
      if (input.allowQuickEntry !== undefined)
        data.allowQuickEntry = input.allowQuickEntry;
      await ctx.db.$transaction(async (tx) => {
        await tx.class.updateMany({
          where: { id: { in: rows.map((r) => r.id) } },
          data,
        });
        for (const r of rows) {
          await emitClassUpserted(tx, ctx.event.id, r.id);
        }
      });
      return { ok: true as const, count: rows.length };
    }),

  delete: raceProcedure
    .input(z.object({ id: z.number().int() }))
    .mutation(async ({ ctx, input }) => {
      const c = await getClassBySeq(ctx.db, ctx.event.id, input.id);
      await ctx.db.$transaction(async (tx) => {
        await tx.class.update({
          where: { id: c.id },
          data: { removed: true },
        });
        // Deletes are upserts with removed: true on the wire.
        await emitClassUpserted(tx, ctx.event.id, c.id);
      });
      return { ok: true };
    }),

  reorder: raceProcedure
    .input(z.object({ orderedIds: z.array(z.number().int()) }))
    .mutation(async ({ ctx, input }) => {
      await ctx.db.$transaction(async (tx) => {
        for (let i = 0; i < input.orderedIds.length; i++) {
          const c = await tx.class.findFirst({
            where: { eventId: ctx.event.id, seq: input.orderedIds[i] },
            select: { id: true },
          });
          if (c) {
            await tx.class.update({
              where: { id: c.id },
              data: { sortIndex: i },
            });
            await emitClassUpserted(tx, ctx.event.id, c.id);
          }
        }
      });
      return { ok: true };
    }),
});
