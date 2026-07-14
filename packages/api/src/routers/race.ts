import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router, eventProcedure } from "../trpc.js";
import { toAbsolute, toRelative } from "../timeConvert.js";
import {
  runnerStatusToValue,
  valueToRunnerStatus,
} from "../statusConvert.js";
import { performReadout } from "./cardReadout.js";
import type { ControlMatch } from "@oxygen/shared";

/**
 * Race-time endpoints used by the start, finish, and kiosk pages.
 * The heavy matching work lives in cardReadout.performReadout — this
 * router orchestrates lookups and writes.
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
              seq: true,
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
          cardNo: runner.cardNo ?? 0,
          clubId: runner.eventorClubId ? Number(runner.eventorClubId) : 0,
          clubName: runner.clubName,
          classId: runner.class?.seq ?? 0,
          className: runner.class?.name ?? "",
          startNo: runner.startNo,
          startTime: toAbsolute(runner.startTime, zeroTime),
          finishTime: toAbsolute(runner.finishTime, zeroTime),
          status: runnerStatusToValue(runner.status),
          courseId: course?.seq ?? 0,
          courseName: course?.name ?? "",
          courseControlCount: ccCount,
          freeStart: runner.class?.freeStart ?? false,
          classFreeStart: runner.class?.freeStart ?? false,
          noTiming: runner.class?.noTiming ?? false,
        },
        course: course
          ? {
              id: course.seq,
              name: course.name,
              length: course.lengthM,
              controlCount: ccCount,
            }
          : null,
      };
    }),

  /**
   * Server clock — returned both as ms-since-epoch (`now`) and as
   * deciseconds-since-midnight (`deciseconds`, in the event's local
   * timezone) for stations that want one or the other.
   */
  serverTime: eventProcedure.query(() => {
    const d = new Date();
    const deciseconds =
      (d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds()) * 10 +
      Math.floor(d.getMilliseconds() / 100);
    return { now: d.getTime(), deciseconds };
  }),

  /** Most-recent finishers, for the activity feed. */
  recentActivity: eventProcedure
    .input(
      z
        .object({ limit: z.number().int().min(1).max(50).default(10) })
        .optional(),
    )
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
      return finishers.map((r) => {
        const startAbs = toAbsolute(r.startTime, zeroTime);
        const finishAbs = toAbsolute(r.finishTime, zeroTime);
        const runningTime =
          startAbs > 0 && finishAbs > 0
            ? Math.max(0, finishAbs - startAbs)
            : 0;
        return {
          id: r.seq,
          runnerId: r.seq,
          name: r.name,
          className: r.class?.name ?? "",
          clubName: r.clubName,
          finishTime: finishAbs,
          startTime: startAbs,
          runningTime,
          status: runnerStatusToValue(r.status),
          updatedAt: r.updatedAt.toISOString(),
        };
      });
    }),

  /**
   * Receipt payload for a finished runner. Runs the matcher to produce
   * split times + position + status, then translates the result into
   * the legacy nested shape expected by the receipt printer + the
   * kiosk `kiosk-print-receipt` forwarder.
   */
  finishReceipt: eventProcedure
    .input(z.object({ runnerId: z.number().int() }))
    .query(async ({ ctx, input }) => {
      const runner = await ctx.db.runner.findFirst({
        where: {
          eventId: ctx.event.id,
          seq: input.runnerId,
          removed: false,
        },
        select: { id: true, classId: true },
      });
      if (!runner) return null;

      const r = await performReadout(
        ctx.db,
        ctx.event.id,
        ctx.event.zeroTime,
        runner.id,
      );
      if (!r) return null;

      // Build split times. The matcher's `controls` array is already
      // ordered by course position. We compute split + cum from the
      // punch times; first split is from start.
      let lastTime = r.timing.startTime;
      let cum = 0;
      const splits: Array<{
        controlIndex: number;
        controlCode: number;
        splitTime: number;
        cumTime: number;
        status: "ok" | "missing" | "extra";
        punchTime: number;
        legLength: number;
      }> = [];
      const legs = r.course?.legs ?? [];
      r.controls.forEach((m: ControlMatch, idx) => {
        if (m.positionMode === "skipped") return;
        const status: "ok" | "missing" | "extra" = m.status;
        const punchTime = m.punchTime;
        const split = m.splitTime;
        cum = m.cumTime;
        splits.push({
          controlIndex: idx,
          controlCode: m.controlCode,
          splitTime: split,
          cumTime: cum,
          status,
          punchTime,
          // `legs[i]` is the leg leading INTO position `i`, matching
          // the matcher's `controls` index ordering (finish included
          // as the last entry). Falls back to 0 for unknown lengths.
          legLength: legs[idx] ?? 0,
        });
        if (status === "ok" && punchTime > 0) lastTime = punchTime;
      });

      // Position within class.
      //
      // The old implementation pulled every finished runner in the
      // event into Node and sorted in JS — O(N) per receipt across
      // the whole event, which is wasteful when the finish receipt
      // only needs to know "how many same-class runners beat this
      // running time?". Postgres can answer both halves of that
      // question with a parameterised filtered count using the
      // existing `(event_id, class_id, removed)` index path, so we
      // push the computation down: one count for the rank, one for
      // the total. Two trivial index-only counts beat a 5 000-row
      // fetch + JS sort on every kiosk readout.
      let position: { rank: number; total: number } | null = null;
      if (
        r.timing.status === 1 &&
        r.timing.runningTime > 0 &&
        runner.classId
      ) {
        const myRunningTime =
          (r.timing.finishTime > 0 ? r.timing.finishTime : 0) -
          (r.timing.startTime > 0 ? r.timing.startTime : 0);

        if (myRunningTime > 0) {
          // OK-status, valid-time peers in the same class.
          const baseWhere = {
            eventId: ctx.event.id,
            removed: false,
            classId: runner.classId,
            status: valueToRunnerStatus(1),
            finishTime: { gt: 0 },
            startTime: { gt: 0 },
          } as const;

          const [strictlyFaster, total] = await Promise.all([
            // Rank = strictly-faster peers + 1 (ties share a rank).
            // `finishTime - startTime` isn't directly indexed; in the
            // common case where `startTime` is the same across the
            // class (mass start or per-class draw) the planner can
            // still use the (event_id, class_id, removed) index and
            // filter on the projection cheaply.
            ctx.db.$queryRaw<Array<{ count: bigint }>>`
              SELECT COUNT(*)::bigint AS count
              FROM oxygen.runners
              WHERE event_id = ${ctx.event.id}
                AND class_id = ${runner.classId}::uuid
                AND removed = false
                AND status = 'ok'::oxygen.runner_status
                AND finish_time > 0
                AND start_time > 0
                AND (finish_time - start_time) < ${myRunningTime}
            `,
            ctx.db.runner.count({ where: baseWhere }),
          ]);

          const rank = Number(strictlyFaster[0]?.count ?? 0n) + 1;
          position = total > 0 ? { rank, total } : null;
        }
      }

      return {
        // Flat shape (handy for newer callers):
        runnerId: r.runner.id,
        name: r.runner.name,
        className: r.runner.className,
        clubName: r.runner.clubName,
        startTime: r.timing.startTime,
        finishTime: r.timing.finishTime,
        runningTime: r.timing.runningTime,
        status: r.timing.status,
        splits: splits.map((s) => ({
          code: s.controlCode,
          time: s.punchTime,
          cumulative: s.cumTime,
        })),

        // Legacy nested shape used by the receipt printer.
        runner: {
          id: r.runner.id,
          name: r.runner.name,
          className: r.runner.className,
          clubName: r.runner.clubName,
          cardNo: r.runner.cardNo ?? 0,
          startNo: r.runner.startNo,
          birthYear: 0, // omitted in fast path
        },
        timing: {
          startTime: r.timing.startTime,
          finishTime: r.timing.finishTime,
          runningTime: r.timing.runningTime,
          status: r.timing.status,
        },
        controls: splits,
        course: r.course
          ? {
              id: r.course.id,
              name: r.course.name,
              length: r.course.length,
              controlCount: r.course.controlCount,
            }
          : null,
        position,
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

  /**
   * Record a finish (manual entry from the finish station). After
   * writing the finish time, runs the matcher so the response carries
   * the same shape the UI expects — name, class, club, computed
   * running time, and status. Caller can pass either `id` or
   * `runnerId` (legacy field name; kept for compatibility).
   */
  recordFinish: eventProcedure
    .input(
      z
        .object({
          id: z.number().int().optional(),
          runnerId: z.number().int().optional(),
          finishTimeAbsolute: z.number().int().optional(),
          finishTime: z.number().int().optional(),
          status: z.number().int().optional(),
        })
        .refine((x) => (x.id ?? x.runnerId) != null, {
          message: "id or runnerId required",
        }),
    )
    .mutation(async ({ ctx, input }) => {
      const seq = input.id ?? input.runnerId!;
      const finishAbs = input.finishTimeAbsolute ?? input.finishTime ?? 0;
      const r = await ctx.db.runner.findFirst({
        where: { eventId: ctx.event.id, seq, removed: false },
        select: { id: true },
      });
      if (!r) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Runner not found" });
      }
      const zeroTime = ctx.event.zeroTime;
      const finishRel = finishAbs > 0 ? toRelative(finishAbs, zeroTime) : 0;
      const data: Record<string, unknown> = { finishTime: finishRel };
      if (input.status != null) data.status = valueToRunnerStatus(input.status);
      await ctx.db.runner.update({ where: { id: r.id }, data });

      // Re-run the matcher so the caller gets the final result.
      const result = await performReadout(
        ctx.db,
        ctx.event.id,
        ctx.event.zeroTime,
        r.id,
      );
      // Always return the rich shape; fall back to runner row values if
      // performReadout failed (no card, no course).
      const runner = await ctx.db.runner.findUnique({
        where: { id: r.id },
        include: { class: { select: { name: true } } },
      });
      return {
        ok: true as const,
        id: result?.runner.id ?? runner?.seq ?? seq,
        name: result?.runner.name ?? runner?.name ?? "",
        className: result?.runner.className ?? runner?.class?.name ?? "",
        clubName: result?.runner.clubName ?? runner?.clubName ?? "",
        cardNo: result?.runner.cardNo ?? runner?.cardNo ?? 0,
        startTime:
          result?.timing.startTime ??
          (runner ? toAbsolute(runner.startTime, zeroTime) : 0),
        finishTime: result?.timing.finishTime ?? finishAbs,
        runningTime: result?.timing.runningTime ?? 0,
        status: result?.timing.status ?? input.status ?? 0,
      };
    }),
});
