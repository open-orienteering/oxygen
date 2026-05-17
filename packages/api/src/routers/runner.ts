import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router, eventProcedure } from "../trpc.js";
import { toAbsolute, nowMeosDate, nowMeosTime } from "../timeConvert.js";
import type { RunnerDetail, RunnerInfo } from "@oxygen/shared";
import {
  runnerStatusToValue,
  valueToRunnerStatus,
} from "../statusConvert.js";

/**
 * Runner router. All inputs/outputs use the per-event integer `seq` as the
 * public `id`; internal Prisma calls translate seq → UUID at the boundary.
 */

// ─── Helpers ───────────────────────────────────────────────

/** Normalize legacy YYYYMMDD birth-year encoding to plain YYYY. */
export function normalizeBirthYear(val: number): number {
  if (val > 9999) return Math.floor(val / 10000);
  return val;
}

/**
 * Resolve a runner by its per-event seq. Returns the row (incl. id UUID,
 * which is needed for Prisma writes), or throws NOT_FOUND.
 */
async function getRunnerBySeq(
  db: import("@prisma/client").PrismaClient,
  eventId: bigint,
  seq: number,
) {
  const r = await db.runner.findFirst({
    where: { eventId, seq, removed: false },
  });
  if (!r) {
    throw new TRPCError({ code: "NOT_FOUND", message: `Runner ${seq} not found` });
  }
  return r;
}

/** Resolve a class seq to its UUID. */
async function classSeqToId(
  db: import("@prisma/client").PrismaClient,
  eventId: bigint,
  seq: number,
): Promise<string> {
  const cls = await db.class.findFirst({
    where: { eventId, seq, removed: false },
    select: { id: true },
  });
  if (!cls) {
    throw new TRPCError({ code: "NOT_FOUND", message: `Class ${seq} not found` });
  }
  return cls.id;
}

/** Throw CONFLICT if `cardNo` is already used by another runner in this event. */
async function assertCardNotTaken(
  db: import("@prisma/client").PrismaClient,
  eventId: bigint,
  cardNo: number,
  excludeId?: string,
): Promise<void> {
  if (cardNo <= 0) return;
  const existing = await db.runner.findFirst({
    where: {
      eventId,
      cardNo,
      removed: false,
      ...(excludeId ? { id: { not: excludeId } } : {}),
    },
    select: { id: true, name: true, seq: true },
  });
  if (existing) {
    throw new TRPCError({
      code: "CONFLICT",
      message: `Card ${cardNo} is already assigned to ${existing.name} (runner #${existing.seq})`,
    });
  }
}

// ─── Schemas ───────────────────────────────────────────────

