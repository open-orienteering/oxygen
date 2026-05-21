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

  /**
   * Update a runner.
   *
   * Accepts either a flat shape (`{ id, name?, cardNo?, ... }`) or the
   * legacy `{ id, data: { ... } }` wrapper that RunnerInlineDetail
   * still uses. Field semantics:
   *   - `clubId` (legacy): eventor club id — resolved server-side to
   *     `eventorClubId` + a `clubName` looked up from the directory.
   *   - `clubName`: free-text club (sent when there's no Eventor link).
   *   - `eventorClubId`: explicit Eventor club id (preferred new shape).
   */
  update: eventProcedure
    .input(
      z.object({
        id: z.number().int(),
        ...runnerUpdateSchema.shape,
        clubId: z.number().int().nullable().optional(),
        data: runnerUpdateSchema
          .extend({ clubId: z.number().int().nullable().optional() })
          .partial()
          .optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const r = await getRunnerBySeq(ctx.db, ctx.event.id, input.id);
      // Merge legacy `data: { ... }` wrapper with the flat shape.
      const fields = { ...input, ...(input.data ?? {}) } as Record<
        string,
        unknown
      >;
      const get = <T>(k: string): T | undefined =>
        (fields[k] === undefined ? undefined : (fields[k] as T));

      const cardNo = get<number>("cardNo");
      if (cardNo != null && cardNo !== r.cardNo) {
        await assertCardNotTaken(ctx.db, ctx.event.id, cardNo, r.id);
      }

      const data: Record<string, unknown> = {};
      if (get<string>("name") !== undefined) data.name = get<string>("name");
      if (cardNo !== undefined) data.cardNo = cardNo;
      if (get<string>("clubName") !== undefined)
        data.clubName = get<string>("clubName");
      if (fields.eventorClubId !== undefined)
        data.eventorClubId = fields.eventorClubId;
      // Legacy clubId → eventorClubId + (best-effort) clubName.
      if (fields.clubId !== undefined) {
        const cid = fields.clubId as number | null;
        if (cid && cid > 0) {
          data.eventorClubId = BigInt(cid);
          const dir = await ctx.db.clubDirectory.findUnique({
            where: { eventorId: BigInt(cid) },
            select: { name: true },
          });
          if (dir?.name) data.clubName = dir.name;
        } else {
          data.eventorClubId = null;
          data.clubName = "";
        }
      }
      if (get<number>("classId") !== undefined) {
        data.classId = await classSeqToId(
          ctx.db,
          ctx.event.id,
          get<number>("classId")!,
        );
      }
      if (get<number>("startNo") !== undefined) data.startNo = get<number>("startNo");
      if (get<number>("startTime") !== undefined)
        data.startTime = get<number>("startTime");
      if (get<number>("birthYear") !== undefined)
        data.birthYear = get<number>("birthYear");
      if (get<string>("sex") !== undefined) data.sex = get<string>("sex");
      if (get<string>("nationality") !== undefined)
        data.nationality = get<string>("nationality");
      if (get<string>("phone") !== undefined) data.phone = get<string>("phone");
      if (get<number>("status") !== undefined)
        data.status = valueToRunnerStatus(get<number>("status")!);
      if (get<number>("finishTime") !== undefined)
        data.finishTime = get<number>("finishTime");
      if (get<number>("fee") !== undefined) data.feeCents = get<number>("fee");
      if (get<number>("paid") !== undefined) data.paidCents = get<number>("paid");
      if (get<number>("payMode") !== undefined) data.payMode = get<number>("payMode");
      if (get<number>("cardFee") !== undefined)
        data.cardFeeCents = get<number>("cardFee");
      if (get<boolean>("cardReturned") !== undefined)
        data.cardReturned = get<boolean>("cardReturned");

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

  /** Apply the same change to many runners at once. */
  bulkUpdate: eventProcedure
    .input(
      z.object({
        ids: z.array(z.number().int()),
        classId: z.number().int().optional(),
        clubName: z.string().optional(),
        eventorClubId: z.number().int().nullable().optional(),
        status: z.number().int().optional(),
        startTime: z.number().int().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const rows = await ctx.db.runner.findMany({
        where: {
          eventId: ctx.event.id,
          seq: { in: input.ids },
          removed: false,
        },
        select: { id: true },
      });
      const data: Record<string, unknown> = {};
      if (input.classId !== undefined) {
        data.classId = await classSeqToId(ctx.db, ctx.event.id, input.classId);
      }
      if (input.clubName !== undefined) data.clubName = input.clubName;
      if (input.eventorClubId !== undefined)
        data.eventorClubId = input.eventorClubId;
      if (input.status !== undefined)
        data.status = valueToRunnerStatus(input.status);
      if (input.startTime !== undefined) data.startTime = input.startTime;
      await ctx.db.runner.updateMany({
        where: { id: { in: rows.map((r) => r.id) } },
        data,
      });
      return { ok: true as const, count: rows.length };
    }),

  /** Toggle the rental-card-returned flag. Accepts `id` or `runnerId`. */
  setCardReturned: eventProcedure
    .input(
      z
        .object({
          id: z.number().int().optional(),
          runnerId: z.number().int().optional(),
          returned: z.boolean(),
        })
        .refine((x) => (x.id ?? x.runnerId) != null, {
          message: "id or runnerId required",
        }),
    )
    .mutation(async ({ ctx, input }) => {
      const seq = input.id ?? input.runnerId!;
      const r = await getRunnerBySeq(ctx.db, ctx.event.id, seq);
      await ctx.db.runner.update({
        where: { id: r.id },
        data: { cardReturned: input.returned },
      });
      return { ok: true as const };
    }),
});
