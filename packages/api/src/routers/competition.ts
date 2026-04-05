import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router, publicProcedure, competitionProcedure } from "../trpc.js";
import {
  getMainDbConnection,
  getCompetitionClient,
  createCompetitionDatabase,
  getRemoteConnection,
  getSetting,
  ensureCompetitionConfigTable,
  incrementCounter,
  getZeroTime,
} from "../db.js";
import { toAbsolute } from "../timeConvert.js";
import { clearSheetsCache, testGoogleSheetPush } from "../sheetsBackup.js";
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
  select: competitionProcedure
    .input(z.object({ nameId: z.string().min(1) }))
    .mutation(async ({ input }) => {
      const client = await getCompetitionClient(input.nameId);
      // Run all Oxygen-specific migrations eagerly so every route can rely on
      // these columns being present without needing to call ensureCompetitionConfigTable.
      await ensureCompetitionConfigTable(client, input.nameId);
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
          throw new TRPCError({ code: "NOT_FOUND", message: `Competition "${input.nameId}" not found` });
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
  current: competitionProcedure.query(({ ctx }): { nameId: string } => {
    return { nameId: ctx.dbName };
  }),

  /**
   * Get the full dashboard overview for the currently selected competition.
   */
  dashboard: competitionProcedure.query(
    async ({ ctx }): Promise<CompetitionDashboard> => {
      const client = ctx.db;
      await ensureCompetitionConfigTable(client, ctx.dbName);

      const event = await client.oEvent.findFirst({
        where: { Removed: false },
      });
      if (!event) {
        throw new TRPCError({ code: "NOT_FOUND", message: "No competition selected or event not found" });
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
      const zeroTime = await getZeroTime(client);

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
        // StartTime=1 is a MeOS sentinel for "drawn but no specific time" (interval=0)
        const hasStartedByTime = r.StartTime > 0 && (r.StartTime <= 1 || meosNow >= toAbsolute(r.StartTime, zeroTime));
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
        classFee: c.ClassFee || undefined,
        allowQuickEntry: c.AllowQuickEntry === 1 || undefined,
      }));

      const courseInfos: CourseInfo[] = courses.map((c) => {
        const controlList = c.Controls.split(";").filter(Boolean);
        return {
          id: c.Id,
          name: c.Name,
          length: c.Length,
          controls: c.Controls,
          controlCount: controlList.length,
          numberOfMaps: c.NumberMaps > 0 ? c.NumberMaps : undefined,
        };
      });

      // Resolve organizer info for logo display.
      // Organizer field is stored as plain text "Name" (MeOS format).
      // Legacy: may contain "Name\tEventorId" (old format) or just a numeric ID.
      let organizer: { name: string; eventorId: number } | undefined;

      // All clubs needed for name/ID resolution
      const allClubs = await client.oClub.findMany({
        where: { Removed: false },
        select: { Name: true, ExtId: true },
      });

      if (event.Organizer) {
        const parts = event.Organizer.split("\t");
        let orgName = parts[0].trim();
        let eventorId = parts[1] ? parseInt(parts[1], 10) : 0;

        // Legacy fix: if orgName is purely numeric, it's an Eventor ID not a name
        if (/^\d+$/.test(orgName)) {
          eventorId = eventorId || parseInt(orgName, 10);
          orgName = ""; // Will be resolved from club data below
        }

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

      // Fallback: use organizer_eventor_id from competition config
      if (!organizer?.eventorId) {
        await ensureCompetitionConfigTable(client, ctx.dbName);
        const configRows = (await client.$queryRawUnsafe(
          "SELECT organizer_eventor_id FROM oxygen_competition_config WHERE id = 1",
        )) as Array<{ organizer_eventor_id: number }>;
        const configEventorId = configRows[0]?.organizer_eventor_id ?? 0;
        if (configEventorId > 0) {
          const orgClub = allClubs.find((c) => Number(c.ExtId) === configEventorId);
          organizer = {
            name: organizer?.name || orgClub?.Name || "",
            eventorId: configEventorId,
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
          eventorEventId: Number(event.ExtId) || undefined,
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
  runners: competitionProcedure
    .input(
      z
        .object({
          classId: z.number().optional(),
          search: z.string().optional(),
        })
        .optional(),
    )
    .query(async ({ ctx, input }): Promise<RunnerInfo[]> => {
      const client = ctx.db;
      const zeroTime = await getZeroTime(client);

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
          startTime: toAbsolute(r.StartTime, zeroTime),
          finishTime: toAbsolute(r.FinishTime, zeroTime),
          status: r.Status as RunnerInfo["status"],
        }),
      );
    }),

  /**
   * Get clubs for the current competition (only those with at least one runner).
   */
  clubs: competitionProcedure.query(async ({ ctx }): Promise<ClubInfo[]> => {
    const client = ctx.db;

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
  counterState: competitionProcedure.query(async ({ ctx }) => {
    const zeros = {
      oControl: 0, oCourse: 0, oClass: 0, oCard: 0, oClub: 0,
      oPunch: 0, oRunner: 0, oTeam: 0, oEvent: 0,
    };

    try {
      const client = ctx.db;
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

  /**
   * Get registration settings (payment methods, Swish config, receipt printing).
   */
  getRegistrationConfig: competitionProcedure.query(async ({ ctx }) => {
    const client = ctx.db;
    await ensureCompetitionConfigTable(client, ctx.dbName);

    const rows = (await client.$queryRawUnsafe(
      "SELECT payment_methods, swish_number, swish_payee_name, print_registration_receipt, registration_receipt_message, finish_receipt_message, organizer_eventor_id, org_number, vat_exempt, receipt_friskvard_note, web_url FROM oxygen_competition_config WHERE id = 1",
    )) as Array<{
      payment_methods: string;
      swish_number: string;
      swish_payee_name: string;
      print_registration_receipt: number;
      registration_receipt_message: string;
      finish_receipt_message: string;
      organizer_eventor_id: number;
      org_number: string;
      vat_exempt: number;
      receipt_friskvard_note: number;
      web_url: string;
    }>;

    const row = rows[0];

    // Fetch organizer club details for receipt header
    let organizerDetails: { name: string; street?: string; city?: string; zip?: string; phone?: string; email?: string; webUrl?: string } | undefined;
    let organizerEventorId = row?.organizer_eventor_id ?? 0;
    const webUrl = row?.web_url ?? "";

    // Fallback: resolve organizer from oEvent.Organizer (same logic as dashboard)
    if (organizerEventorId === 0) {
      const events = (await client.$queryRawUnsafe(
        "SELECT Organizer FROM oEvent LIMIT 1",
      )) as Array<{ Organizer: string }>;
      const orgField = events[0]?.Organizer ?? "";
      if (orgField) {
        const parts = orgField.split("\t");
        let orgName = parts[0].trim();
        let evId = parts[1] ? parseInt(parts[1], 10) : 0;
        if (/^\d+$/.test(orgName)) { evId = evId || parseInt(orgName, 10); orgName = ""; }
        if (!evId || isNaN(evId)) {
          const clubs = (await client.$queryRawUnsafe(
            "SELECT ExtId FROM oClub WHERE LOWER(TRIM(Name)) = LOWER(?) AND Removed = 0 LIMIT 1",
            orgName,
          )) as Array<{ ExtId: number }>;
          evId = clubs[0] ? Number(clubs[0].ExtId) : 0;
        }
        if (evId > 0) organizerEventorId = evId;
      }
    }

    if (organizerEventorId > 0) {
      const clubs = (await client.$queryRawUnsafe(
        "SELECT Name, Street, City, ZIP, Phone, EMail FROM oClub WHERE ExtId = ? AND Removed = 0 LIMIT 1",
        organizerEventorId,
      )) as Array<{ Name: string; Street: string; City: string; ZIP: string; Phone: string; EMail: string }>;
      const club = clubs[0];
      if (club) {
        organizerDetails = {
          name: club.Name,
          ...(club.Street ? { street: club.Street } : {}),
          ...(club.City ? { city: club.City } : {}),
          ...(club.ZIP ? { zip: club.ZIP } : {}),
          ...(club.Phone ? { phone: club.Phone } : {}),
          ...(club.EMail ? { email: club.EMail } : {}),
          ...(webUrl ? { webUrl } : {}),
        };
      }
    }

    return {
      paymentMethods: row?.payment_methods?.split(",").filter(Boolean) ?? ["billed"],
      swishNumber: row?.swish_number ?? "",
      swishPayeeName: row?.swish_payee_name ?? "",
      printRegistrationReceipt: (row?.print_registration_receipt ?? 0) === 1,
      registrationReceiptMessage: row?.registration_receipt_message ?? "",
      finishReceiptMessage: row?.finish_receipt_message ?? "",
      organizerEventorId,
      orgNumber: row?.org_number ?? "",
      vatExempt: (row?.vat_exempt ?? 1) === 1,
      receiptFriskvardNote: (row?.receipt_friskvard_note ?? 0) === 1,
      organizerDetails,
    };
  }),

  /**
   * Update registration settings.
   */
  setRegistrationConfig: competitionProcedure
    .input(z.object({
      paymentMethods: z.array(z.string()).optional(),
      swishNumber: z.string().optional(),
      swishPayeeName: z.string().optional(),
      printRegistrationReceipt: z.boolean().optional(),
      registrationReceiptMessage: z.string().optional(),
      finishReceiptMessage: z.string().optional(),
      organizerEventorId: z.number().optional(),
      orgNumber: z.string().optional(),
      vatExempt: z.boolean().optional(),
      receiptFriskvardNote: z.boolean().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const client = ctx.db;
      await ensureCompetitionConfigTable(client, ctx.dbName);

      const setClauses: string[] = [];
      if (input.paymentMethods !== undefined) {
        const val = input.paymentMethods.join(",");
        setClauses.push(`payment_methods = '${val.replace(/'/g, "''")}'`);
      }
      if (input.swishNumber !== undefined) {
        setClauses.push(`swish_number = '${input.swishNumber.replace(/'/g, "''")}'`);
      }
      if (input.swishPayeeName !== undefined) {
        setClauses.push(`swish_payee_name = '${input.swishPayeeName.replace(/'/g, "''")}'`);
      }
      if (input.printRegistrationReceipt !== undefined) {
        setClauses.push(`print_registration_receipt = ${input.printRegistrationReceipt ? 1 : 0}`);
      }
      if (input.registrationReceiptMessage !== undefined) {
        setClauses.push(`registration_receipt_message = '${input.registrationReceiptMessage.replace(/'/g, "''")}'`);
      }
      if (input.finishReceiptMessage !== undefined) {
        setClauses.push(`finish_receipt_message = '${input.finishReceiptMessage.replace(/'/g, "''")}'`);
      }
      if (input.organizerEventorId !== undefined) {
        setClauses.push(`organizer_eventor_id = ${Number(input.organizerEventorId) || 0}`);
      }
      if (input.orgNumber !== undefined) {
        setClauses.push(`org_number = '${input.orgNumber.replace(/'/g, "''")}'`);
      }
      if (input.vatExempt !== undefined) {
        setClauses.push(`vat_exempt = ${input.vatExempt ? 1 : 0}`);
      }
      if (input.receiptFriskvardNote !== undefined) {
        setClauses.push(`receipt_friskvard_note = ${input.receiptFriskvardNote ? 1 : 0}`);
      }
      if (setClauses.length > 0) {
        await client.$executeRawUnsafe(
          `UPDATE oxygen_competition_config SET ${setClauses.join(", ")} WHERE id = 1`,
        );
      }
      return { ok: true };
    }),

  // ── Google Sheets backup config ──────────────────────────

  getGoogleSheetsConfig: competitionProcedure.query(async ({ ctx }) => {
    const client = ctx.db;
    await ensureCompetitionConfigTable(client, ctx.dbName);
    const rows = await client.$queryRawUnsafe<
      Array<{ google_sheets_webhook_url: string }>
    >(
      "SELECT google_sheets_webhook_url FROM oxygen_competition_config WHERE id = 1",
    );
    return { webhookUrl: rows[0]?.google_sheets_webhook_url ?? "" };
  }),

  setGoogleSheetsConfig: competitionProcedure
    .input(z.object({ webhookUrl: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const client = ctx.db;
      await ensureCompetitionConfigTable(client, ctx.dbName);
      await client.$executeRawUnsafe(
        `UPDATE oxygen_competition_config SET google_sheets_webhook_url = ? WHERE id = 1`,
        input.webhookUrl,
      );
      clearSheetsCache();
      return { ok: true };
    }),

  testGoogleSheetsWebhook: publicProcedure
    .input(z.object({ webhookUrl: z.string().url() }))
    .mutation(async ({ input }) => {
      return testGoogleSheetPush(input.webhookUrl);
    }),

  // ── Rental card fee (stored in oEvent.CardFee — MeOS compatible) ──

  getCardFee: competitionProcedure.query(async ({ ctx }) => {
    const client = ctx.db;
    const event = await client.oEvent.findFirst({ where: { Removed: false } });
    return { cardFee: event?.CardFee ?? 0 };
  }),

  setCardFee: competitionProcedure
    .input(z.object({ cardFee: z.number().int().min(0) }))
    .mutation(async ({ ctx, input }) => {
      const client = ctx.db;
      const event = await client.oEvent.findFirst({ where: { Removed: false } });
      if (!event) throw new TRPCError({ code: "NOT_FOUND", message: "No active competition" });
      await client.oEvent.update({
        where: { Id: event.Id },
        data: { CardFee: input.cardFee },
      });
      await incrementCounter("oEvent", event.Id, ctx.dbName);
      return { ok: true };
    }),

  // ── Livelox integration config ───────────────────────────

  getLiveloxEventId: competitionProcedure.query(async ({ ctx }) => {
    const client = ctx.db;
    await ensureCompetitionConfigTable(client, ctx.dbName);
    const rows = await client.$queryRawUnsafe<
      Array<{ livelox_event_id: number | null }>
    >(
      "SELECT livelox_event_id FROM oxygen_competition_config WHERE id = 1",
    );
    return { liveloxEventId: rows[0]?.livelox_event_id ?? null };
  }),

  setLiveloxEventId: competitionProcedure
    .input(z.object({ liveloxEventId: z.number().int().positive().nullable() }))
    .mutation(async ({ ctx, input }) => {
      const client = ctx.db;
      await ensureCompetitionConfigTable(client, ctx.dbName);
      await client.$executeRawUnsafe(
        `UPDATE oxygen_competition_config SET livelox_event_id = ? WHERE id = 1`,
        input.liveloxEventId,
      );
      return { ok: true };
    }),
});
