/**
 * Card readout router — stores raw card readouts, links them to runners,
 * and produces a result. This is a deliberately minimal port of the
 * original 972-line module; the full punch-matching pipeline is being
 * incrementally re-implemented against the new schema.
 *
 * Today this file:
 *   - Records each card readout into the immutable `card_readouts` table.
 *   - Creates / updates a `cards` row and links it to the runner with the
 *     matching `card_no` (if any).
 *   - Returns minimal per-call info so the kiosk / start-station UI can
 *     render a placeholder readout panel.
 *
 * TODO (follow-up): port `performReadout`, `parsePunches`,
 * `computeReadId`, `matchPunchesToCourse` against the new schema with
 * full course matching and running-time adjustments. The shared
 * `@oxygen/shared` helpers already do most of the work; we just need to
 * wire them in.
 */

import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router, eventProcedure } from "../trpc.js";
import type { PrismaClient } from "@prisma/client";

// Re-exports kept for backwards compatibility with code that still imports
// them from this file. They now point at the shared helpers.
export {
  parsePunches,
  computeReadId,
  computeMatchScore,
  parseCourseControls,
  matchPunchesToCourse,
  computeStatus,
  PUNCH_START,
  PUNCH_FINISH,
  PUNCH_CHECK,
  type ParsedPunch,
  type ControlMatch,
} from "@oxygen/shared";

/**
 * Minimal placeholder used by other routers (e.g. race.recordFinish,
 * events.applyCardRead) that previously called `performReadout`.
 * Returns `null` when no runner matches the card; the full match is
 * deferred until the readout pipeline is re-implemented.
 */
export async function performReadout(
  _db: PrismaClient,
  _runnerId: string | bigint,
): Promise<null> {
  return null;
}

const storeReadoutInput = z.object({
  cardNo: z.number().int().positive(),
  cardType: z.string().optional().default(""),
  punches: z.array(
    z.object({
      code: z.number().int(),
      time: z.number().int(),
      subSecond: z.number().int().optional(),
      unit: z.number().int().optional(),
    }),
  ),
  voltageMv: z.number().int().optional().default(0),
  batteryLow: z.boolean().optional(),
  ownerData: z.record(z.string(), z.unknown()).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  stationId: z.string().optional(),
});

