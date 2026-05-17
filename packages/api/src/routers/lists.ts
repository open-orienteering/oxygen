import { z } from "zod";
import { router, eventProcedure } from "../trpc.js";
import { toAbsolute } from "../timeConvert.js";
import { runnerStatusToValue } from "../statusConvert.js";
import type { StartListEntry, ResultEntry } from "@oxygen/shared";

/**
 * Start list + result list endpoints. Minimal port — sorts and presents
 * runners with their class/club context. Adjusted running time / split
 * placements are coming in a follow-up alongside the punch matcher port.
 */
export const listsRouter = router({
  startList: eventProcedure
    .input(z.object({ classId: z.number().int().optional() }).optional())
    .query(async ({ ctx, input }): Promise<StartListEntry[]> => {
      const where: Record<string, unknown> = {
        eventId: ctx.event.id,
        removed: false,
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
        include: { class: { select: { name: true, seq: true } } },
        orderBy: [{ startTime: "asc" }, { startNo: "asc" }],
      });
      const zeroTime = ctx.event.zeroTime;

      const punchCards = await ctx.db.punch.groupBy({
        by: ["cardNo"],
        where: { eventId: ctx.event.id, removed: false },
      });
      const punchSet = new Set(punchCards.map((p) => p.cardNo));

      const now = new Date();
      const meosNow =
        (now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds()) * 10;

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
          cardNo: r.cardNo,
          bib: r.bib,
          hasPunches: punchSet.has(r.cardNo) || undefined,
          hasStarted:
            (r.startTime > 0 &&
              (r.startTime <= 1 ||
                meosNow >= toAbsolute(r.startTime, zeroTime))) || undefined,
        }),
      );
    }),

  resultList: eventProcedure
    .input(z.object({ classId: z.number().int().optional() }).optional())
    .query(async ({ ctx, input }): Promise<ResultEntry[]> => {
      const where: Record<string, unknown> = {
        eventId: ctx.event.id,
        removed: false,
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
        include: { class: { select: { name: true, seq: true } } },
      });
      const zeroTime = ctx.event.zeroTime;

      const enriched = runners.map((r) => {
        const status = runnerStatusToValue(r.status);
        const startAbs = toAbsolute(r.startTime, zeroTime);
        const finishAbs = toAbsolute(r.finishTime, zeroTime);
        const runningTime =
          startAbs > 0 && finishAbs > 0 ? Math.max(0, finishAbs - startAbs) : 0;
        return { r, status, startAbs, finishAbs, runningTime };
      });

      // Sort by class, then status (OK first, then others), then running time.
      enriched.sort((a, b) => {
        const aOk = a.status === 1 ? 0 : 1;
        const bOk = b.status === 1 ? 0 : 1;
        if (aOk !== bOk) return aOk - bOk;
        if (aOk === 0) return a.runningTime - b.runningTime;
        return 0;
      });

      // Compute place + timeBehind within each class.
      const placesByClass = new Map<string, { winner: number; place: number }>();
      const result: ResultEntry[] = [];
      for (const e of enriched) {
        const classKey = e.r.classId ?? "";
        if (e.status === 1 && e.runningTime > 0) {
          let entry = placesByClass.get(classKey);
          if (!entry) {
            entry = { winner: e.runningTime, place: 0 };
            placesByClass.set(classKey, entry);
          }
          entry.place++;
          result.push({
            id: e.r.seq,
            place: entry.place,
            name: e.r.name,
            clubId: e.r.eventorClubId ? Number(e.r.eventorClubId) : 0,
            clubName: e.r.clubName,
            className: e.r.class?.name ?? "",
            classId: e.r.class?.seq ?? 0,
            startTime: e.startAbs,
            finishTime: e.finishAbs,
            runningTime: e.runningTime,
            timeBehind: e.runningTime - entry.winner,
            status: e.status,
            startNo: e.r.startNo,
          });
        } else {
          result.push({
            id: e.r.seq,
            place: 0,
            name: e.r.name,
            clubId: e.r.eventorClubId ? Number(e.r.eventorClubId) : 0,
            clubName: e.r.clubName,
            className: e.r.class?.name ?? "",
            classId: e.r.class?.seq ?? 0,
            startTime: e.startAbs,
            finishTime: e.finishAbs,
            runningTime: 0,
            timeBehind: 0,
            status: e.status,
            startNo: e.r.startNo,
          });
        }
      }
      return result;
    }),

  classesWithCounts: eventProcedure.query(async ({ ctx }) => {
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
