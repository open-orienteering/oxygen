import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router, kioskOrRaceOperateProcedure, raceOperateRaceProcedure, raceOperateProcedure } from "../trpc.js";
import { toAbsolute, toRelative, toRelativeChecked, hasTime, eventTimeZone } from "../timeConvert.js";
import { timeOfDayDs, runningTimeDs, RunnerStatus } from "@oxygen/shared";
import {
  runnerStatusToValue,
  valueToRunnerStatus,
} from "../statusConvert.js";
import { performReadout } from "./cardReadout.js";
import { appendJournal } from "../journalEmit.js";
import { loadClassStandings } from "../classStandings.js";
import type { ControlMatch } from "@oxygen/shared";

/**
 * Race-time endpoints used by the start, finish, and kiosk pages.
 * The heavy matching work lives in cardReadout.performReadout — this
 * router orchestrates lookups and writes.
 */
export const raceRouter = router({
  /** Look up a runner by SI card number for start / finish stations. */
  lookupByCard: kioskOrRaceOperateProcedure
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
   * deciseconds since midnight in the event's own time zone
   * (`deciseconds`), with that zone (`timeZone`). Stations poll it now and
   * then and tick locally from the offset (`useEventClock`).
   */
  serverTime: kioskOrRaceOperateProcedure.query(({ ctx }) => {
    const now = Date.now();
    const timeZone = eventTimeZone(ctx.event);
    return { now, deciseconds: timeOfDayDs(now, timeZone), timeZone };
  }),

  /** Most-recent finishers, for the activity feed. */
  recentActivity: kioskOrRaceOperateProcedure
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
          finishTime: { not: 0 },
        },
        orderBy: { updatedAt: "desc" },
        take: limit,
        include: { class: { select: { name: true } } },
      });
      const zeroTime = ctx.event.zeroTime;
      return finishers.map((r) => {
        const startAbs = toAbsolute(r.startTime, zeroTime);
        const finishAbs = toAbsolute(r.finishTime, zeroTime);
        const runningTime = runningTimeDs(startAbs, finishAbs);
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
  finishReceipt: kioskOrRaceOperateProcedure
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
      // ordered by course position; `legs[i]` is the leg leading INTO
      // position `i`, so `legs[controls.length]` is the finish leg.
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
      // The latest OK punch, not the last array entry: free order appends
      // missing entries after the punched ones (CRS-013).
      let lastPunch = 0;
      r.controls.forEach((m: ControlMatch, idx) => {
        if (m.positionMode === "skipped") return;
        splits.push({
          controlIndex: idx,
          controlCode: m.controlCode,
          splitTime: m.splitTime,
          cumTime: m.cumTime,
          status: m.status,
          punchTime: m.punchTime,
          legLength: legs[idx] ?? 0,
        });
        if (m.status === "ok" && m.punchTime > 0) {
          if (lastPunch === 0 || runningTimeDs(lastPunch, m.punchTime) > 0) lastPunch = m.punchTime;
        }
      });
      const legFrom = lastPunch || r.timing.startTime;
      // The finish leg: from the last control (or the start) to the finish.
      const finish = {
        splitTime:
          r.timing.finishTime > 0 && legFrom > 0 ? runningTimeDs(legFrom, r.timing.finishTime) : 0,
        legLength: legs[r.controls.length] ?? 0,
      };

      // Position within class, from the same standings step as the result
      // list (adjusted times, shared places for ties, unplaced in no-timing
      // classes). The runner's own row is taken from this readout, so rank
      // and total agree before the result is saved (CRS-039).
      let position: { rank: number; total: number } | null = null;
      if (r.timing.status === RunnerStatus.OK && r.timing.runningTime > 0 && runner.classId) {
        const standings = await loadClassStandings(ctx.db, ctx.event, {
          classId: runner.classId,
          override: {
            runnerId: runner.id,
            status: r.timing.status,
            startTime: r.timing.startTime,
            finishTime: r.timing.finishTime,
            runningTimeAdjustment: r.timing.runningTimeAdjustment,
          },
        });
        const mine = standings.find((s) => s.runner.id === runner.id);
        if (mine && mine.place > 0) {
          position = { rank: mine.place, total: standings.filter((s) => s.place > 0).length };
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
        finish,
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
  recordFinish: raceOperateRaceProcedure
    .input(
      z
        .object({
          id: z.number().int().optional(),
          runnerId: z.number().int().optional(),
          finishTimeAbsolute: z.number().int().optional(),
          finishTime: z.number().int().optional(),
          status: z.number().int().optional(),
          /**
           * Replace a finish the runner already has with a different time
           * (WEB-53). Without it the call is refused with `FINISH_EXISTS`,
           * so the Finish Station asks first, even when its cached runner
           * row is stale.
           */
          allowOverwrite: z.boolean().optional().default(false),
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
        select: { id: true, cardNo: true, finishTime: true },
      });
      if (!r) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Runner not found" });
      }
      const zeroTime = ctx.event.zeroTime;
      const finishRel = finishAbs > 0 ? toRelativeChecked(finishAbs, zeroTime) : 0;
      if (r.finishTime !== 0 && finishRel !== r.finishTime && !input.allowOverwrite) {
        throw new TRPCError({
          code: "CONFLICT",
          message: `FINISH_EXISTS: the runner already has a finish (${toAbsolute(r.finishTime, zeroTime)})`,
        });
      }
      // A finish keyed in here is "by hand": a later card read without a
      // finish punch keeps it (SI-10).
      const data: Record<string, unknown> = { finishTime: finishRel, finishManual: finishRel !== 0 };
      if (input.status != null) {
        data.status = valueToRunnerStatus(input.status);
        data.statusManual = input.status !== 0;
      }
      // Table write + journal entry commit or roll back together.
      await ctx.db.$transaction(async (tx) => {
        await tx.runner.update({ where: { id: r.id }, data });
        await appendJournal(tx, {
          eventId: ctx.event.id,
          type: "finish.adjusted",
          payload: {
            cardNo: r.cardNo,
            runnerId: seq,
            finishTime: finishAbs,
            ...(input.status != null ? { status: input.status } : {}),
          },
        });
      });

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
