import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router, competitionProcedure } from "../trpc.js";
import { incrementCounter, incrementCounterBatch, getZeroTime } from "../db.js";
import { toRelative, toAbsolute } from "../timeConvert.js";
import type { RunnerDetail, RunnerInfo } from "@oxygen/shared";
import type { PrismaClient } from "@prisma/client";
import { parsePunches, parseCourseControls, performReadout } from "./cardReadout.js";
import { computeClassPlacements } from "../results.js";
import { pushRegistrationToSheet } from "../sheetsBackup.js";

/**
 * MeOS stores CardFee = -1 to mean "rental card, use competition default".
 * CardFee > 0 means an explicit fee. CardFee = 0 means not a rental card.
 * This helper resolves -1 to the competition-level fee so the frontend
 * receives the effective fee. Returns the resolved positive fee, or -1
 * if the runner has a rental card but no competition-level fee is configured.
 * Frontend should treat any non-zero value as "is rental card".
 */
async function resolveCardFee(
  client: PrismaClient,
  rawCardFee: number,
): Promise<number> {
  if (rawCardFee === 0) return 0;
  if (rawCardFee > 0) return rawCardFee;
  const event = await client.oEvent.findFirst({ where: { Removed: false }, select: { CardFee: true } });
  const baseFee = event?.CardFee ?? 0;
  return baseFee > 0 ? baseFee : rawCardFee;
}

/** Check that cardNo is not already assigned to another (non-removed) runner. */
async function assertCardNotTaken(
  client: PrismaClient,
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
/** @internal Exported for unit testing. */
export function normalizeBirthYear(val: number): number {
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
  cardFee: z.number().int().optional().default(0),
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
  cardFee: z.number().int().optional(),
});

