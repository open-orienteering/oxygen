import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router, publicProcedure, eventProcedure } from "../trpc.js";
import { prisma, sanitizeNameId, getZeroTime } from "../db.js";
import { toAbsolute } from "../timeConvert.js";
import { resolveCourseExpectedPositions } from "./course.js";
import { isWithdrawn, isFinished, WITHDRAWN_STATUSES } from "@oxygen/shared";
import type {
  EventInfo,
  EventDashboard,
  ClassInfo,
  CourseInfo,
  RunnerInfo,
  ClubInfo,
  StatusCounts,
  RunnerStatusValue,
} from "@oxygen/shared";
import { clearSheetsCache, testGoogleSheetPush } from "../sheetsBackup.js";
import { runnerStatusToValue, valueToRunnerStatus } from "../statusConvert.js";

/**
 * Event router (formerly competition router). All operations on the active
 * orienteering event — listing, registration config, dashboard, etc.
 */
export const eventRouter = router({
  /** List all events from the registry. */
  list: publicProcedure.query(async (): Promise<EventInfo[]> => {
    const rows = await prisma().event.findMany({
      where: { removed: false },
      orderBy: { date: "desc" },
    });
    const eventorIds = [
      ...new Set(
        rows
          .map((row) => row.eventorEventId)
          .filter((id): id is bigint => id != null)
          .map((id) => Number(id)),
      ),
    ];
    const metaByEventorId = new Map<number, number>();
    if (eventorIds.length > 0) {
      const meta = await prisma().eventorEventMeta.findMany({
        where: { eventorEventId: { in: eventorIds } },
        select: { eventorEventId: true, classificationId: true },
      });
      for (const row of meta) {
        if (row.classificationId > 0) {
          metaByEventorId.set(row.eventorEventId, row.classificationId);
        }
      }
    }
    return rows.map((row) => {
      const classificationId = row.eventorEventId
        ? metaByEventorId.get(Number(row.eventorEventId))
        : undefined;
      return toEventInfo(row, classificationId);
    });
  }),

  /**
   * Verify the requested event exists. Returns its identity so the client
   * can confirm before setting `x-event-id` on subsequent requests.
   */
  select: publicProcedure
    .input(z.object({ nameId: z.string().min(1) }))
    .mutation(async ({ input }) => {
      const event = await prisma().event.findUnique({
        where: { nameId: input.nameId },
      });
      if (!event || event.removed) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `No event found with slug "${input.nameId}"`,
        });
      }
      return { success: true, nameId: event.nameId, name: event.name };
    }),

  /** Create a new empty event. */
  create: publicProcedure
    .input(
      z.object({
        name: z.string().min(1),
        date: z.string().min(1),
        nameId: z.string().optional(),
        kind: z.string().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const slug = sanitizeNameId(input.nameId ?? input.name);
      const existing = await prisma().event.findUnique({
        where: { nameId: slug },
      });
      if (existing && !existing.removed) {
        throw new TRPCError({
          code: "CONFLICT",
          message: `An event with slug "${slug}" already exists.`,
        });
      }
      const created = await prisma().event.create({
        data: {
          nameId: slug,
          name: input.name,
          date: new Date(input.date),
          kind: input.kind ?? "competition",
        },
      });
      return { nameId: created.nameId, eventId: Number(created.id) };
    }),

  /** Soft-delete an event. */
  delete: publicProcedure
    .input(z.object({ nameId: z.string().min(1) }))
    .mutation(async ({ input }) => {
      const event = await prisma().event.findUnique({
        where: { nameId: input.nameId },
      });
      if (!event || event.removed) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Event "${input.nameId}" not found`,
        });
      }
      await prisma().event.update({
        where: { id: event.id },
        data: { removed: true },
      });
      return { success: true, name: event.name };
    }),

  /** Hard-delete every soft-deleted event (and its cascading children). */
  purgeDeleted: publicProcedure.mutation(async () => {
    const result = await prisma().event.deleteMany({
      where: { removed: true },
    });
    return { purged: result.count, droppedDatabases: 0, orphanedPurged: 0 };
  }),

  /** Return the currently selected event's slug. */
  current: eventProcedure.query(({ ctx }) => ({ nameId: ctx.event.nameId })),

  /** Full dashboard. */
  dashboard: eventProcedure.query(
    async ({ ctx }): Promise<EventDashboard> => {
      const event = await ctx.db.event.findUnique({
        where: { id: ctx.event.id },
      });
      if (!event) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Event not found" });
      }

      const classes = await ctx.db.class.findMany({
        where: { eventId: ctx.event.id, removed: false },
        orderBy: { sortIndex: "asc" },
      });
      const courses = await ctx.db.course.findMany({
        where: { eventId: ctx.event.id, removed: false },
      });
      const totalControls = await ctx.db.control.count({
        where: { eventId: ctx.event.id, removed: false },
      });
      const mapCount = await ctx.db.mapFile.count({
        where: { eventId: ctx.event.id },
      });

      const runners = await ctx.db.runner.findMany({
        where: { eventId: ctx.event.id, removed: false },
        select: {
          classId: true,
          eventorClubId: true,
          clubName: true,
          status: true,
          startTime: true,
          finishTime: true,
          cardNo: true,
        },
      });

      // Distinct clubs with at least one participant.
      const clubKeys = new Set<string>();
      for (const r of runners) {
        const status = runnerStatusToValue(r.status);
        if (isWithdrawn(status)) continue;
        const key = r.eventorClubId
          ? `e:${r.eventorClubId.toString()}`
          : r.clubName
            ? `n:${r.clubName.toLowerCase()}`
            : "";
        if (key) clubKeys.add(key);
      }
      const clubCount = clubKeys.size;

      const runnerCountByClass = new Map<string, number>();

      const now = new Date();
      const meosNow =
        (now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds()) * 10;
      const zeroTime = event.zeroTime;

      const punchGroups = await ctx.db.punch.groupBy({
        by: ["cardNo"],
        _count: { id: true },
        where: { eventId: ctx.event.id, removed: false },
      });
      const punchMap = new Map<number, number>(
        punchGroups.map((p) => [p.cardNo, p._count.id]),
      );

      const statusCounts: StatusCounts = {
        notStarted: 0,
        inForest: 0,
        finished: 0,
        cancelled: 0,
        startListCount: 0,
        resultCount: 0,
      };
      let participantCount = 0;
      for (const r of runners) {
        const status = runnerStatusToValue(r.status);
        if (isWithdrawn(status)) {
          statusCounts.cancelled++;
          continue;
        }
        participantCount++;
        if (r.classId) {
          runnerCountByClass.set(
            r.classId,
            (runnerCountByClass.get(r.classId) ?? 0) + 1,
          );
        }

        const hasPunches = (punchMap.get(r.cardNo ?? -1) ?? 0) > 0;
        const hasStartedByTime =
          r.startTime > 0 &&
          (r.startTime <= 1 || meosNow >= toAbsolute(r.startTime, zeroTime));
        const finished = isFinished(status, r.finishTime);

        if (finished) {
          statusCounts.finished++;
          statusCounts.resultCount++;
        } else if (hasPunches || hasStartedByTime) {
          statusCounts.inForest++;
        } else {
          statusCounts.notStarted++;
          statusCounts.startListCount++;
        }
      }

      // Resolve course seq for each class' courseId UUID.
      const courseSeqById = new Map(courses.map((c) => [c.id, c.seq]));
      const classInfos: ClassInfo[] = classes.map((c) => ({
        id: c.seq,
        name: c.name,
        courseId: c.courseId ? courseSeqById.get(c.courseId) ?? 0 : 0,
        sortIndex: c.sortIndex,
        runnerCount: runnerCountByClass.get(c.id) ?? 0,
        classFee: c.classFeeCents || undefined,
        allowQuickEntry: c.allowQuickEntry || undefined,
        sex: c.sex,
        lowAge: c.lowAge,
        highAge: c.highAge,
        classType: c.classType || undefined,
        freeStart: c.freeStart,
        noTiming: c.noTiming,
      }));

      const courseInfos: CourseInfo[] = await Promise.all(
        courses.map(async (c): Promise<CourseInfo> => {
          const expectedPositions = await resolveCourseExpectedPositions(
            ctx.db,
            c.id,
          );
          return {
            id: c.seq,
            name: c.name,
            length: c.lengthM,
            controls: "", // deprecated raw string; clients use expectedPositions
            controlCount: expectedPositions.length,
            numberOfMaps: c.numberOfMaps > 0 ? c.numberOfMaps : undefined,
            expectedPositions,
          };
        }),
      );

      let organizer: { name: string; eventorId: number } | undefined;
      const orgEventorId =
        event.organizerEventorId > 0 ? event.organizerEventorId : 0;
      if (event.organizerName || orgEventorId > 0) {
        organizer = {
          name: event.organizerName,
          eventorId: orgEventorId,
        };
      }

      const info = toEventInfo(event);
      return {
        event: info,
        competition: info, // legacy alias kept for one release
        classes: classInfos,
        courses: courseInfos,
        totalRunners: participantCount,
        totalClubs: clubCount,
        totalCourses: courseInfos.length,
        totalControls,
        statusCounts,
        organizer,
        contentSignals: {
          hasMap: mapCount > 0,
          hasClasses: classInfos.length > 0,
          hasCourses: courseInfos.length > 0,
          hasRunners: participantCount > 0,
          hasResults: statusCounts.resultCount > 0,
        },
      };
    },
  ),

  /** Runners list, optionally filtered. */
  runners: eventProcedure
    .input(
      z
        .object({
          classId: z.string().uuid().optional(),
          search: z.string().optional(),
        })
        .optional(),
    )
    .query(async ({ ctx, input }): Promise<RunnerInfo[]> => {
      const where: Record<string, unknown> = {
        eventId: ctx.event.id,
        removed: false,
      };
      if (input?.classId) where.classId = input.classId;
      if (input?.search) where.name = { contains: input.search, mode: "insensitive" };

      const runners = await ctx.db.runner.findMany({
        where,
        include: { class: { select: { name: true, seq: true } } },
        orderBy: [{ class: { sortIndex: "asc" } }, { startNo: "asc" }],
      });

      const zeroTime = ctx.event.zeroTime;
      return runners.map(
        (r): RunnerInfo => ({
          id: r.seq,
          name: r.name,
          cardNo: r.cardNo ?? 0,
          clubId: r.eventorClubId ? Number(r.eventorClubId) : 0,
          clubName: r.clubName,
          classId: r.class?.seq ?? 0,
          className: r.class?.name ?? "",
          startNo: r.startNo,
          startTime: toAbsolute(r.startTime, zeroTime),
          finishTime: toAbsolute(r.finishTime, zeroTime),
          status: runnerStatusToValue(r.status),
        }),
      );
    }),

  /**
   * Clubs derived from the runner roster (with at least one participating
   * runner). Eventor-linked clubs are deduped by `eventor_club_id`; clubless
   * free-text names by lowercased `club_name`.
   */
  clubs: eventProcedure.query(async ({ ctx }): Promise<ClubInfo[]> => {
    const runners = await ctx.db.runner.findMany({
      where: {
        eventId: ctx.event.id,
        removed: false,
        status: { notIn: WITHDRAWN_STATUSES.map(valueToRunnerStatus) },
      },
      select: { eventorClubId: true, clubName: true },
    });
    const byEventor = new Map<bigint, ClubInfo>();
    const byName = new Map<string, ClubInfo>();
    for (const r of runners) {
      if (r.eventorClubId) {
        if (!byEventor.has(r.eventorClubId)) {
          byEventor.set(r.eventorClubId, {
            id: Number(r.eventorClubId),
            name: r.clubName,
            eventorId: Number(r.eventorClubId),
          });
        }
      } else if (r.clubName) {
        const k = r.clubName.toLowerCase();
        if (!byName.has(k)) {
          byName.set(k, { id: 0, name: r.clubName });
        }
      }
    }
    const all = [...byEventor.values(), ...byName.values()];
    all.sort((a, b) => a.name.localeCompare(b.name));
    return all;
  }),

  /**
   * Change watermarks per table. Replaces `competition.counterState`
   * (which polled `oCounter`). Clients diff these to know what to invalidate.
   */
  changeWatermarks: eventProcedure.query(async ({ ctx }) => {
    const eventId = ctx.event.id;
    // Append-only tables (card_readouts, punches, event_log) use their
    // own timestamp columns; entity tables use updated_at.
    const entityTables = [
      "runners",
      "classes",
      "courses",
      "controls",
      "cards",
      "teams",
      "control_units",
    ] as const;
    const result: Record<string, string> = {};
    for (const t of entityTables) {
      const row = await ctx.db.$queryRawUnsafe<Array<{ max: Date | null }>>(
        `SELECT MAX(updated_at) AS max FROM oxygen.${t} WHERE event_id = $1`,
        eventId,
      );
      result[t] = row[0]?.max?.toISOString() ?? "";
    }
    // Append-only tables — clients invalidate when their max id changes.
    const punches = await ctx.db.$queryRawUnsafe<Array<{ max: Date | null }>>(
      `SELECT MAX(imported_at) AS max FROM oxygen.punches WHERE event_id = $1`,
      eventId,
    );
    result["punches"] = punches[0]?.max?.toISOString() ?? "";
    return result;
  }),

  /**
   * Legacy alias used by the web `useExternalChanges` hook. Maps the new
   * watermarks back onto the table keys the existing hook diffs against
   * (oRunner, oClass, …) so we don't have to update the hook for the
   * cutover release.
   */
  counterState: eventProcedure.query(async ({ ctx }) => {
    const eventId = ctx.event.id;
    const tables = [
      { legacy: "oRunner", table: "runners" },
      { legacy: "oClass", table: "classes" },
      { legacy: "oCourse", table: "courses" },
      { legacy: "oControl", table: "controls" },
      { legacy: "oCard", table: "cards" },
      { legacy: "oTeam", table: "teams" },
    ] as const;
    const out: Record<string, number> = {};
    for (const { legacy, table } of tables) {
      const row = await ctx.db.$queryRawUnsafe<Array<{ ms: number | null }>>(
        `SELECT EXTRACT(EPOCH FROM MAX(updated_at)) * 1000 AS ms FROM oxygen.${table} WHERE event_id = $1`,
        eventId,
      );
      out[legacy] = Math.floor(Number(row[0]?.ms) || 0);
    }
    const punches = await ctx.db.$queryRawUnsafe<Array<{ ms: number | null }>>(
      `SELECT EXTRACT(EPOCH FROM MAX(imported_at)) * 1000 AS ms FROM oxygen.punches WHERE event_id = $1`,
      eventId,
    );
    out.oPunch = Math.floor(Number(punches[0]?.ms) || 0);
    const eventRow = await ctx.db.$queryRawUnsafe<Array<{ ms: number | null }>>(
      `SELECT EXTRACT(EPOCH FROM MAX(updated_at)) * 1000 AS ms FROM oxygen.events WHERE id = $1`,
      eventId,
    );
    out.oEvent = Math.floor(Number(eventRow[0]?.ms) || 0);
    const club = await ctx.db.runner.aggregate({
      _max: { updatedAt: true },
      where: { eventId, removed: false },
    });
    out.oClub = club._max.updatedAt
      ? Math.floor(club._max.updatedAt.getTime())
      : 0;
    return out;
  }),

  /**
   * Start-screen summary — runners with their start times for the active
   * event, plus event metadata. Used by the kiosk start-screen view.
   */
  startScreen: eventProcedure
    .input(
      z.object({
        classId: z.number().int().optional(),
        windowSeconds: z.number().int().optional().default(1800),
      }).optional(),
    )
    .query(async ({ ctx, input }) => {
      const event = await ctx.db.event.findUnique({
        where: { id: ctx.event.id },
        select: { name: true, zeroTime: true, date: true },
      });
      const where: Record<string, unknown> = {
        eventId: ctx.event.id,
        removed: false,
        startTime: { gt: 0 },
      };
      if (input?.classId) {
        const cls = await ctx.db.class.findFirst({
          where: { eventId: ctx.event.id, seq: input.classId },
          select: { id: true },
        });
        if (cls) where.classId = cls.id;
      }
      const runners = await ctx.db.runner.findMany({
        where,
        include: { class: { select: { name: true, seq: true } } },
        orderBy: [{ startTime: "asc" }, { startNo: "asc" }],
      });
      const zeroTime = event?.zeroTime ?? 324000;
      return {
        competitionName: event?.name ?? "",
        eventName: event?.name ?? "",
        zeroTime,
        date: event?.date.toISOString().slice(0, 10) ?? "",
        runners: runners.map((r) => ({
          id: r.seq,
          name: r.name,
          className: r.class?.name ?? "",
          classId: r.class?.seq ?? 0,
          clubName: r.clubName,
          clubId: r.eventorClubId ? Number(r.eventorClubId) : 0,
          clubExtId: r.eventorClubId ? Number(r.eventorClubId) : 0,
          startNo: r.startNo,
          startTime: toAbsolute(r.startTime, zeroTime),
          status: 0,
          bib: r.bib,
        })),
      };
    }),

  /**
   * Postgres status — surface cumulative DB stats for the load
   * indicator. The frontend differences successive snapshots to derive
   * rates (queries/sec, tuples/sec) so all counters here are
   * monotonically increasing values pulled straight from
   * `pg_stat_database` and `pg_stat_activity`.
   */
  dbStatus: publicProcedure.query(async () => {
    try {
      const stats = await prisma().$queryRawUnsafe<
        Array<{
          numbackends: number | bigint;
          xact_commit: number | bigint;
          xact_rollback: number | bigint;
          tup_returned: number | bigint;
          tup_fetched: number | bigint;
          tup_inserted: number | bigint;
          tup_updated: number | bigint;
          tup_deleted: number | bigint;
          blks_read: number | bigint;
          blks_hit: number | bigint;
          deadlocks: number | bigint;
          temp_bytes: number | bigint;
          stats_reset: Date | null;
        }>
      >(`
        SELECT numbackends, xact_commit, xact_rollback,
               tup_returned, tup_fetched, tup_inserted, tup_updated, tup_deleted,
               blks_read, blks_hit,
               deadlocks, temp_bytes,
               stats_reset
        FROM pg_stat_database
        WHERE datname = current_database()
      `);
      const row = stats[0];
      if (!row) return null;

      const active = await prisma().$queryRawUnsafe<
        Array<{ active: bigint }>
      >(`
        SELECT count(*)::bigint AS active
        FROM pg_stat_activity
        WHERE datname = current_database() AND state = 'active'
      `);
      const dbSize = await prisma().$queryRawUnsafe<
        Array<{ size: bigint }>
      >(`SELECT pg_database_size(current_database())::bigint AS size`);

      const n = (v: number | bigint): number => Number(v);
      return {
        // Connection pool / activity
        backends: n(row.numbackends),
        activeBackends: Number(active[0]?.active ?? 0),

        // Transaction throughput (xact_commit + xact_rollback ~ qps)
        xactCommit: n(row.xact_commit),
        xactRollback: n(row.xact_rollback),

        // Per-operation counters (rate-derived in the UI)
        tupReturned: n(row.tup_returned),
        tupFetched: n(row.tup_fetched),
        tupInserted: n(row.tup_inserted),
        tupUpdated: n(row.tup_updated),
        tupDeleted: n(row.tup_deleted),

        // Buffer cache
        blksRead: n(row.blks_read),
        blksHit: n(row.blks_hit),

        // Health
        deadlocks: n(row.deadlocks),
        tempBytes: n(row.temp_bytes),
        dbSizeBytes: Number(dbSize[0]?.size ?? 0),

        // ISO timestamp the stats counters were last reset (uptime
        // proxy for the rate computations on the client).
        statsReset: row.stats_reset?.toISOString() ?? null,
      };
    } catch (err) {
      console.error("[dbStatus] query failed:", err);
      return null;
    }
  }),

  // ─── Registration config ────────────────────────────────

  getRegistrationConfig: eventProcedure.query(async ({ ctx }) => {
    const event = await ctx.db.event.findUnique({ where: { id: ctx.event.id } });
    if (!event) {
      throw new TRPCError({ code: "NOT_FOUND", message: "Event not found" });
    }
    let organizerDetails:
      | {
          name: string;
          street?: string;
          city?: string;
          zip?: string;
          phone?: string;
          email?: string;
          webUrl?: string;
        }
      | undefined;
    if (event.organizerEventorId > 0) {
      const club = await ctx.db.clubDirectory.findUnique({
        where: { eventorId: BigInt(event.organizerEventorId) },
      });
      if (club) {
        organizerDetails = {
          name: club.name,
          ...(event.street ? { street: event.street } : {}),
          ...(event.city ? { city: event.city } : {}),
          ...(event.zip ? { zip: event.zip } : {}),
          ...(event.phone ? { phone: event.phone } : {}),
          ...(event.email ? { email: event.email } : {}),
          ...(event.webUrl ? { webUrl: event.webUrl } : {}),
        };
      }
    }
    return {
      paymentMethods: event.paymentMethods?.split(",").filter(Boolean) ?? [
        "billed",
      ],
      swishNumber: event.swishNumber,
      swishPayeeName: event.swishPayeeName,
      printRegistrationReceipt: event.printRegistrationReceipt,
      registrationReceiptMessage: event.registrationReceiptMessage,
      finishReceiptMessage: event.finishReceiptMessage,
      organizerEventorId: event.organizerEventorId,
      orgNumber: event.orgNumber,
      vatExempt: event.vatExempt,
      receiptFriskvardNote: event.receiptFriskvardNote,
      organizerDetails,
    };
  }),

  setRegistrationConfig: eventProcedure
    .input(
      z.object({
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
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const data: Record<string, unknown> = {};
      if (input.paymentMethods !== undefined)
        data.paymentMethods = input.paymentMethods.join(",");
      if (input.swishNumber !== undefined) data.swishNumber = input.swishNumber;
      if (input.swishPayeeName !== undefined)
        data.swishPayeeName = input.swishPayeeName;
      if (input.printRegistrationReceipt !== undefined)
        data.printRegistrationReceipt = input.printRegistrationReceipt;
      if (input.registrationReceiptMessage !== undefined)
        data.registrationReceiptMessage = input.registrationReceiptMessage;
      if (input.finishReceiptMessage !== undefined)
        data.finishReceiptMessage = input.finishReceiptMessage;
      if (input.organizerEventorId !== undefined)
        data.organizerEventorId = input.organizerEventorId;
      if (input.orgNumber !== undefined) data.orgNumber = input.orgNumber;
      if (input.vatExempt !== undefined) data.vatExempt = input.vatExempt;
      if (input.receiptFriskvardNote !== undefined)
        data.receiptFriskvardNote = input.receiptFriskvardNote;

      if (Object.keys(data).length > 0) {
        await ctx.db.event.update({ where: { id: ctx.event.id }, data });
      }
      return { ok: true };
    }),

  // ─── Google Sheets backup ───────────────────────────────

  getGoogleSheetsConfig: eventProcedure.query(async ({ ctx }) => {
    const event = await ctx.db.event.findUnique({
      where: { id: ctx.event.id },
      select: { googleSheetsWebhookUrl: true },
    });
    return { webhookUrl: event?.googleSheetsWebhookUrl ?? "" };
  }),

  setGoogleSheetsConfig: eventProcedure
    .input(z.object({ webhookUrl: z.string() }))
    .mutation(async ({ ctx, input }) => {
      await ctx.db.event.update({
        where: { id: ctx.event.id },
        data: { googleSheetsWebhookUrl: input.webhookUrl },
      });
      clearSheetsCache();
      return { ok: true };
    }),

  testGoogleSheetsWebhook: publicProcedure
    .input(z.object({ webhookUrl: z.string().url() }))
    .mutation(async ({ input }) => {
      return testGoogleSheetPush(input.webhookUrl);
    }),

  // ─── Rental card fee ────────────────────────────────────

  getCardFee: eventProcedure.query(async ({ ctx }) => {
    const event = await ctx.db.event.findUnique({
      where: { id: ctx.event.id },
      select: { cardFeeCents: true },
    });
    return { cardFee: event?.cardFeeCents ?? 0 };
  }),

  setCardFee: eventProcedure
    .input(z.object({ cardFee: z.number().int().min(0) }))
    .mutation(async ({ ctx, input }) => {
      await ctx.db.event.update({
        where: { id: ctx.event.id },
        data: { cardFeeCents: input.cardFee },
      });
      return { ok: true };
    }),
});

// ─── Helpers ──────────────────────────────────────────────

function toEventInfo(
  row: {
    id: bigint;
    nameId: string;
    name: string;
    annotation: string;
    date: Date;
    kind: string;
    eventorEnv: string;
    eventorEventId: bigint | null;
  },
  classificationId?: number,
): EventInfo {
  return {
    id: Number(row.id),
    name: row.name,
    annotation: row.annotation,
    date: row.date.toISOString().slice(0, 10),
    nameId: row.nameId,
    kind: row.kind,
    eventorEnv: row.eventorEnv as "prod" | "test" | undefined,
    eventorEventId: row.eventorEventId ? Number(row.eventorEventId) : undefined,
    classificationId,
  };
}

// Backward-compat alias. The tRPC root exposes this router under both
// `event.*` (preferred) and `competition.*` (legacy); the alias also
// lets server-side modules import `competitionRouter` by name without
// reaching across the rename. Safe to drop once both the API surface
// and every web import standardise on `event.*`.
export { eventRouter as competitionRouter };
