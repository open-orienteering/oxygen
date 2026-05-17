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
});
