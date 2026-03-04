import { z } from "zod";
import { router, publicProcedure } from "../trpc.js";
import {
  getMainDbConnection,
  getCompetitionClient,
  getCurrentDbName,
  createCompetitionDatabase,
  getRemoteConnection,
  getSetting,
} from "../db.js";
import type {
  CompetitionInfo,
  CompetitionDashboard,
  ClassInfo,
  CourseInfo,
  RunnerInfo,
  ClubInfo,
  StatusCounts,
} from "@oxygen/shared";
import { type RowDataPacket } from "mysql2/promise";

export const competitionRouter = router({
  /**
   * List all competitions from the MeOSMain database.
   */
  list: publicProcedure.query(async (): Promise<CompetitionInfo[]> => {
    const conn = await getMainDbConnection();
    try {
      const [rows] = await conn.execute<RowDataPacket[]>(
        "SELECT Id, Name, Annotation, Date, NameId FROM oEvent WHERE Removed = 0 ORDER BY Date DESC",
      );
      const competitions: CompetitionInfo[] = [];
      for (const row of rows) {
        const nameId = row.NameId as string;
        const remote = await getRemoteConnection(nameId);
        const eventorEnv = (await getSetting(`eventor_env_${nameId}`)) as
          | "prod"
          | "test"
          | null;
        competitions.push({
          id: row.Id as number,
          name: row.Name as string,
          annotation: (row.Annotation as string) ?? "",
          date: row.Date as string,
          nameId,
          remoteHost: remote
            ? `${remote.host}:${remote.port}`
            : undefined,
          eventorEnv: eventorEnv ?? undefined,
        });
      }
      return competitions;
    } finally {
      await conn.end();
    }
  }),

  /**
   * Select a competition by its database name (NameId).
   * This switches the Prisma client to the correct database.
   */
  select: publicProcedure
    .input(z.object({ nameId: z.string().min(1) }))
    .mutation(async ({ input }) => {
      const client = await getCompetitionClient(input.nameId);
      // Verify the database is accessible by reading the event
      const event = await client.oEvent.findFirst({
        where: { Removed: false },
      });
      if (!event) {
        throw new Error(
          `No event found in database "${input.nameId}"`,
        );
      }
      return {
        success: true,
        nameId: input.nameId,
        name: event.Name,
      };
    }),

  /**
   * Create a new empty competition database.
   * Optionally connects to a separate MySQL server via dbConnection.
   */
  create: publicProcedure
    .input(
      z.object({
        name: z.string().min(1),
        date: z.string().min(1),
        dbName: z.string().optional(),
        dbConnection: z
          .object({
            host: z.string().min(1),
            port: z.number().int().positive().default(3306),
            user: z.string().optional(),
            password: z.string().optional(),
          })
          .optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const { dbName, eventId } = await createCompetitionDatabase(
        input.name,
        input.date,
        input.dbName,
        input.dbConnection,
      );
      return { nameId: dbName, eventId };
    }),

  /**
   * Delete a competition: DROP DATABASE and remove from MeOSMain.
   */
  delete: publicProcedure
    .input(z.object({ nameId: z.string().min(1) }))
    .mutation(async ({ input }) => {
      const conn = await getMainDbConnection();
      try {
        // Verify it exists
        const [rows] = await conn.execute<RowDataPacket[]>(
          "SELECT Id, Name FROM oEvent WHERE NameId = ? AND Removed = 0",
          [input.nameId],
        );
        if (!Array.isArray(rows) || rows.length === 0) {
          throw new Error(`Competition "${input.nameId}" not found`);
        }

        // Mark as removed in MeOSMain
        await conn.execute(
          "UPDATE oEvent SET Removed = 1 WHERE NameId = ?",
          [input.nameId],
        );

        // Drop the database
        await conn.execute(`DROP DATABASE IF EXISTS \`${input.nameId}\``);

        return { success: true, name: rows[0].Name as string };
      } finally {
        await conn.end();
      }
    }),

  /**
   * Purge soft-deleted competition records and orphaned entries from MeOSMain.
   * - Entries with Removed=1: drops their database (if it exists) and deletes the record.
   * - Entries with Removed=0 but whose database no longer exists: marks as Removed=1 and deletes.
   */
  purgeDeleted: publicProcedure.mutation(async () => {
    const conn = await getMainDbConnection();
    try {
      // Get all existing databases for cross-referencing
      const [dbRows] = await conn.execute<RowDataPacket[]>("SHOW DATABASES");
      const existingDbs = new Set(
        (dbRows as RowDataPacket[]).map((r) => r.Database as string),
      );

      // Find all soft-deleted entries
      const [deletedRows] = await conn.execute<RowDataPacket[]>(
        "SELECT Id, NameId FROM oEvent WHERE Removed = 1",
      );

      let droppedDatabases = 0;

      // Drop any databases that still exist for soft-deleted entries
      if (Array.isArray(deletedRows)) {
        for (const row of deletedRows as RowDataPacket[]) {
          const nameId = row.NameId as string;
          if (nameId && existingDbs.has(nameId)) {
            await conn.execute(`DROP DATABASE IF EXISTS \`${nameId}\``);
            droppedDatabases++;
          }
        }
      }

      // Hard-delete all soft-deleted records
      await conn.execute("DELETE FROM oEvent WHERE Removed = 1");

      // Find orphaned entries: Removed=0 but database doesn't exist
      const [activeRows] = await conn.execute<RowDataPacket[]>(
        "SELECT Id, NameId FROM oEvent WHERE Removed = 0",
      );

      let orphanedPurged = 0;
      if (Array.isArray(activeRows)) {
        for (const row of activeRows as RowDataPacket[]) {
          const nameId = row.NameId as string;
          if (nameId && !existingDbs.has(nameId)) {
            await conn.execute("DELETE FROM oEvent WHERE Id = ?", [row.Id]);
            orphanedPurged++;
          }
        }
      }

      const purged = (Array.isArray(deletedRows) ? deletedRows.length : 0) + orphanedPurged;
      return { purged, droppedDatabases, orphanedPurged };
    } finally {
      await conn.end();
    }
  }),

  /**
   * Get the currently selected competition database name.
   */
  current: publicProcedure.query((): { nameId: string | null } => {
    return { nameId: getCurrentDbName() };
  }),

  /**
   * Get the full dashboard overview for the currently selected competition.
   */
  dashboard: publicProcedure.query(
    async (): Promise<CompetitionDashboard> => {
      const client = await getCompetitionClient();

      const event = await client.oEvent.findFirst({
        where: { Removed: false },
      });
      if (!event) {
        throw new Error("No competition selected or event not found");
      }

      // Fetch classes with runner counts
      const classes = await client.oClass.findMany({
        where: { Removed: false },
        orderBy: { SortIndex: "asc" },
      });

      const courses = await client.oCourse.findMany({
        where: { Removed: false },
      });

      const totalControls = await client.oControl.count({
        where: { Removed: false },
      });

      // Count runners per class
      const runners = await client.oRunner.findMany({
        where: { Removed: false },
        select: { Class: true, Club: true, Status: true, StartTime: true, FinishTime: true, CardNo: true },
      });

      // Count distinct clubs that have at least one runner
      const clubsWithRunners = new Set(runners.map((r) => r.Club).filter((c) => c > 0));
      const clubCount = clubsWithRunners.size;

      // Build runner counts per class + status summary
      const runnerCountByClass = new Map<number, number>();

      const now = new Date();
      const meosNow = (now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds()) * 10;
      const zeroTime = event.ZeroTime;

      // Grouped punch counts by CardNo (to detect 'In Forest' runners with punches)
      const punchCounts = await client.oPunch.groupBy({
        by: ["CardNo"],
        _count: { Id: true },
        where: { Removed: false },
      });
      const punchMap = new Map<number, number>(
        punchCounts.map((p) => [p.CardNo, p._count.Id]),
      );

      const statusCounts: StatusCounts = { notStarted: 0, inForest: 0, finished: 0, startListCount: 0, resultCount: 0 };
      for (const r of runners) {
        runnerCountByClass.set(
          r.Class,
          (runnerCountByClass.get(r.Class) ?? 0) + 1,
        );

        const hasPunches = (punchMap.get(r.CardNo) ?? 0) > 0;
        const hasStartedByTime = r.StartTime > 0 && meosNow >= r.StartTime;
        const hasFinishTime = r.FinishTime > 0;
        const hasResult = r.Status > 0;

        if (hasResult || hasFinishTime) {
          statusCounts.finished++;
          statusCounts.resultCount++;
        } else if (hasPunches || hasStartedByTime) {
          statusCounts.inForest++;
        } else {
          statusCounts.notStarted++;
          statusCounts.startListCount++;
        }
      }

      const classInfos: ClassInfo[] = classes.map((c) => ({
        id: c.Id,
        name: c.Name,
        courseId: c.Course,
        sortIndex: c.SortIndex,
        runnerCount: runnerCountByClass.get(c.Id) ?? 0,
      }));

      const courseInfos: CourseInfo[] = courses.map((c) => {
        const controlList = c.Controls.split(";").filter(Boolean);
        return {
          id: c.Id,
          name: c.Name,
          length: c.Length,
          controls: c.Controls,
          controlCount: controlList.length,
        };
      });

      // Resolve organizer info for logo display.
      // Organizer field is stored as plain text "Name" (MeOS format).
      // Legacy: may contain "Name\tEventorId" (old OOS format) or just a numeric ID.
      let organizer: { name: string; eventorId: number } | undefined;
      if (event.Organizer) {
        const parts = event.Organizer.split("\t");
        let orgName = parts[0].trim();
        let eventorId = parts[1] ? parseInt(parts[1], 10) : 0;

        // Legacy fix: if orgName is purely numeric, it's an Eventor ID not a name
        if (/^\d+$/.test(orgName)) {
          eventorId = eventorId || parseInt(orgName, 10);
          orgName = ""; // Will be resolved from club data below
        }

        // Resolve name and ID from clubs
        const allClubs = await client.oClub.findMany({
          where: { Removed: false },
          select: { Name: true, ExtId: true },
        });

        // If we have an eventorId but no name, look up the club by ExtId
        if (!orgName && eventorId) {
          const club = allClubs.find((c) => Number(c.ExtId) === eventorId);
          if (club) orgName = club.Name;
        }

        // If no embedded ID, try to match by club name (case-insensitive)
        if ((!eventorId || isNaN(eventorId)) && orgName) {
          const lower = orgName.toLowerCase();
          const orgClub =
            allClubs.find((c) => c.Name.trim().toLowerCase() === lower) ??
            allClubs.find((c) => c.Name.trim().toLowerCase().includes(lower)) ??
            allClubs.find((c) => lower.includes(c.Name.trim().toLowerCase()));
          eventorId = orgClub ? Number(orgClub.ExtId) : 0;
        }

        // Only include organizer if we resolved a name
        if (orgName) {
          organizer = {
            name: orgName,
            eventorId: eventorId && !isNaN(eventorId) ? eventorId : 0,
          };
        }
      }

      return {
        competition: {
          id: event.Id,
          name: event.Name,
          annotation: event.Annotation,
          date: event.Date,
          nameId: event.NameId,
        },
        classes: classInfos,
        courses: courseInfos,
        totalRunners: runners.length,
        totalClubs: clubCount,
        totalCourses: courseInfos.length,
        totalControls,
        statusCounts,
        organizer,
      };
    },
  ),

  /**
   * Get runners, optionally filtered by class.
   */
  runners: publicProcedure
    .input(
      z
        .object({
          classId: z.number().optional(),
          search: z.string().optional(),
        })
        .optional(),
    )
    .query(async ({ input }): Promise<RunnerInfo[]> => {
      const client = await getCompetitionClient();

      // Build where clause
      const where: Record<string, unknown> = { Removed: false };
      if (input?.classId) {
        where.Class = input.classId;
      }
      if (input?.search) {
        where.Name = { contains: input.search };
      }

      const runners = await client.oRunner.findMany({
        where,
        orderBy: [{ Class: "asc" }, { StartNo: "asc" }],
      });

      // Fetch clubs for name lookup
      const clubs = await client.oClub.findMany({
        where: { Removed: false },
        select: { Id: true, Name: true },
      });
      const clubMap = new Map(clubs.map((c) => [c.Id, c.Name]));

      // Fetch classes for name lookup
      const classes = await client.oClass.findMany({
        where: { Removed: false },
        select: { Id: true, Name: true },
      });
      const classMap = new Map(classes.map((c) => [c.Id, c.Name]));

      return runners.map(
        (r): RunnerInfo => ({
          id: r.Id,
          name: r.Name,
          cardNo: r.CardNo,
          clubId: r.Club,
          clubName: clubMap.get(r.Club) ?? "",
          classId: r.Class,
          className: classMap.get(r.Class) ?? "",
          startNo: r.StartNo,
          startTime: r.StartTime,
          finishTime: r.FinishTime,
          status: r.Status as RunnerInfo["status"],
        }),
      );
    }),

  /**
   * Get clubs for the current competition (only those with at least one runner).
   */
  clubs: publicProcedure.query(async (): Promise<ClubInfo[]> => {
    const client = await getCompetitionClient();

    // Find distinct club IDs that have runners
    const runners = await client.oRunner.findMany({
      where: { Removed: false },
      select: { Club: true },
    });
    const clubIdsWithRunners = new Set(
      runners.map((r) => r.Club).filter((c) => c > 0),
    );

    const clubs = await client.oClub.findMany({
      where: { Removed: false, Id: { in: [...clubIdsWithRunners] } },
      orderBy: { Name: "asc" },
    });
    return clubs.map((c) => ({
      id: c.Id,
      name: c.Name,
      eventorId: Number(c.ExtId) || undefined,
    }));
  }),

  /**
   * Get the current oCounter state for external change detection.
   * Returns counter values for each MeOS table so the frontend can
   * detect when another client (e.g. MeOS) has modified data.
   *
   * Uses raw SQL because MeOS's oCounter table may have NULL in the
   * Modified column, which Prisma's typed client rejects.
   * Returns zeros if no competition is selected (e.g. after API restart).
   */
  counterState: publicProcedure.query(async () => {
    const zeros = {
      oControl: 0, oCourse: 0, oClass: 0, oCard: 0, oClub: 0,
      oPunch: 0, oRunner: 0, oTeam: 0, oEvent: 0,
    };

    const dbName = getCurrentDbName();
    if (!dbName) return zeros;

    try {
      const client = await getCompetitionClient();
      const rows = await client.$queryRawUnsafe<Record<string, number | null>[]>(
        "SELECT oControl, oCourse, oClass, oCard, oClub, oPunch, oRunner, oTeam, oEvent FROM oCounter LIMIT 1",
      );
      const row = rows[0];
      if (!row) return zeros;
      return {
        oControl: Number(row.oControl) || 0,
        oCourse: Number(row.oCourse) || 0,
        oClass: Number(row.oClass) || 0,
        oCard: Number(row.oCard) || 0,
        oClub: Number(row.oClub) || 0,
        oPunch: Number(row.oPunch) || 0,
        oRunner: Number(row.oRunner) || 0,
        oTeam: Number(row.oTeam) || 0,
        oEvent: Number(row.oEvent) || 0,
      };
    } catch {
      return zeros;
    }
  }),

  /**
   * MySQL server status metrics for the DB load indicator.
   * Returns cumulative counters (frontend computes rates by diffing).
   */
  dbStatus: publicProcedure.query(async () => {
    const statusVars = [
      "Questions", "Com_select", "Com_insert", "Com_update", "Com_delete",
      "Threads_connected", "Threads_running", "Slow_queries",
      "Bytes_received", "Bytes_sent", "Uptime",
      "Table_locks_waited", "Table_locks_immediate",
    ];

    try {
      const conn = await getMainDbConnection();
      try {
        const [rows] = await conn.execute<RowDataPacket[]>(
          `SHOW GLOBAL STATUS WHERE Variable_name IN (${statusVars.map(() => "?").join(",")})`,
          statusVars,
        );
        const result: Record<string, number> = {};
        for (const row of rows) {
          result[row.Variable_name] = Number(row.Value) || 0;
        }
        return result;
      } finally {
        await conn.end();
      }
    } catch {
      return null;
    }
  }),
});
