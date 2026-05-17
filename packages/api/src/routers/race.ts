import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router, eventProcedure } from "../trpc.js";
import { toAbsolute } from "../timeConvert.js";
import { runnerStatusToValue } from "../statusConvert.js";

/**
 * Race-time endpoints used by the start, finish, and kiosk pages.
 * Most heavy lifting (card-to-result matching, free punch insertion) is in
 * the cardReadout router; this one is a shallow lookup layer.
 */
export const raceRouter = router({
  /** Look up a runner by SI card number for start / finish stations. */
  lookupByCard: eventProcedure
    .input(z.object({ cardNo: z.number().int().positive() }))
    .query(async ({ ctx, input }) => {
      const runner = await ctx.db.runner.findFirst({
        where: { eventId: ctx.event.id, cardNo: input.cardNo, removed: false },
        include: {
          class: {
            select: {
              name: true,
              courseId: true,
              freeStart: true,
              noTiming: true,
            },
          },
        },
      });
      if (!runner) return { found: false as const, cardNo: input.cardNo };

      const courseId = runner.courseId ?? runner.class?.courseId ?? null;
      const course = courseId
        ? await ctx.db.course.findUnique({ where: { id: courseId } })
        : null;
      const ccCount = courseId
        ? await ctx.db.courseControl.count({ where: { courseId } })
        : 0;

      const zeroTime = ctx.event.zeroTime;

      return {
        found: true as const,
        cardNo: input.cardNo,
        runner: {
          id: runner.seq,
          name: runner.name,
          clubId: runner.eventorClubId ? Number(runner.eventorClubId) : 0,
          clubName: runner.clubName,
          classId: runner.classId,
          className: runner.class?.name ?? "",
          startNo: runner.startNo,
          startTime: toAbsolute(runner.startTime, zeroTime),
          finishTime: toAbsolute(runner.finishTime, zeroTime),
          status: runnerStatusToValue(runner.status),
          courseId: course?.seq ?? 0,
          courseName: course?.name ?? "",
          courseControlCount: ccCount,
          freeStart: runner.class?.freeStart ?? false,
          noTiming: runner.class?.noTiming ?? false,
        },
      };
    }),

  /** Most-recent finishers + readouts, for the activity feed. */
  recentActivity: eventProcedure
    .input(z.object({ limit: z.number().int().min(1).max(50).default(10) }).optional())
    .query(async ({ ctx, input }) => {
      const limit = input?.limit ?? 10;
      const finishers = await ctx.db.runner.findMany({
        where: {
          eventId: ctx.event.id,
          removed: false,
          finishTime: { gt: 0 },
        },
        orderBy: { updatedAt: "desc" },
        take: limit,
        include: { class: { select: { name: true } } },
      });
      const zeroTime = ctx.event.zeroTime;
      return finishers.map((r) => ({
        runnerId: r.seq,
        name: r.name,
        className: r.class?.name ?? "",
        clubName: r.clubName,
        finishTime: toAbsolute(r.finishTime, zeroTime),
        status: runnerStatusToValue(r.status),
        updatedAt: r.updatedAt.toISOString(),
      }));
    }),

  /** Receipt payload for a finished runner — split times etc.
   *  Stub returning header info; full split-time matcher is staged. */
  finishReceipt: eventProcedure
    .input(z.object({ runnerId: z.number().int() }))
    .query(async ({ ctx, input }) => {
      const r = await ctx.db.runner.findFirst({
        where: {
          eventId: ctx.event.id,
          seq: input.runnerId,
          removed: false,
        },
        include: { class: { select: { name: true, courseId: true } } },
      });
      if (!r) return null;
      const zeroTime = ctx.event.zeroTime;
      const startAbs = toAbsolute(r.startTime, zeroTime);
      const finishAbs = toAbsolute(r.finishTime, zeroTime);
      const runningTime =
        startAbs > 0 && finishAbs > 0 ? Math.max(0, finishAbs - startAbs) : 0;

      const courseId = r.courseId ?? r.class?.courseId ?? null;
      const course = courseId
        ? await ctx.db.course.findUnique({
            where: { id: courseId },
            select: { name: true, lengthM: true, seq: true },
          })
        : null;
      const ccCount = courseId
        ? await ctx.db.courseControl.count({ where: { courseId } })
        : 0;

      return {
        // Newer flat shape — preferred:
        runnerId: r.seq,
        name: r.name,
        className: r.class?.name ?? "",
        clubName: r.clubName,
        startTime: startAbs,
        finishTime: finishAbs,
        runningTime,
        status: runnerStatusToValue(r.status),
        splits: [] as Array<{ code: number; time: number; cumulative: number }>,
        // Legacy nested shape kept for the unchanged web receipt printer.
        runner: {
          id: r.seq,
          name: r.name,
          className: r.class?.name ?? "",
          clubName: r.clubName,
          cardNo: r.cardNo,
          startNo: r.startNo,
          birthYear: r.birthYear,
        },
        timing: {
          startTime: startAbs,
          finishTime: finishAbs,
          runningTime,
          status: runnerStatusToValue(r.status),
        },
        controls: [] as Array<{
          controlIndex: number;
          controlCode: number;
          splitTime: number;
          cumTime: number;
          status: "ok" | "missing" | "extra";
          punchTime: number;
          legLength: number;
        }>,
        course: {
          id: course?.seq ?? 0,
          name: course?.name ?? "",
          length: course?.lengthM ?? 0,
          controlCount: ccCount,
        },
        position: null as { rank: number; total: number } | null,
        siac: null as
          | { voltage: number | null; batteryDate: string | null; batteryOk: boolean }
          | null,
        classResults: [] as Array<{
          rank: number;
          name: string;
          clubName: string;
          runningTime: number;
        }>,
      };
    }),

  /** Manually set a runner's finish time (used by the finish station). */
  recordFinish: eventProcedure
    .input(
      z.object({
        id: z.number().int(),
        finishTimeAbsolute: z.number().int(),
        status: z.number().int().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const r = await ctx.db.runner.findFirst({
        where: { eventId: ctx.event.id, seq: input.id, removed: false },
        select: { id: true, startTime: true },
      });
      if (!r) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Runner not found" });
      }
      const zeroTime = ctx.event.zeroTime;
      const finishRel =
        input.finishTimeAbsolute > 0 ? input.finishTimeAbsolute - zeroTime : 0;
      await ctx.db.runner.update({
        where: { id: r.id },
        data: {
          finishTime: finishRel,
          ...(input.status != null
            ? {
                status:
                  input.status === 1
                    ? "ok"
                    : input.status === 3
                      ? "missing_punch"
                      : input.status === 4
                        ? "dnf"
                        : "unknown",
              }
            : {}),
        },
      });
      return { ok: true };
    }),
});
