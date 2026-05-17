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
