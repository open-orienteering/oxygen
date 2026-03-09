import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router, publicProcedure } from "../trpc.js";
import { getCompetitionClient, incrementCounter } from "../db.js";
import type { RunnerDetail, RunnerInfo } from "@oxygen/shared";

/** Check that cardNo is not already assigned to another (non-removed) runner. */
async function assertCardNotTaken(
  client: Awaited<ReturnType<typeof getCompetitionClient>>,
  cardNo: number,
  excludeRunnerId?: number,
): Promise<void> {
  if (cardNo <= 0) return; // 0 = unassigned, allow duplicates
  const existing = await client.oRunner.findFirst({
    where: { CardNo: cardNo, Removed: false, ...(excludeRunnerId ? { Id: { not: excludeRunnerId } } : {}) },
    select: { Id: true, Name: true },
  });
  if (existing) {
    throw new TRPCError({
      code: "CONFLICT",
      message: `Card ${cardNo} is already assigned to ${existing.Name} (runner #${existing.Id})`,
    });
  }
}

/**
 * Normalize BirthYear from MeOS format.
 * MeOS stores BirthYear as either YYYY (1900-9999) or YYYYMMDD (>9999).
 * Oxygen always returns YYYY.
 */
function normalizeBirthYear(val: number): number {
  if (val > 9999) return Math.floor(val / 10000);
  return val;
}

/** Schema for creating a runner — defaults fill in MeOS-required zero values. */
const runnerCreateSchema = z.object({
  name: z.string().min(1),
  cardNo: z.number().int().optional().default(0),
  clubId: z.number().int().optional().default(0),
  classId: z.number().int(),
  startNo: z.number().int().optional().default(0),
  startTime: z.number().int().optional().default(0),
  birthYear: z.number().int().optional().default(0),
  sex: z.string().optional().default(""),
  nationality: z.string().optional().default(""),
  phone: z.string().optional().default(""),
  status: z.number().int().optional(),
  finishTime: z.number().int().optional(),
  fee: z.number().int().optional().default(0),
  paid: z.number().int().optional().default(0),
  payMode: z.number().int().optional().default(0),
});

/** Schema for updating a runner — no defaults, so omitted fields stay untouched. */
const runnerUpdateSchema = z.object({
  name: z.string().min(1).optional(),
  cardNo: z.number().int().optional(),
  clubId: z.number().int().optional(),
  classId: z.number().int().optional(),
  startNo: z.number().int().optional(),
  startTime: z.number().int().optional(),
  birthYear: z.number().int().optional(),
  sex: z.string().optional(),
  nationality: z.string().optional(),
  phone: z.string().optional(),
  status: z.number().int().optional(),
  finishTime: z.number().int().optional(),
  fee: z.number().int().optional(),
  paid: z.number().int().optional(),
  payMode: z.number().int().optional(),
});

