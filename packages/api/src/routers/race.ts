import { z } from "zod";
import { router, publicProcedure } from "../trpc.js";
import { getCompetitionClient } from "../db.js";
import { RunnerStatus } from "@oxygen/shared";

export const raceRouter = router({
  /**
   * Look up a runner by SI card number. Used at start/finish stations.
   * Returns the runner and their class info if found.
   */
  lookupByCard: publicProcedure
    .input(z.object({ cardNo: z.number().int().positive() }))
    .query(async ({ input }) => {
      const client = await getCompetitionClient();

      const runner = await client.oRunner.findFirst({
        where: { CardNo: input.cardNo, Removed: false },
      });

      if (!runner) {
        return { found: false as const, cardNo: input.cardNo };
      }

      const club = runner.Club
        ? await client.oClub.findUnique({
            where: { Id: runner.Club },
            select: { Name: true },
          })
        : null;
      const cls = runner.Class
        ? await client.oClass.findUnique({
            where: { Id: runner.Class },
            select: { Name: true, Course: true },
          })
        : null;

      // Get course info (from runner's direct course assignment or class course)
      const courseId = runner.Course || cls?.Course || 0;
      const course = courseId
        ? await client.oCourse.findUnique({ where: { Id: courseId } })
        : null;

      const courseControls = course
        ? course.Controls.split(";").filter(Boolean).length
        : 0;

      return {
        found: true as const,
        cardNo: input.cardNo,
        runner: {
          id: runner.Id,
          name: runner.Name,
          cardNo: runner.CardNo,
          clubName: club?.Name ?? "",
          className: cls?.Name ?? "",
          classId: runner.Class,
          startNo: runner.StartNo,
          startTime: runner.StartTime,
          finishTime: runner.FinishTime,
          status: runner.Status,
        },
        course: course
          ? {
              name: course.Name,
              length: course.Length,
              controlCount: courseControls,
            }
          : null,
      };
    }),

  /**
   * Register a start for a runner.
   * Sets the start time (in MeOS deciseconds).
   */
  registerStart: publicProcedure
    .input(
      z.object({
        runnerId: z.number().int(),
        startTime: z.number().int(), // deciseconds since midnight
      }),
    )
    .mutation(async ({ input }) => {
      const client = await getCompetitionClient();

      const runner = await client.oRunner.update({
        where: { Id: input.runnerId },
        data: { StartTime: input.startTime },
      });

      return {
        id: runner.Id,
        name: runner.Name,
        startTime: runner.StartTime,
      };
    }),

  /**
   * Record a finish for a runner.
   * Sets finish time and evaluates result status.
   * A simple status assignment: if finishTime > 0 and startTime > 0, status = OK.
   * (Full punch validation with course matching is Phase 4.)
   */
  recordFinish: publicProcedure
    .input(
      z.object({
        runnerId: z.number().int(),
        finishTime: z.number().int(), // deciseconds since midnight
      }),
    )
    .mutation(async ({ input }) => {
      const client = await getCompetitionClient();

      const runner = await client.oRunner.findUnique({
        where: { Id: input.runnerId },
      });
      if (!runner) throw new Error("Runner not found");

      // Basic status: if they have a start time and now a finish time, mark OK
      // Full card evaluation (punch matching) comes in Phase 4
      const newStatus =
        runner.StartTime > 0 && input.finishTime > 0
          ? RunnerStatus.OK
          : runner.Status;

      const updated = await client.oRunner.update({
        where: { Id: input.runnerId },
        data: {
          FinishTime: input.finishTime,
          Status: newStatus,
        },
      });

      return {
        id: updated.Id,
        name: updated.Name,
        finishTime: updated.FinishTime,
        status: updated.Status,
        runningTime:
          updated.FinishTime > 0 && updated.StartTime > 0
            ? updated.FinishTime - updated.StartTime
            : 0,
      };
    }),

  /**
   * Record a manual punch (free punch).
   * Used for radio controls or manual punch entry at a station.
   */
  recordPunch: publicProcedure
    .input(
      z.object({
        cardNo: z.number().int(),
        time: z.number().int(), // deciseconds
        controlType: z.number().int(), // control code
      }),
    )
    .mutation(async ({ input }) => {
      const client = await getCompetitionClient();

      const punch = await client.oPunch.create({
        data: {
          CardNo: input.cardNo,
          Time: input.time,
          Type: input.controlType,
        },
      });

      return { id: punch.Id };
    }),

  /**
   * Get current server time as MeOS deciseconds since midnight.
   * Used to sync station clocks.
   */
  serverTime: publicProcedure.query(() => {
    const now = new Date();
    const secondsSinceMidnight =
      now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds();
    return {
      deciseconds: secondsSinceMidnight * 10,
      iso: now.toISOString(),
    };
  }),

  /**
   * Get recent race activity (last N finish/start events).
   * Used for the activity feed on station screens.
   */
  recentActivity: publicProcedure
    .input(z.object({ limit: z.number().int().min(1).max(50).default(20) }).optional())
    .query(async ({ input }) => {
      const client = await getCompetitionClient();
      const limit = input?.limit ?? 20;

      // Get runners ordered by most recently modified
      const runners = await client.oRunner.findMany({
        where: {
          Removed: false,
          Status: { gt: 0 }, // Has some result
        },
        orderBy: { Modified: "desc" },
        take: limit,
      });

      const clubs = await client.oClub.findMany({
        where: { Removed: false },
        select: { Id: true, Name: true },
      });
      const clubMap = new Map(clubs.map((c) => [c.Id, c.Name]));

      const classes = await client.oClass.findMany({
        where: { Removed: false },
        select: { Id: true, Name: true },
      });
      const classMap = new Map(classes.map((c) => [c.Id, c.Name]));

      return runners.map((r) => ({
        id: r.Id,
        name: r.Name,
        clubName: clubMap.get(r.Club) ?? "",
        className: classMap.get(r.Class) ?? "",
        startTime: r.StartTime,
        finishTime: r.FinishTime,
        status: r.Status,
        runningTime:
          r.FinishTime > 0 && r.StartTime > 0
            ? r.FinishTime - r.StartTime
            : 0,
      }));
    }),
});
