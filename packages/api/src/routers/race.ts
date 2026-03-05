import { z } from "zod";
import { router, publicProcedure } from "../trpc.js";
import { getCompetitionClient } from "../db.js";
import { RunnerStatus } from "@oxygen/shared";
import { performReadout } from "./cardReadout.js";

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
   * Get all data needed to print a finish receipt for a runner.
   * Returns split times (from card readout), position in class, SIAC battery
   * info, per-leg distances for pace, and top-5 class finishers.
   */
  finishReceipt: publicProcedure
    .input(z.object({ runnerId: z.number().int() }))
    .query(async ({ input }) => {
      const client = await getCompetitionClient();
      const result = await performReadout(client, input.runnerId);
      if (!result) return null;

      // ── Leg lengths for per-leg pace ─────────────────────────
      let legLengths: number[] = [];
      if (result.course) {
        const course = await client.oCourse.findUnique({
          where: { Id: result.course.id },
          select: { Legs: true },
        });
        if (course?.Legs) {
          legLengths = course.Legs
            .split(";")
            .filter(Boolean)
            .map(Number)
            .filter((n) => !isNaN(n));
        }
      }

      // ── Position + top-5 class finishers ─────────────────────
      let position: { rank: number; total: number } | null = null;
      let classResults: Array<{ rank: number; name: string; clubName: string; runningTime: number }> = [];
      const classId = result.runner.classId;
      const thisTime = result.timing.runningTime;
      if (classId && thisTime > 0 && result.timing.status === RunnerStatus.OK) {
        const classRunners = await client.oRunner.findMany({
          where: { Class: classId, Removed: false, Status: RunnerStatus.OK },
          select: { Name: true, Club: true, StartTime: true, FinishTime: true },
        });
        const withTimes = classRunners
          .filter((r) => r.FinishTime > 0 && r.StartTime > 0)
          .map((r) => ({ name: r.Name, clubId: r.Club, runningTime: r.FinishTime - r.StartTime }))
          .sort((a, b) => a.runningTime - b.runningTime);

        const rank = withTimes.filter((r) => r.runningTime < thisTime).length + 1;
        position = { rank, total: withTimes.length };

        // Fetch club names for top 5
        const top5 = withTimes.slice(0, 5);
        const clubIds = [...new Set(top5.map((r) => r.clubId).filter((id): id is number => id != null))];
        const clubs = clubIds.length
          ? await client.oClub.findMany({ where: { Id: { in: clubIds } }, select: { Id: true, Name: true } })
          : [];
        const clubMap = new Map(clubs.map((c) => [c.Id, c.Name]));
        classResults = top5.map((r, i) => ({
          rank: i + 1,
          name: r.name,
          clubName: clubMap.get(r.clubId ?? 0) ?? "",
          runningTime: r.runningTime,
        }));
      }

      // ── SIAC battery info ─────────────────────────────────────
      let siac: { voltage: number | null; batteryDate: string | null; batteryOk: boolean } | null = null;
      if (result.runner.cardNo > 0) {
        try {
          const rows = await client.$queryRawUnsafe<
            Array<{ Voltage: number; Metadata: string | null }>
          >(
            `SELECT Voltage, Metadata FROM oxygen_card_readouts
             WHERE CardNo = ? ORDER BY ReadAt DESC LIMIT 1`,
            result.runner.cardNo,
          );
          if (rows.length > 0) {
            const voltage = rows[0].Voltage > 0 ? rows[0].Voltage / 100 : null;
            const meta = rows[0].Metadata ? (JSON.parse(rows[0].Metadata) as { batteryDate?: string }) : null;
            siac = {
              voltage,
              batteryDate: meta?.batteryDate ?? null,
              batteryOk: voltage != null && voltage >= 2.5,
            };
          }
        } catch {
          // oxygen_card_readouts table may not exist yet
        }
      }

      return {
        ...result,
        controls: result.controls.map((c, i) => ({ ...c, legLength: legLengths[i] ?? 0 })),
        position,
        classResults,
        siac,
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
