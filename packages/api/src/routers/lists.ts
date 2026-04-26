import { z } from "zod";
import { router, competitionProcedure } from "../trpc.js";
import {getZeroTime} from "../db.js";
import { toAbsolute } from "../timeConvert.js";
import {
  RunnerStatus,
  type StartListEntry,
  type ResultEntry,
  type ClassDetail,
  matchPunchesToCourse,
  parsePunches,
  type ExpectedPosition,
} from "@oxygen/shared";
import { computeClassPlacements } from "../results.js";
import { resolveCourseExpectedPositions } from "./course.js";

export const listsRouter = router({
  /**
   * Get start list, optionally filtered by class.
   * Sorted by class sort index, then start time.
   */
  startList: competitionProcedure
    .input(z.object({ classId: z.number().optional() }).optional())
    .query(async ({ ctx, input }): Promise<StartListEntry[]> => {
      const client = ctx.db;

      const where: Record<string, unknown> = { Removed: false };
      if (input?.classId) where.Class = input.classId;

      const runners = await client.oRunner.findMany({
        where,
        orderBy: [{ StartTime: "asc" }, { StartNo: "asc" }],
      });

      const clubs = await client.oClub.findMany({
        where: { Removed: false },
        select: { Id: true, Name: true },
      });
      const clubMap = new Map(clubs.map((c) => [c.Id, c.Name]));

      const classes = await client.oClass.findMany({
        where: { Removed: false },
        select: { Id: true, Name: true, SortIndex: true },
      });
      const classMap = new Map(classes.map((c) => [c.Id, c]));

      const zeroTime = await getZeroTime(client);
      const now = new Date();
      const meosNow = (now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds()) * 10;

      // Get punches to detect "In Forest"
      const punchCounts = await client.oPunch.groupBy({
        by: ["CardNo"],
        _count: { Id: true },
        where: { Removed: false },
      });
      const punchMap = new Map<number, number>(
        punchCounts.map((p) => [p.CardNo, p._count.Id]),
      );

      const entries: StartListEntry[] = runners.map((r) => ({
        id: r.Id,
        startNo: r.StartNo,
        name: r.Name,
        clubId: r.Club,
        clubName: clubMap.get(r.Club) ?? "",
        className: classMap.get(r.Class)?.Name ?? "",
        classId: r.Class,
        startTime: toAbsolute(r.StartTime, zeroTime),
        cardNo: r.CardNo,
        bib: r.Bib,
        hasPunches: (punchMap.get(r.CardNo) ?? 0) > 0,
        hasStarted: r.StartTime > 0 && (r.StartTime <= 1 || meosNow >= toAbsolute(r.StartTime, zeroTime)),
      }));

      // Sort by class sort index, then start time
      entries.sort((a, b) => {
        const classA = classMap.get(a.classId);
        const classB = classMap.get(b.classId);
        const sortA = classA?.SortIndex ?? 0;
        const sortB = classB?.SortIndex ?? 0;
        if (sortA !== sortB) return sortA - sortB;
        return a.startTime - b.startTime;
      });

      return entries;
    }),

  /**
   * Get result list with place calculation, optionally filtered by class.
   * Results are computed per class: OK runners sorted by time, then non-OK runners.
   */
  resultList: competitionProcedure
    .input(z.object({ classId: z.number().optional() }).optional())
    .query(async ({ ctx, input }): Promise<ResultEntry[]> => {
      const client = ctx.db;

      const where: Record<string, unknown> = { Removed: false };
      if (input?.classId) where.Class = input.classId;

      const runners = await client.oRunner.findMany({ where });

      const clubs = await client.oClub.findMany({
        where: { Removed: false },
        select: { Id: true, Name: true },
      });
      const clubMap = new Map(clubs.map((c) => [c.Id, c.Name]));

      const classes = await client.oClass.findMany({
        where: { Removed: false },
        select: { Id: true, Name: true, SortIndex: true, NoTiming: true },
      });
      const classMap = new Map(classes.map((c) => [c.Id, c]));

      const zeroTime = await getZeroTime(client);
      const now = new Date();
      const meosNow = (now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds()) * 10;

      const punchCounts = await client.oPunch.groupBy({
        by: ["CardNo"],
        _count: { Id: true },
        where: { Removed: false },
      });
      const punchMap = new Map<number, number>(
        punchCounts.map((p) => [p.CardNo, p._count.Id]),
      );

      // ── Running-time adjustment (NoTiming / BadNoTiming legs) ──
      // Resolve each course's status-aware ExpectedPosition[] once and
      // reuse the matcher per runner so adjusted running time is the
      // canonical value used for placements + results display.
      const courseIdsForAdjust = new Set<number>();
      const classCourseMap = new Map<number, number>();
      for (const cls of await client.oClass.findMany({
        where: { Removed: false },
        select: { Id: true, Course: true },
      })) {
        classCourseMap.set(cls.Id, cls.Course);
      }
      for (const r of runners) {
        const cid = r.Course > 0 ? r.Course : (classCourseMap.get(r.Class) ?? 0);
        if (cid > 0) courseIdsForAdjust.add(cid);
      }
      const expectedPositionsByCourse = new Map<number, ExpectedPosition[]>();
      if (courseIdsForAdjust.size > 0) {
        const courseRows = await client.oCourse.findMany({
          where: { Id: { in: [...courseIdsForAdjust] }, Removed: false },
          select: { Id: true, Controls: true },
        });
        for (const c of courseRows) {
          expectedPositionsByCourse.set(
            c.Id,
            await resolveCourseExpectedPositions(client, c.Controls),
          );
        }
      }
      const cardRows = await client.oCard.findMany({
        where: { Removed: false, CardNo: { in: runners.map((r) => r.CardNo).filter((n) => n > 0) } },
        select: { CardNo: true, Punches: true },
      });
      const cardPunchesByCardNo = new Map<number, ReturnType<typeof parsePunches>>();
      for (const c of cardRows) {
        cardPunchesByCardNo.set(c.CardNo, parsePunches(c.Punches));
      }
      const adjustmentByRunner = new Map<number, number>();
      for (const r of runners) {
        const cid = r.Course > 0 ? r.Course : (classCourseMap.get(r.Class) ?? 0);
        const positions = expectedPositionsByCourse.get(cid);
        const punches = cardPunchesByCardNo.get(r.CardNo);
        if (!positions || positions.length === 0 || !punches) continue;
        const absPunches = punches.map((p) => ({
          ...p,
          time: p.time !== 0 ? toAbsolute(p.time, zeroTime) : 0,
        }));
        const fallbackStart = toAbsolute(r.StartTime, zeroTime);
        const { runningTimeAdjustment } = matchPunchesToCourse(absPunches, positions, fallbackStart);
        if (runningTimeAdjustment > 0) adjustmentByRunner.set(r.Id, runningTimeAdjustment);
      }

      // Group runners by class
      const byClass = new Map<number, typeof runners>();
      for (const r of runners) {
        const list = byClass.get(r.Class) ?? [];
        list.push(r);
        byClass.set(r.Class, list);
      }

      const allResults: ResultEntry[] = [];

      const classIds = [...byClass.keys()].sort((a, b) => {
        return (classMap.get(a)?.SortIndex ?? 0) - (classMap.get(b)?.SortIndex ?? 0);
      });

      for (const classId of classIds) {
        const classRunners = byClass.get(classId) ?? [];
        const cls = classMap.get(classId);
        const noTiming = cls?.NoTiming === 1;

        const placements = computeClassPlacements(
          classRunners.map((r) => ({
            id: r.Id,
            status: r.Status,
            startTime: r.StartTime,
            finishTime: r.FinishTime,
            runningTimeAdjustment: adjustmentByRunner.get(r.Id) ?? 0,
          })),
          noTiming,
        );

        // Sort: OK runners by running time first, then non-OK by status priority
        const statusOrder = (s: number) => {
          if (s === RunnerStatus.Unknown) return 99;
          if (s === RunnerStatus.DNS) return 90;
          return s;
        };

        const sorted = [...classRunners].sort((a, b) => {
          const pa = placements.get(a.Id)!;
          const pb = placements.get(b.Id)!;
          // Runners with a place come first, sorted by place
          if (pa.place > 0 && pb.place > 0) return pa.place - pb.place || pa.runningTime - pb.runningTime;
          if (pa.place > 0) return -1;
          if (pb.place > 0) return 1;
          // OK runners without place (noTiming) sorted by running time
          if (a.Status === RunnerStatus.OK && b.Status === RunnerStatus.OK)
            return pa.runningTime - pb.runningTime;
          if (a.Status === RunnerStatus.OK) return -1;
          if (b.Status === RunnerStatus.OK) return 1;
          return statusOrder(a.Status) - statusOrder(b.Status);
        });

        for (const r of sorted) {
          const p = placements.get(r.Id)!;
          const hasResult = r.Status !== RunnerStatus.Unknown;
          allResults.push({
            id: r.Id,
            place: p.place,
            name: r.Name,
            clubId: r.Club,
            clubName: clubMap.get(r.Club) ?? "",
            className: cls?.Name ?? "",
            classId: r.Class,
            startTime: toAbsolute(r.StartTime, zeroTime),
            finishTime: toAbsolute(r.FinishTime, zeroTime),
            runningTime: p.runningTime,
            timeBehind: p.timeBehind,
            status: r.Status as ResultEntry["status"],
            startNo: r.StartNo,
            hasPunches: hasResult || (punchMap.get(r.CardNo) ?? 0) > 0,
            hasStarted: r.StartTime > 0 && (r.StartTime <= 1 || meosNow >= toAbsolute(r.StartTime, zeroTime)),
            ...(noTiming ? { noTiming: true } : {}),
          });
        }
      }

      return allResults;
    }),

  /**
   * Get all classes with course details and runner counts.
   */
  classes: competitionProcedure.query(async ({ ctx }): Promise<ClassDetail[]> => {
    const client = ctx.db;
    const zeroTime = await getZeroTime(client);

    const classes = await client.oClass.findMany({
      where: { Removed: false },
      orderBy: { SortIndex: "asc" },
    });

    const courses = await client.oCourse.findMany({
      where: { Removed: false },
    });
    const courseMap = new Map(courses.map((c) => [c.Id, c]));

    // Count runners per class
    const runners = await client.oRunner.findMany({
      where: { Removed: false },
      select: { Class: true },
    });
    const runnerCountByClass = new Map<number, number>();
    for (const r of runners) {
      runnerCountByClass.set(
        r.Class,
        (runnerCountByClass.get(r.Class) ?? 0) + 1,
      );
    }

    return classes.map((c) => {
      const course = courseMap.get(c.Course);
      const controlCount = course
        ? course.Controls.split(";").filter(Boolean).length
        : 0;
      return {
        id: c.Id,
        name: c.Name,
        courseId: c.Course,
        courseName: course?.Name ?? "",
        courseLength: course?.Length ?? 0,
        controlCount,
        runnerCount: runnerCountByClass.get(c.Id) ?? 0,
        firstStart: toAbsolute(c.FirstStart, zeroTime),
        startInterval: c.StartInterval,
        sortIndex: c.SortIndex,
      };
    });
  }),
});