export const runnerRouter = router({
  /**
   * Get a single runner by ID with full detail.
   */
  getById: publicProcedure
    .input(z.object({ id: z.number().int() }))
    .query(async ({ input }): Promise<RunnerDetail> => {
      const client = await getCompetitionClient();
      const r = await client.oRunner.findFirst({
        where: { Id: input.id, Removed: false },
      });
      if (!r) {
        throw new Error(`Runner with ID ${input.id} not found`);
      }

      // Lookup names
      const club = r.Club
        ? await client.oClub.findUnique({ where: { Id: r.Club } })
        : null;
      const cls = r.Class
        ? await client.oClass.findUnique({ where: { Id: r.Class } })
        : null;

      return {
        id: r.Id,
        name: r.Name,
        cardNo: r.CardNo,
        clubId: r.Club,
        clubName: club?.Name ?? "",
        classId: r.Class,
        className: cls?.Name ?? "",
        startNo: r.StartNo,
        startTime: r.StartTime,
        finishTime: r.FinishTime,
        status: r.Status as RunnerDetail["status"],
        birthYear: normalizeBirthYear(r.BirthYear),
        sex: r.Sex,
        nationality: r.Nationality,
        phone: r.Phone,
        fee: r.Fee,
        paid: r.Paid,
        payMode: r.PayMode,
        bib: r.Bib,
        entryDate: r.EntryDate,
      };
    }),

  /**
   * Find a runner by SI card number. Returns null if not found.
   */
  findByCard: publicProcedure
    .input(z.object({ cardNo: z.number().int() }))
    .query(async ({ input }) => {
      if (input.cardNo <= 0) return null;
      const client = await getCompetitionClient();
      const r = await client.oRunner.findFirst({
        where: { CardNo: input.cardNo, Removed: false },
      });
      if (!r) return null;

      const club = r.Club ? await client.oClub.findUnique({ where: { Id: r.Club } }) : null;
      const cls = r.Class ? await client.oClass.findUnique({ where: { Id: r.Class } }) : null;

      return {
        id: r.Id,
        name: r.Name,
        cardNo: r.CardNo,
        clubId: r.Club,
        clubName: club?.Name ?? "",
        classId: r.Class,
        className: cls?.Name ?? "",
        startTime: r.StartTime,
        finishTime: r.FinishTime,
        status: r.Status,
      };
    }),

  /**
   * List runners with filtering and search.
   */
  list: publicProcedure
    .input(
      z
        .object({
          classId: z.number().optional(),
          clubId: z.number().optional(),
          search: z.string().optional(),
          statusFilter: z.string().optional(), // "not-started", "in-forest", "finished", or numeric status value
        })
        .optional(),
    )
    .query(async ({ input }): Promise<RunnerInfo[]> => {
      const client = await getCompetitionClient();

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

      // Build where clause with multi-field search
      const baseFilters: Record<string, unknown>[] = [{ Removed: false }];
      if (input?.classId) baseFilters.push({ Class: input.classId });
      if (input?.clubId) baseFilters.push({ Club: input.clubId });

      if (input?.search) {
        const searchTerm = input.search.trim();
        const orConditions: Record<string, unknown>[] = [
          { Name: { contains: searchTerm } },
        ];

        // Search by card number (partial/prefix match) if the term looks numeric
        if (/^\d+$/.test(searchTerm)) {
          const cardMatches = await client.$queryRawUnsafe<{ Id: number }[]>(
            `SELECT Id FROM oRunner WHERE Removed=0 AND CAST(CardNo AS CHAR) LIKE ?`,
            `${searchTerm}%`,
          );
          if (cardMatches.length > 0) {
            orConditions.push({ Id: { in: cardMatches.map((c) => c.Id) } });
          }
        }

        // Search by club name: find matching club IDs
        const matchingClubIds = [...clubMap.entries()]
          .filter(([, name]) => name.toLowerCase().includes(searchTerm.toLowerCase()))
          .map(([id]) => id);
        if (matchingClubIds.length > 0) {
          orConditions.push({ Club: { in: matchingClubIds } });
        }

        baseFilters.push({ OR: orConditions });
      }

      const runners = await client.oRunner.findMany({
        where: { AND: baseFilters },
        orderBy: [{ Class: "asc" }, { StartNo: "asc" }],
      });

      // Fetch event for ZeroTime calculation
      const event = await client.oEvent.findFirst({ where: { Removed: false } });
      const zeroTime = event?.ZeroTime ?? 0;
      const now = new Date();
      const meosNow = (now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds()) * 10;

      // Fetch punches to detect 'In Forest' runners
      const punches = await client.oPunch.findMany({
        where: { Removed: false },
        select: { CardNo: true },
      });
      const punchCardNos = new Set(punches.map(p => p.CardNo));

      // Apply status filter (logical groups or specific status)
      const statusFilter = input?.statusFilter;
      const filtered = statusFilter
        ? runners.filter((r) => {
          const hasPunches = punchCardNos.has(r.CardNo);
          const hasStartedByTime = r.StartTime > 0 && meosNow >= (zeroTime + r.StartTime);
          const hasFinishTime = r.FinishTime > 0;
          const hasResult = r.Status > 0;

          if (statusFilter === "not-started") {
            return !hasResult && !hasFinishTime && !hasPunches && !hasStartedByTime;
          }
          if (statusFilter === "in-forest") {
            return !hasResult && !hasFinishTime && (hasPunches || hasStartedByTime);
          }
          if (statusFilter === "finished") {
            return hasResult || hasFinishTime;
          }
          // Specific numeric status
          const statusNum = parseInt(statusFilter, 10);
          if (!isNaN(statusNum)) {
            return r.Status === statusNum;
          }
          return true;
        })
        : runners;

      return filtered.map(
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
          fee: r.Fee || undefined,
          paid: r.Paid || undefined,
          payMode: r.PayMode || undefined,
        }),
      );
    }),

  /**
   * Create a new runner.
   */
  create: publicProcedure
    .input(runnerCreateSchema)
    .mutation(async ({ input }) => {
      const client = await getCompetitionClient();

      await assertCardNotTaken(client, input.cardNo);

      const runner = await client.oRunner.create({
        data: {
          Name: input.name,
          CardNo: input.cardNo,
          Club: input.clubId,
          Class: input.classId,
          StartNo: input.startNo,
          StartTime: input.startTime,
          BirthYear: input.birthYear,
          Sex: input.sex,
          Nationality: input.nationality,
          Phone: input.phone,
          Fee: input.fee,
          Paid: input.paid,
          PayMode: input.payMode,
          // MeOS requires these MediumText fields to be non-null
          InputResult: "",
          Annotation: "",
        },
      });

      await incrementCounter("oRunner", runner.Id);
      return { id: runner.Id, name: runner.Name };
    }),

  /**
   * Update an existing runner.
   */
  update: publicProcedure
    .input(
      z.object({
        id: z.number().int(),
        data: runnerUpdateSchema,
      }),
    )
    .mutation(async ({ input }) => {
      const client = await getCompetitionClient();

      if (input.data.cardNo !== undefined) {
        await assertCardNotTaken(client, input.data.cardNo, input.id);
      }

      const updateData: Record<string, unknown> = {};
      if (input.data.name !== undefined) updateData.Name = input.data.name;
      if (input.data.cardNo !== undefined)
        updateData.CardNo = input.data.cardNo;
      if (input.data.clubId !== undefined) updateData.Club = input.data.clubId;
      if (input.data.classId !== undefined)
        updateData.Class = input.data.classId;
      if (input.data.startNo !== undefined)
        updateData.StartNo = input.data.startNo;
      if (input.data.startTime !== undefined)
        updateData.StartTime = input.data.startTime;
      if (input.data.birthYear !== undefined)
        updateData.BirthYear = input.data.birthYear;
      if (input.data.sex !== undefined) updateData.Sex = input.data.sex;
      if (input.data.nationality !== undefined)
        updateData.Nationality = input.data.nationality;
      if (input.data.phone !== undefined) updateData.Phone = input.data.phone;
      if (input.data.status !== undefined) updateData.Status = input.data.status;
      if (input.data.finishTime !== undefined)
        updateData.FinishTime = input.data.finishTime;
      if (input.data.fee !== undefined) updateData.Fee = input.data.fee;
      if (input.data.paid !== undefined) updateData.Paid = input.data.paid;
      if (input.data.payMode !== undefined) updateData.PayMode = input.data.payMode;

      const runner = await client.oRunner.update({
        where: { Id: input.id },
        data: updateData,
      });

      await incrementCounter("oRunner", runner.Id);
      return { id: runner.Id, name: runner.Name };
    }),

  /**
   * Bulk update multiple runners.
   */
  bulkUpdate: publicProcedure
    .input(
      z.object({
        ids: z.array(z.number().int()).min(1).max(1000),
        data: runnerUpdateSchema,
      }),
    )
    .mutation(async ({ input }) => {
      const client = await getCompetitionClient();

      const updateData: Record<string, unknown> = {};
      if (input.data.name !== undefined) updateData.Name = input.data.name;
      if (input.data.cardNo !== undefined)
        updateData.CardNo = input.data.cardNo;
      if (input.data.clubId !== undefined) updateData.Club = input.data.clubId;
      if (input.data.classId !== undefined)
        updateData.Class = input.data.classId;
      if (input.data.startNo !== undefined)
        updateData.StartNo = input.data.startNo;
      if (input.data.startTime !== undefined)
        updateData.StartTime = input.data.startTime;
      if (input.data.birthYear !== undefined)
        updateData.BirthYear = input.data.birthYear;
      if (input.data.sex !== undefined) updateData.Sex = input.data.sex;
      if (input.data.nationality !== undefined)
        updateData.Nationality = input.data.nationality;
      if (input.data.phone !== undefined) updateData.Phone = input.data.phone;
      if (input.data.status !== undefined) updateData.Status = input.data.status;
      if (input.data.finishTime !== undefined)
        updateData.FinishTime = input.data.finishTime;
      if (input.data.fee !== undefined) updateData.Fee = input.data.fee;
      if (input.data.paid !== undefined) updateData.Paid = input.data.paid;
      if (input.data.payMode !== undefined) updateData.PayMode = input.data.payMode;

      let updatedCount = 0;
      for (const id of input.ids) {
        await client.oRunner.update({
          where: { Id: id },
          data: updateData,
        });
        await incrementCounter("oRunner", id);
        updatedCount++;
      }

      return { updated: updatedCount };
    }),

  /**
   * Delete a runner (soft delete - sets Removed=true, matching MeOS convention).
   */
  delete: publicProcedure
    .input(z.object({ id: z.number().int() }))
    .mutation(async ({ input }) => {
      const client = await getCompetitionClient();
      await client.oRunner.update({
        where: { Id: input.id },
        data: { Removed: true },
      });
      await incrementCounter("oRunner", input.id);
      return { success: true };
    }),

  /**
   * Start screen data: returns ZeroTime + all runners with start times
   * for the advance-time display at the start area.
   */
  startScreen: publicProcedure.query(async () => {
    const client = await getCompetitionClient();

    // Get ZeroTime from the event
    const event = await client.oEvent.findFirst({
      where: { Removed: false },
      select: { ZeroTime: true, Name: true },
    });
    const zeroTime = event?.ZeroTime ?? 324000; // default 09:00:00

    // Get clubs and classes for name lookups
    const clubs = await client.oClub.findMany({
      where: { Removed: false },
      select: { Id: true, Name: true, ExtId: true },
    });
    const clubMap = new Map(clubs.map((c) => [c.Id, { name: c.Name, extId: Number(c.ExtId) || 0 }]));

    const classes = await client.oClass.findMany({
      where: { Removed: false },
      select: { Id: true, Name: true },
    });
    const classMap = new Map(classes.map((c) => [c.Id, c.Name]));

    // Get all runners with assigned start times
    const runners = await client.oRunner.findMany({
      where: { Removed: false, StartTime: { gt: 0 } },
      orderBy: [{ StartTime: "asc" }, { StartNo: "asc" }],
      select: {
        Id: true,
        Name: true,
        Club: true,
        Class: true,
        StartTime: true,
        StartNo: true,
        Status: true,
      },
    });

    return {
      zeroTime,
      competitionName: event?.Name ?? "",
      runners: runners.map((r) => {
        const club = clubMap.get(r.Club);
        return {
          id: r.Id,
          name: r.Name,
          clubId: r.Club,
          clubName: club?.name ?? "",
          clubExtId: club?.extId ?? 0,
          classId: r.Class,
          className: classMap.get(r.Class) ?? "",
          startTime: r.StartTime,
          startNo: r.StartNo,
          status: r.Status,
        };
      }),
    };
  }),
});