const runnerCreateSchema = z.object({
  name: z.string().min(1),
  cardNo: z.number().int().optional().default(0),
  clubName: z.string().optional().default(""),
  eventorClubId: z.number().int().optional(),
  classId: z.number().int(), // seq
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

const runnerUpdateSchema = z.object({
  name: z.string().min(1).optional(),
  cardNo: z.number().int().optional(),
  clubName: z.string().optional(),
  eventorClubId: z.number().int().nullable().optional(),
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
  cardReturned: z.boolean().optional(),
});

// ─── Router ────────────────────────────────────────────────

export const runnerRouter = router({
  getById: eventProcedure
    .input(z.object({ id: z.number().int() }))
    .query(async ({ ctx, input }): Promise<RunnerDetail> => {
      const r = await getRunnerBySeq(ctx.db, ctx.event.id, input.id);
      const zeroTime = ctx.event.zeroTime;

      const cls = r.classId
        ? await ctx.db.class.findUnique({
            where: { id: r.classId },
            select: { name: true, seq: true },
          })
        : null;

      const event = await ctx.db.event.findUnique({
        where: { id: ctx.event.id },
        select: { cardFeeCents: true },
      });
      const baseFee = event?.cardFeeCents ?? 0;
      const resolvedCardFee =
        r.cardFeeCents === 0
          ? 0
          : r.cardFeeCents > 0
            ? r.cardFeeCents
            : baseFee > 0
              ? baseFee
              : r.cardFeeCents;

      return {
        id: r.seq,
        name: r.name,
        cardNo: r.cardNo,
        clubId: r.eventorClubId ? Number(r.eventorClubId) : 0,
        clubName: r.clubName,
        classId: cls?.seq ?? 0,
        className: cls?.name ?? "",
        startNo: r.startNo,
        startTime: toAbsolute(r.startTime, zeroTime),
        finishTime: toAbsolute(r.finishTime, zeroTime),
        status: runnerStatusToValue(r.status),
        birthYear: normalizeBirthYear(r.birthYear),
        sex: r.sex,
        nationality: r.nationality,
        phone: r.phone,
        fee: r.feeCents,
        paid: r.paidCents,
        payMode: r.payMode,
        cardFee: resolvedCardFee,
        cardReturned: r.cardReturned,
        bib: r.bib,
        entryDate: r.entryDate,
        transferFlags: r.transferFlags,
      };
    }),

  findByCard: eventProcedure
    .input(z.object({ cardNo: z.number().int() }))
    .query(async ({ ctx, input }) => {
      if (input.cardNo <= 0) return null;
      const r = await ctx.db.runner.findFirst({
        where: { eventId: ctx.event.id, cardNo: input.cardNo, removed: false },
      });
      if (!r) return null;
      const zeroTime = ctx.event.zeroTime;
      const cls = r.classId
        ? await ctx.db.class.findUnique({
            where: { id: r.classId },
            select: { name: true, seq: true },
          })
        : null;
      return {
        id: r.seq,
        name: r.name,
        cardNo: r.cardNo,
        clubId: r.eventorClubId ? Number(r.eventorClubId) : 0,
        clubName: r.clubName,
        classId: cls?.seq ?? 0,
        className: cls?.name ?? "",
        startTime: toAbsolute(r.startTime, zeroTime),
        finishTime: toAbsolute(r.finishTime, zeroTime),
        status: runnerStatusToValue(r.status),
      };
    }),

  list: eventProcedure
    .input(
      z
        .object({
          classId: z.number().int().optional(),
          eventorClubId: z.number().int().optional(),
          search: z.string().optional(),
          statusFilter: z.string().optional(),
        })
        .optional(),
    )
    .query(async ({ ctx, input }): Promise<RunnerInfo[]> => {
      const eventId = ctx.event.id;
      const zeroTime = ctx.event.zeroTime;

      const where: Record<string, unknown> = { eventId, removed: false };
      if (input?.classId) {
        const cls = await ctx.db.class.findFirst({
          where: { eventId, seq: input.classId },
          select: { id: true },
        });
        if (!cls) return [];
        where.classId = cls.id;
      }
      if (input?.eventorClubId) where.eventorClubId = input.eventorClubId;
      if (input?.search) {
        const s = input.search.trim();
        where.OR = [
          { name: { contains: s, mode: "insensitive" } },
          { clubName: { contains: s, mode: "insensitive" } },
          ...(/^\d+$/.test(s)
            ? [{ cardNo: { equals: parseInt(s, 10) } }]
            : []),
        ];
      }

      const runners = await ctx.db.runner.findMany({
        where,
        include: { class: { select: { name: true, seq: true } } },
        orderBy: [{ class: { sortIndex: "asc" } }, { startNo: "asc" }],
      });

      const now = new Date();
      const meosNow =
        (now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds()) * 10;

      const punchCards = await ctx.db.punch.groupBy({
        by: ["cardNo"],
        where: { eventId, removed: false },
      });
      const punchCardNos = new Set(punchCards.map((p) => p.cardNo));

      const sf = input?.statusFilter;
      const filtered = sf
        ? runners.filter((r) => {
            const status = runnerStatusToValue(r.status);
            const hasPunches = punchCardNos.has(r.cardNo);
            const hasStartedByTime =
              r.startTime > 0 &&
              (r.startTime <= 1 ||
                meosNow >= toAbsolute(r.startTime, zeroTime));
            const finished =
              status === 1 ||
              status === 3 ||
              status === 4 ||
              status === 5 ||
              status === 6 ||
              (status === 0 && r.finishTime > 0);
            if (sf === "not-started")
              return !finished && !hasPunches && !hasStartedByTime;
            if (sf === "in-forest")
              return !finished && (hasPunches || hasStartedByTime);
            if (sf === "finished") return finished;
            const n = parseInt(sf, 10);
            if (!isNaN(n)) return status === n;
            return true;
          })
        : runners;

      return filtered.map(
        (r): RunnerInfo => ({
          id: r.seq,
          name: r.name,
          cardNo: r.cardNo,
          clubId: r.eventorClubId ? Number(r.eventorClubId) : 0,
          clubName: r.clubName,
          classId: r.class?.seq ?? 0,
          className: r.class?.name ?? "",
          startNo: r.startNo,
          startTime: toAbsolute(r.startTime, zeroTime),
          finishTime: toAbsolute(r.finishTime, zeroTime),
          status: runnerStatusToValue(r.status),
          fee: r.feeCents,
          paid: r.paidCents,
          payMode: r.payMode,
          cardFee: r.cardFeeCents,
          cardReturned: r.cardReturned,
          birthYear: normalizeBirthYear(r.birthYear),
          sex: r.sex,
          bib: r.bib,
          transferFlags: r.transferFlags,
        }),
      );
    }),

  create: eventProcedure
    .input(runnerCreateSchema)
    .mutation(async ({ ctx, input }) => {
      await assertCardNotTaken(ctx.db, ctx.event.id, input.cardNo);
      const classUuid = await classSeqToId(ctx.db, ctx.event.id, input.classId);

      const created = await ctx.db.runner.create({
        data: {
          eventId: ctx.event.id,
          name: input.name,
          cardNo: input.cardNo,
          clubName: input.clubName,
          eventorClubId: input.eventorClubId ?? null,
          classId: classUuid,
          startNo: input.startNo,
          startTime: input.startTime,
          birthYear: input.birthYear,
          sex: input.sex,
          nationality: input.nationality,
          phone: input.phone,
          ...(input.status != null
            ? { status: valueToRunnerStatus(input.status) }
            : {}),
          ...(input.finishTime != null ? { finishTime: input.finishTime } : {}),
          feeCents: input.fee,
          paidCents: input.paid,
          payMode: input.payMode,
          cardFeeCents: input.cardFee,
          entryDate: nowMeosDate(),
          entryTime: nowMeosTime(),
        },
        select: { id: true, seq: true },
      });
      return { id: created.seq };
    }),

  update: eventProcedure
    .input(z.object({ id: z.number().int() }).extend(runnerUpdateSchema.shape))
    .mutation(async ({ ctx, input }) => {
      const r = await getRunnerBySeq(ctx.db, ctx.event.id, input.id);
      if (input.cardNo != null && input.cardNo !== r.cardNo) {
        await assertCardNotTaken(ctx.db, ctx.event.id, input.cardNo, r.id);
      }
      const data: Record<string, unknown> = {};
      if (input.name !== undefined) data.name = input.name;
      if (input.cardNo !== undefined) data.cardNo = input.cardNo;
      if (input.clubName !== undefined) data.clubName = input.clubName;
      if (input.eventorClubId !== undefined)
        data.eventorClubId = input.eventorClubId;
      if (input.classId !== undefined) {
        data.classId = await classSeqToId(ctx.db, ctx.event.id, input.classId);
      }
      if (input.startNo !== undefined) data.startNo = input.startNo;
      if (input.startTime !== undefined) data.startTime = input.startTime;
      if (input.birthYear !== undefined) data.birthYear = input.birthYear;
      if (input.sex !== undefined) data.sex = input.sex;
      if (input.nationality !== undefined) data.nationality = input.nationality;
      if (input.phone !== undefined) data.phone = input.phone;
      if (input.status !== undefined)
        data.status = valueToRunnerStatus(input.status);
      if (input.finishTime !== undefined) data.finishTime = input.finishTime;
      if (input.fee !== undefined) data.feeCents = input.fee;
      if (input.paid !== undefined) data.paidCents = input.paid;
      if (input.payMode !== undefined) data.payMode = input.payMode;
      if (input.cardFee !== undefined) data.cardFeeCents = input.cardFee;
      if (input.cardReturned !== undefined) data.cardReturned = input.cardReturned;

      await ctx.db.runner.update({ where: { id: r.id }, data });
      return { ok: true };
    }),

  /** Soft-delete a runner. */
  delete: eventProcedure
    .input(z.object({ id: z.number().int() }))
    .mutation(async ({ ctx, input }) => {
      const r = await getRunnerBySeq(ctx.db, ctx.event.id, input.id);
      await ctx.db.runner.update({
        where: { id: r.id },
        data: { removed: true },
      });
      return { ok: true };
    }),

  /** Mark several runners as DNS at once. */
  bulkDns: eventProcedure
    .input(z.object({ ids: z.array(z.number().int()) }))
    .mutation(async ({ ctx, input }) => {
      const rows = await ctx.db.runner.findMany({
        where: {
          eventId: ctx.event.id,
          seq: { in: input.ids },
          removed: false,
        },
        select: { id: true },
      });
      await ctx.db.runner.updateMany({
        where: { id: { in: rows.map((r) => r.id) } },
        data: { status: "dns" },
      });
      return { ok: true, count: rows.length };
    }),
});