export const runnerRouter = router({
  /**
   * Get a single runner by ID with full detail.
   */
  getById: competitionProcedure
    .input(z.object({ id: z.number().int() }))
    .query(async ({ ctx, input }): Promise<RunnerDetail> => {
      const client = ctx.db;
      const r = await client.oRunner.findFirst({
        where: { Id: input.id, Removed: false },
      });
      if (!r) {
        throw new TRPCError({ code: "NOT_FOUND", message: `Runner ${input.id} not found` });
      }

      const zeroTime = await getZeroTime(client);

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
        startTime: toAbsolute(r.StartTime, zeroTime),
        finishTime: toAbsolute(r.FinishTime, zeroTime),
        status: r.Status as RunnerDetail["status"],
        birthYear: normalizeBirthYear(r.BirthYear),
        sex: r.Sex,
        nationality: r.Nationality,
        phone: r.Phone,
        fee: r.Fee,
        paid: r.Paid,
        payMode: r.PayMode,
        cardFee: await resolveCardFee(client, r.CardFee),
        cardReturned: r.oos_card_returned === 1,
        bib: r.Bib,
        entryDate: r.EntryDate,
        transferFlags: r.TransferFlags,
      };
    }),

  /**
   * Find a runner by SI card number. Returns null if not found.
   */
  findByCard: competitionProcedure
    .input(z.object({ cardNo: z.number().int() }))
    .query(async ({ ctx, input }) => {
      if (input.cardNo <= 0) return null;
      const client = ctx.db;
      const r = await client.oRunner.findFirst({
        where: { CardNo: input.cardNo, Removed: false },
      });
      if (!r) return null;

      const zeroTime = await getZeroTime(client);
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
        startTime: toAbsolute(r.StartTime, zeroTime),
        finishTime: toAbsolute(r.FinishTime, zeroTime),
        status: r.Status,
      };
    }),

  /**
   * List runners with filtering and search.
   */
  list: competitionProcedure
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
    .query(async ({ ctx, input }): Promise<RunnerInfo[]> => {
      const client = ctx.db;

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

      const zeroTime = await getZeroTime(client);
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
          // StartTime=1 is a MeOS sentinel for "drawn but no specific time" (interval=0)
          const hasStartedByTime = r.StartTime > 0 && (r.StartTime <= 1 || meosNow >= toAbsolute(r.StartTime, zeroTime));
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

      // ── Punch control codes (from oCard) ──
      const cards = await client.oCard.findMany({
        where: { Removed: false },
        select: { CardNo: true, Punches: true },
      });
      const punchCodesMap = new Map<number, number[]>();
      const cardStartTimeMap = new Map<number, number>();
      for (const card of cards) {
        const parsed = parsePunches(card.Punches);
        const codes: number[] = [];
        for (const p of parsed) {
          if (p.type >= 100) codes.push(p.type);
          if (p.type === 1 && !cardStartTimeMap.has(card.CardNo)) {
            cardStartTimeMap.set(card.CardNo, toAbsolute(p.time, zeroTime));
          }
        }
        // Keep latest card data per CardNo (last wins)
        if (codes.length > 0) punchCodesMap.set(card.CardNo, codes);
      }

      // ── Course control codes ──
      const courseIds = new Set<number>();
      const classEntities = await client.oClass.findMany({
        where: { Removed: false },
        select: { Id: true, Course: true },
      });
      const classCourseMap = new Map(classEntities.map((c) => [c.Id, c.Course]));
      for (const r of filtered) {
        const cid = r.Course > 0 ? r.Course : (classCourseMap.get(r.Class) ?? 0);
        if (cid > 0) courseIds.add(cid);
      }
      const courses = courseIds.size > 0
        ? await client.oCourse.findMany({
            where: { Id: { in: [...courseIds] }, Removed: false },
            select: { Id: true, Controls: true },
          })
        : [];
      const courseControlsMap = new Map<number, number[]>();
      for (const c of courses) {
        courseControlsMap.set(c.Id, parseCourseControls(c.Controls));
      }

      // Fetch competition-level card fee once for resolving CardFee = -1
      const eventRow = await client.oEvent.findFirst({ where: { Removed: false }, select: { CardFee: true } });
      const baseCardFee = eventRow?.CardFee ?? 0;
      const resolveRawCardFee = (raw: number) => raw === 0 ? 0 : raw > 0 ? raw : (baseCardFee > 0 ? baseCardFee : raw);

      // ── Class placements (rank) ──
      const rankMap = new Map<number, number>();
      const byClass = new Map<number, typeof filtered>();
      for (const r of filtered) {
        let arr = byClass.get(r.Class);
        if (!arr) { arr = []; byClass.set(r.Class, arr); }
        arr.push(r);
      }
      for (const [, classRunners] of byClass) {
        const forPlacement = classRunners.map((r) => ({
          id: r.Id,
          status: r.Status,
          startTime: r.StartTime,
          finishTime: r.FinishTime,
        }));
        const placements = computeClassPlacements(forPlacement, false);
        for (const [rId, result] of placements) {
          if (result.place > 0) rankMap.set(rId, result.place);
        }
      }

      return filtered.map(
        (r): RunnerInfo => {
          const courseId = r.Course > 0 ? r.Course : (classCourseMap.get(r.Class) ?? 0);
          return {
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
            fee: r.Fee || undefined,
            paid: r.Paid || undefined,
            payMode: r.PayMode || undefined,
            cardFee: resolveRawCardFee(r.CardFee) || undefined,
            cardReturned: r.CardFee !== 0 && r.oos_card_returned === 1 ? true : undefined,
            birthYear: r.BirthYear || undefined,
            sex: r.Sex || undefined,
            bib: r.Bib || undefined,
            nationality: r.Nationality || undefined,
            punchControlCodes: punchCodesMap.get(r.CardNo),
            courseControlCodes: courseId > 0 ? courseControlsMap.get(courseId) : undefined,
            rank: rankMap.get(r.Id),
            cardStartTime: cardStartTimeMap.get(r.CardNo),
            transferFlags: r.TransferFlags || undefined,
          };
        },
      );
    }),

  /**
   * Create a new runner.
   */
  create: competitionProcedure
    .input(runnerCreateSchema)
    .mutation(async ({ ctx, input }) => {
      const client = ctx.db;

      await assertCardNotTaken(client, input.cardNo);

      const zeroTime = (input.startTime || input.finishTime) ? await getZeroTime(client) : 0;

      const runner = await client.oRunner.create({
        data: {
          Name: input.name,
          CardNo: input.cardNo,
          Club: input.clubId,
          Class: input.classId,
          StartNo: input.startNo,
          StartTime: input.startTime ? toRelative(input.startTime, zeroTime) : 0,
          BirthYear: input.birthYear,
          Sex: input.sex,
          Nationality: input.nationality,
          Phone: input.phone,
          Fee: input.fee,
          Paid: input.paid,
          PayMode: input.payMode,
          FinishTime: input.finishTime ? toRelative(input.finishTime, zeroTime) : 0,
          CardFee: input.cardFee,
          // MeOS requires these MediumText fields to be non-null
          InputResult: "",
          Annotation: "",
        },
      });

      // Link existing oCard if one exists for this card number
      if (input.cardNo > 0) {
        const existingCard = await client.oCard.findFirst({
          where: { CardNo: input.cardNo, Removed: false },
        });
        if (existingCard) {
          await client.oRunner.update({
            where: { Id: runner.Id },
            data: { Card: existingCard.Id },
          });
        }
      }

      await incrementCounter("oRunner", runner.Id, ctx.dbName);

      // Fire-and-forget Google Sheets backup
      {
        const cls = input.classId
          ? await client.oClass.findUnique({ where: { Id: input.classId }, select: { Name: true } })
          : null;
        const club = input.clubId
          ? await client.oClub.findUnique({ where: { Id: input.clubId }, select: { Name: true } })
          : null;
        pushRegistrationToSheet(client, ctx.dbName, {
          sheet: "Registrations",
          timestamp: new Date().toISOString(),
          runnerId: runner.Id,
          name: input.name,
          className: cls?.Name ?? "",
          clubName: club?.Name ?? "",
          cardNo: input.cardNo,
          startNo: input.startNo,
          birthYear: input.birthYear,
          sex: input.sex,
          nationality: input.nationality,
          phone: input.phone,
          fee: input.fee,
          paid: input.paid,
          payMode: input.payMode,
        });
      }

      return { id: runner.Id, name: runner.Name };
    }),

  /**
   * Update an existing runner.
   */
  update: competitionProcedure
    .input(
      z.object({
        id: z.number().int(),
        data: runnerUpdateSchema,
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const client = ctx.db;

      if (input.data.cardNo !== undefined) {
        await assertCardNotTaken(client, input.data.cardNo, input.id);
      }

      const needsZT = input.data.startTime !== undefined || input.data.finishTime !== undefined
        || input.data.status === 1 /* may need to derive times from oCard */;
      const zeroTime = needsZT ? await getZeroTime(client) : 0;

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
        updateData.StartTime = toRelative(input.data.startTime, zeroTime);
      if (input.data.birthYear !== undefined)
        updateData.BirthYear = input.data.birthYear;
      if (input.data.sex !== undefined) updateData.Sex = input.data.sex;
      if (input.data.nationality !== undefined)
        updateData.Nationality = input.data.nationality;
      if (input.data.phone !== undefined) updateData.Phone = input.data.phone;
      if (input.data.status !== undefined) updateData.Status = input.data.status;
      if (input.data.finishTime !== undefined)
        updateData.FinishTime = toRelative(input.data.finishTime, zeroTime);
      if (input.data.fee !== undefined) updateData.Fee = input.data.fee;
      if (input.data.paid !== undefined) updateData.Paid = input.data.paid;
      if (input.data.payMode !== undefined) updateData.PayMode = input.data.payMode;
      if (input.data.cardFee !== undefined) updateData.CardFee = input.data.cardFee;

      const runner = await client.oRunner.update({
        where: { Id: input.id },
        data: updateData,
      });

      // When status is changed to OK and times are missing, derive from oCard
      if (input.data.status === 1 /* RunnerStatus.OK */) {
        if (runner.StartTime === 0 || runner.FinishTime === 0) {
          const result = await performReadout(client, input.id);
          if (result && result.timing.finishTime !== 0) {
            const timeUpdate: Record<string, number> = {};
            if (runner.StartTime === 0) timeUpdate.StartTime = toRelative(result.timing.startTime, zeroTime);
            if (runner.FinishTime === 0) timeUpdate.FinishTime = toRelative(result.timing.finishTime, zeroTime);
            if (Object.keys(timeUpdate).length > 0) {
              await client.oRunner.update({
                where: { Id: input.id },
                data: timeUpdate,
              });
            }
          }
        }
      }

      await incrementCounter("oRunner", runner.Id, ctx.dbName);
      return { id: runner.Id, name: runner.Name };
    }),

  /**
   * Bulk update multiple runners.
   */
  bulkUpdate: competitionProcedure
    .input(
      z.object({
        ids: z.array(z.number().int()).min(1).max(1000),
        data: runnerUpdateSchema,
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const client = ctx.db;

      const needsZT = input.data.startTime !== undefined || input.data.finishTime !== undefined;
      const zeroTime = needsZT ? await getZeroTime(client) : 0;

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
        updateData.StartTime = toRelative(input.data.startTime, zeroTime);
      if (input.data.birthYear !== undefined)
        updateData.BirthYear = input.data.birthYear;
      if (input.data.sex !== undefined) updateData.Sex = input.data.sex;
      if (input.data.nationality !== undefined)
        updateData.Nationality = input.data.nationality;
      if (input.data.phone !== undefined) updateData.Phone = input.data.phone;
      if (input.data.status !== undefined) updateData.Status = input.data.status;
      if (input.data.finishTime !== undefined)
        updateData.FinishTime = toRelative(input.data.finishTime, zeroTime);
      if (input.data.fee !== undefined) updateData.Fee = input.data.fee;
      if (input.data.paid !== undefined) updateData.Paid = input.data.paid;
      if (input.data.payMode !== undefined) updateData.PayMode = input.data.payMode;
      if (input.data.cardFee !== undefined) updateData.CardFee = input.data.cardFee;

      await client.oRunner.updateMany({
        where: { Id: { in: input.ids } },
        data: updateData,
      });
      await incrementCounterBatch("oRunner", input.ids, ctx.dbName);

      return { updated: input.ids.length };
    }),

  /**
   * Delete a runner (soft delete - sets Removed=true, matching MeOS convention).
   */
  delete: competitionProcedure
    .input(z.object({ id: z.number().int() }))
    .mutation(async ({ ctx, input }) => {
      const client = ctx.db;
      await client.oRunner.update({
        where: { Id: input.id },
        data: { Removed: true },
      });
      await incrementCounter("oRunner", input.id, ctx.dbName);
      return { success: true };
    }),

  /**
   * Mark a rental card as returned (or undo the return).
   * Writes to oos_card_returned — an Oxygen-only column ignored by MeOS.
   */
  setCardReturned: competitionProcedure
    .input(z.object({ runnerId: z.number().int(), returned: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      const client = ctx.db;
      await client.oRunner.update({
        where: { Id: input.runnerId },
        data: { oos_card_returned: input.returned ? 1 : 0 },
      });
      return { runnerId: input.runnerId, returned: input.returned };
    }),

  /**
   * Start screen data: returns ZeroTime + all runners with start times
   * for the advance-time display at the start area.
   */
  startScreen: competitionProcedure.query(async ({ ctx }) => {
    const client = ctx.db;

    const zeroTime = await getZeroTime(client);

    // Get event name
    const event = await client.oEvent.findFirst({
      where: { Removed: false },
      select: { Name: true },
    });

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
          startTime: toAbsolute(r.StartTime, zeroTime),
          startNo: r.StartNo,
          status: r.Status,
        };
      }),
    };
  }),
});
