import { z } from "zod";
import { router, viewProcedure, resultsViewProcedure } from "../trpc.js";
import { toAbsolute, eventNowDs } from "../timeConvert.js";
import type { StartListEntry, ResultEntry } from "@oxygen/shared";
import { loadClassStandings, compareStandings } from "../classStandings.js";
import { loadPunchedCardNos, progressFlags } from "../runnerProgress.js";

/**
 * Start list + result list endpoints. Cancelled entries are not on either
 * list (docs/bugfixes/cancellation-handling.md).
 */
export const listsRouter = router({
  startList: viewProcedure
    .input(z.object({ classId: z.number().int().optional() }).optional())
    .query(async ({ ctx, input }): Promise<StartListEntry[]> => {
      const where: Record<string, unknown> = {
        eventId: ctx.event.id,
        removed: false,
        status: { not: "cancel" },
      };
      if (input?.classId) {
        const cls = await ctx.db.class.findFirst({
          where: { eventId: ctx.event.id, seq: input.classId },
          select: { id: true },
        });
        if (!cls) return [];
        where.classId = cls.id;
      }
      const runners = await ctx.db.runner.findMany({
        where,
        include: {
          class: { select: { name: true, seq: true } },
          course: { select: { variantKey: true } },
        },
        orderBy: [{ startTime: "asc" }, { startNo: "asc" }],
      });
      const zeroTime = ctx.event.zeroTime;

      const punchSet = await loadPunchedCardNos(ctx.db, ctx.event.id);

      const meosNow = eventNowDs(ctx.event);

      return runners.map(
        (r): StartListEntry => ({
          id: r.seq,
          startNo: r.startNo,
          name: r.name,
          clubId: r.eventorClubId ? Number(r.eventorClubId) : 0,
          clubName: r.clubName,
          className: r.class?.name ?? "",
          classId: r.class?.seq ?? 0,
          startTime: toAbsolute(r.startTime, zeroTime),
          cardNo: r.cardNo ?? 0,
          bib: r.bib,
          // The runner's variant (F6b): `H21 · AC` on the start list.
          ...(r.course?.variantKey ? { variantKey: r.course.variantKey } : {}),
          ...progressFlags(r, punchSet, zeroTime, meosNow),
        }),
      );
    }),

  resultList: resultsViewProcedure
    .input(z.object({ classId: z.number().int().optional() }).optional())
    .query(async ({ ctx, input }): Promise<ResultEntry[]> => {
      let classId: string | undefined;
      if (input?.classId) {
        const cls = await ctx.db.class.findFirst({
          where: { eventId: ctx.event.id, seq: input.classId },
          select: { id: true },
        });
        if (!cls) return [];
        classId = cls.id;
      }
      // Places, adjusted times and no-timing come from the one shared
      // standings step, which the finish receipt uses too (RES-11).
      const standings = await loadClassStandings(ctx.db, ctx.event, { classId });
      standings.sort(compareStandings);

      const zeroTime = ctx.event.zeroTime;
      const punchSet = await loadPunchedCardNos(ctx.db, ctx.event.id);
      const meosNow = eventNowDs(ctx.event);

      return standings.map(
        (s): ResultEntry => ({
          id: s.runner.seq,
          place: s.place,
          name: s.runner.name,
          clubId: s.runner.eventorClubId ? Number(s.runner.eventorClubId) : 0,
          clubName: s.runner.clubName,
          className: s.className,
          classId: s.classSeq,
          startTime: s.startAbs,
          finishTime: s.finishAbs,
          runningTime: s.runningTime,
          timeBehind: s.timeBehind,
          status: s.status,
          startNo: s.runner.startNo,
          ...progressFlags(s.runner, punchSet, zeroTime, meosNow),
          ...(s.noTiming ? { noTiming: true } : {}),
        }),
      );
    }),

  classesWithCounts: viewProcedure.query(async ({ ctx }) => {
    const classes = await ctx.db.class.findMany({
      where: { eventId: ctx.event.id, removed: false },
      include: { course: { select: { name: true, lengthM: true } } },
      orderBy: { sortIndex: "asc" },
    });
    const runnerCounts = await ctx.db.runner.groupBy({
      by: ["classId"],
      _count: { classId: true },
      where: { eventId: ctx.event.id, removed: false },
    });
    const counts = new Map<string, number>(
      runnerCounts.map((r) => [r.classId ?? "", r._count.classId]),
    );
    return classes.map((c) => ({
      id: c.seq,
      name: c.name,
      courseName: c.course?.name ?? "",
      courseLength: c.course?.lengthM ?? 0,
      runnerCount: counts.get(c.id) ?? 0,
    }));
  }),
});