export const cardReadoutRouter = router({
  /** Store a raw card readout and link it to a runner if cardNo matches. */
  storeReadout: eventProcedure
    .input(storeReadoutInput)
    .mutation(async ({ ctx, input }) => {
      const readout = await ctx.db.cardReadout.create({
        data: {
          eventId: ctx.event.id,
          cardNo: input.cardNo,
          cardType: input.cardType,
          punches: input.punches,
          voltageMv: input.voltageMv,
          batteryLow: input.batteryLow,
          ownerData: (input.ownerData ?? undefined) as never,
          metadata: (input.metadata ?? undefined) as never,
          stationId: input.stationId,
        },
        select: { id: true, readAt: true },
      });

      // Upsert a Cards row keyed by (event_id, card_no).
      const existing = await ctx.db.card.findFirst({
        where: { eventId: ctx.event.id, cardNo: input.cardNo, removed: false },
      });
      const punchesRaw = input.punches
        .map((p) => `${p.code}-${p.time}`)
        .join(";");
      const card = existing
        ? await ctx.db.card.update({
            where: { id: existing.id },
            data: {
              readoutId: readout.id,
              readCount: existing.readCount + 1,
              voltageMv: input.voltageMv,
              punchesRaw,
            },
            select: { id: true, seq: true },
          })
        : await ctx.db.card.create({
            data: {
              eventId: ctx.event.id,
              cardNo: input.cardNo,
              readoutId: readout.id,
              readCount: 1,
              voltageMv: input.voltageMv,
              punchesRaw,
            },
            select: { id: true, seq: true },
          });

      // Link the card to a runner with the matching number.
      const runner = await ctx.db.runner.findFirst({
        where: { eventId: ctx.event.id, cardNo: input.cardNo, removed: false },
        select: { id: true, seq: true },
      });
      if (runner) {
        await ctx.db.runner.update({
          where: { id: runner.id },
          data: { cardId: card.id },
        });
      }

      return {
        readoutId: readout.id,
        cardId: card.seq,
        readAt: readout.readAt.toISOString(),
        linkedRunnerId: runner?.seq ?? null,
      };
    }),

  /** History of recent card readouts for the active event. */
  recent: eventProcedure
    .input(z.object({ limit: z.number().int().min(1).max(500).default(50) }).optional())
    .query(async ({ ctx, input }) => {
      const rows = await ctx.db.cardReadout.findMany({
        where: { eventId: ctx.event.id },
        orderBy: { readAt: "desc" },
        take: input?.limit ?? 50,
      });
      return rows.map((r) => ({
        id: r.id,
        cardNo: r.cardNo,
        cardType: r.cardType,
        voltageMv: r.voltageMv,
        readAt: r.readAt.toISOString(),
        stationId: r.stationId,
      }));
    }),

  /** Look up a stored readout by id (UUID). */
  getById: eventProcedure
    .input(z.object({ id: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const r = await ctx.db.cardReadout.findUnique({ where: { id: input.id } });
      if (!r || r.eventId !== ctx.event.id) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Readout not found" });
      }
      return {
        id: r.id,
        cardNo: r.cardNo,
        cardType: r.cardType,
        punches: r.punches,
        voltageMv: r.voltageMv,
        readAt: r.readAt.toISOString(),
      };
    }),

  /** Most recent readout for a given card number. */
  readout: eventProcedure
    .input(z.object({ cardNo: z.number().int() }))
    .query(async ({ ctx, input }) => {
      const r = await ctx.db.cardReadout.findFirst({
        where: { eventId: ctx.event.id, cardNo: input.cardNo },
        orderBy: { readAt: "desc" },
      });
      if (!r) return null;
      return {
        id: r.id,
        cardNo: r.cardNo,
        cardType: r.cardType,
        punches: r.punches,
        voltageMv: r.voltageMv,
        readAt: r.readAt.toISOString(),
      };
    }),

  /** Most recent readout for a runner (resolved via card_no). */
  readoutByRunner: eventProcedure
    .input(z.object({ runnerId: z.number().int() }))
    .query(async ({ ctx, input }) => {
      const runner = await ctx.db.runner.findFirst({
        where: { eventId: ctx.event.id, seq: input.runnerId, removed: false },
        select: { cardNo: true },
      });
      if (!runner || runner.cardNo <= 0) return null;
      const r = await ctx.db.cardReadout.findFirst({
        where: { eventId: ctx.event.id, cardNo: runner.cardNo },
        orderBy: { readAt: "desc" },
      });
      if (!r) return null;
      return {
        id: r.id,
        cardNo: r.cardNo,
        cardType: r.cardType,
        punches: r.punches,
        voltageMv: r.voltageMv,
        readAt: r.readAt.toISOString(),
      };
    }),

  /** All known cards for the event (one row per card_no). */
  cardList: eventProcedure.query(async ({ ctx }) => {
    const cards = await ctx.db.card.findMany({
      where: { eventId: ctx.event.id, removed: false },
      orderBy: { cardNo: "asc" },
    });
    const cardNos = cards.map((c) => c.cardNo);
    const runners = cardNos.length
      ? await ctx.db.runner.findMany({
          where: {
            eventId: ctx.event.id,
            cardNo: { in: cardNos },
            removed: false,
          },
          select: {
            seq: true,
            cardNo: true,
            name: true,
            clubName: true,
            eventorClubId: true,
            class: { select: { name: true } },
          },
        })
      : [];
    const runnerByCard = new Map(runners.map((r) => [r.cardNo, r]));
    return cards.map((c) => {
      const r = runnerByCard.get(c.cardNo);
      return {
        id: c.seq,
        cardNo: c.cardNo,
        voltageMv: c.voltageMv,
        readCount: c.readCount,
        runnerId: r?.seq ?? null,
        runnerName: r?.name ?? "",
        className: r?.class?.name ?? "",
        clubName: r?.clubName ?? "",
      };
    });
  }),

  /** Full detail for a card (most recent readout + linked runner). */
  cardDetail: eventProcedure
    .input(z.object({ cardNo: z.number().int() }))
    .query(async ({ ctx, input }) => {
      const card = await ctx.db.card.findFirst({
        where: { eventId: ctx.event.id, cardNo: input.cardNo, removed: false },
      });
      const runner = await ctx.db.runner.findFirst({
        where: {
          eventId: ctx.event.id,
          cardNo: input.cardNo,
          removed: false,
        },
        select: {
          seq: true,
          name: true,
          clubName: true,
          eventorClubId: true,
          class: { select: { name: true } },
        },
      });
      const latestReadout = await ctx.db.cardReadout.findFirst({
        where: { eventId: ctx.event.id, cardNo: input.cardNo },
        orderBy: { readAt: "desc" },
      });
      return {
        cardNo: input.cardNo,
        card: card
          ? {
              id: card.seq,
              voltageMv: card.voltageMv,
              readCount: card.readCount,
            }
          : null,
        runner: runner
          ? {
              id: runner.seq,
              name: runner.name,
              className: runner.class?.name ?? "",
              clubName: runner.clubName,
            }
          : null,
        latestReadout: latestReadout
          ? {
              id: latestReadout.id,
              cardType: latestReadout.cardType,
              punches: latestReadout.punches,
              voltageMv: latestReadout.voltageMv,
              readAt: latestReadout.readAt.toISOString(),
            }
          : null,
      };
    }),

  /** History of every readout for a card. */
  readoutHistory: eventProcedure
    .input(z.object({ cardNo: z.number().int() }))
    .query(async ({ ctx, input }) => {
      const rows = await ctx.db.cardReadout.findMany({
        where: { eventId: ctx.event.id, cardNo: input.cardNo },
        orderBy: { readAt: "desc" },
        take: 100,
      });
      return rows.map((r) => ({
        id: r.id,
        cardType: r.cardType,
        voltageMv: r.voltageMv,
        readAt: r.readAt.toISOString(),
        stationId: r.stationId,
      }));
    }),

  /** Link a card to a runner manually. */
  linkCardToRunner: eventProcedure
    .input(z.object({ cardNo: z.number().int(), runnerId: z.number().int() }))
    .mutation(async ({ ctx, input }) => {
      const runner = await ctx.db.runner.findFirst({
        where: { eventId: ctx.event.id, seq: input.runnerId, removed: false },
        select: { id: true },
      });
      if (!runner) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Runner not found" });
      }
      const card = await ctx.db.card.findFirst({
        where: { eventId: ctx.event.id, cardNo: input.cardNo, removed: false },
        select: { id: true },
      });
      await ctx.db.runner.update({
        where: { id: runner.id },
        data: { cardNo: input.cardNo, cardId: card?.id ?? null },
      });
      return { ok: true as const };
    }),

  /** Append a free punch to a card. */
  addPunch: eventProcedure
    .input(
      z.object({
        cardNo: z.number().int(),
        controlCode: z.number().int(),
        time: z.number().int(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const control = await ctx.db.control.findFirst({
        where: {
          eventId: ctx.event.id,
          codes: { contains: String(input.controlCode) },
          removed: false,
        },
        select: { id: true },
      });
      await ctx.db.punch.create({
        data: {
          eventId: ctx.event.id,
          cardNo: input.cardNo,
          controlCode: input.controlCode,
          controlId: control?.id ?? null,
          time: input.time,
          source: "manual",
          isOriginal: false,
        },
      });
      return { ok: true as const };
    }),

  /** Remove a free punch by id (UUID). */
  removePunch: eventProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      await ctx.db.punch.update({
        where: { id: input.id },
        data: { removed: true },
      });
      return { ok: true as const };
    }),

  /** Adjust the time on an existing free punch. */
  updatePunchTime: eventProcedure
    .input(z.object({ id: z.string().uuid(), time: z.number().int() }))
    .mutation(async ({ ctx, input }) => {
      await ctx.db.punch.update({
        where: { id: input.id },
        data: { time: input.time, isOriginal: false },
      });
      return { ok: true as const };
    }),
});
