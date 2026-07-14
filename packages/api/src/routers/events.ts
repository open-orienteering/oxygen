/**
 * Journal ingestion router (was the offline event-log router).
 *
 * Clients push journal entries while online or offline; the outbox drains here
 * when connectivity returns. Each entry is applied idempotently — a duplicate
 * `id` is silently skipped.
 *
 * Entries are applied over Postgres via Prisma. Race-state entries resolve the
 * runner by `(eventId, cardNo)` so an offline-created runner can be matched
 * before a `seq` has been assigned; cardless / manual entries fall back to the
 * `seq` (`runnerId`). The wire fields `hlc`, `schemaVersion` and `actorId` are
 * optional, so a legacy client that predates them keeps working byte-for-byte
 * — `resolveHlc` synthesises an HLC from the wall-clock `timestamp` when none
 * is sent.
 *
 * The receiving node is the single serialization point for its writes (see the
 * per-event lease in docs/offline-architecture.md), so the per-type
 * arrival-order guards below are sufficient; append-only types (`card.read`,
 * `punch.recorded`) are guarded by dedupe keys instead and apply anywhere.
 * This endpoint doubles as the node-to-node journal-shipping sink (pivot
 * Step 3 in docs/future-architecture.md).
 */

import { z } from "zod";
import { router, eventProcedure } from "../trpc.js";
import { toRelative } from "../timeConvert.js";
import {
  encodeHlc,
  resolveHlc,
  cardReadIsDuplicate,
  CARD_READ_DEDUPE_WINDOW_MS,
  meosFromVolts,
} from "@oxygen/shared";
import { storeReadoutImpl } from "./cardReadout.js";
import type { PrismaClient } from "@prisma/client";

const eventPayloadSchema = z.object({
  id: z.string().uuid(),
  type: z.enum([
    "card.read",
    "finish.recorded",
    "result.applied",
    "start.recorded",
    "runner.registered",
    "runner.updated",
    "punch.recorded",
  ]),
  competitionId: z.string(),
  stationId: z.string(),
  timestamp: z.number(),
  // Offline-first additions — all optional so legacy clients keep working.
  hlc: z.object({ physical: z.number(), logical: z.number() }).optional(),
  schemaVersion: z.number().int().optional(),
  actorId: z.string().uuid().nullable().optional(),
  payload: z.record(z.string(), z.unknown()),
});

export const eventsRouter = router({
  push: eventProcedure
    .input(z.object({ events: z.array(eventPayloadSchema) }))
    .mutation(async ({ ctx, input }) => {
      const synced: string[] = [];
      const failed: Array<{ id: string; error: string }> = [];

      for (const event of input.events) {
        try {
          // Idempotency check — same UUID returns success.
          const existing = await ctx.db.journalEntry.findUnique({
            where: { id: event.id },
            select: { id: true },
          });
          if (existing) {
            synced.push(event.id);
            continue;
          }

          await applyEvent(ctx.db, ctx.event.id, ctx.event.zeroTime, event);

          const hlc = encodeHlc(
            resolveHlc({
              id: event.id,
              stationId: event.stationId,
              timestamp: event.timestamp,
              hlc: event.hlc,
            }),
          );

          await ctx.db.journalEntry.create({
            data: {
              id: event.id,
              eventId: ctx.event.id,
              type: event.type,
              stationId: event.stationId,
              actorId: event.actorId ?? null,
              hlc,
              schemaVersion: event.schemaVersion ?? 1,
              clientTimestamp: new Date(event.timestamp),
              payload: event.payload as never,
            },
          });

          synced.push(event.id);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.error(
            `[events.push] Failed to apply entry ${event.id} (${event.type}):`,
            message,
          );
          failed.push({ id: event.id, error: message });
        }
      }

      // serverTimeMs lets the client detect a skewed local clock (see the
      // clock-skew banner). It is the cloud's wall clock at response time.
      return { synced, failed, serverTimeMs: Date.now() };
    }),
});

interface OfflineEvent {
  id: string;
  type: string;
  stationId: string;
  timestamp: number;
  payload: Record<string, unknown>;
}

/**
 * Resolve the runner a race-state entry refers to.
 *
 * Primary key is `(eventId, cardNo)` — robust to offline-created runners that
 * have no `seq` yet. Falls back to `seq` (`runnerId`) for cardless / manual
 * entries. Returns the active (non-removed) runner, or null.
 */
async function resolveRunner(
  db: PrismaClient,
  eventId: bigint,
  payload: Record<string, unknown>,
): Promise<{ id: string; finishTime: number } | null> {
  const cardNo =
    typeof payload.cardNo === "number" && payload.cardNo > 0
      ? payload.cardNo
      : null;
  if (cardNo != null) {
    const byCard = await db.runner.findFirst({
      where: { eventId, cardNo, removed: false },
      select: { id: true, finishTime: true },
    });
    if (byCard) return byCard;
  }

  const seq =
    typeof payload.runnerId === "number" && payload.runnerId > 0
      ? payload.runnerId
      : null;
  if (seq != null) {
    return db.runner.findFirst({
      where: { eventId, seq, removed: false },
      select: { id: true, finishTime: true },
    });
  }

  return null;
}

async function applyEvent(
  db: PrismaClient,
  eventId: bigint,
  zeroTime: number,
  event: OfflineEvent,
) {
  switch (event.type) {
    case "finish.recorded": {
      const { finishTime } = event.payload as { finishTime: number };
      const runner = await resolveRunner(db, eventId, event.payload);
      // First non-zero finish wins (a runner crosses the line once).
      if (runner && runner.finishTime === 0) {
        await db.runner.update({
          where: { id: runner.id },
          data: {
            finishTime: toRelative(finishTime, zeroTime),
            status: "ok",
          },
        });
      }
      break;
    }

    case "result.applied": {
      const { status, finishTime, startTime } = event.payload as {
        status: number;
        finishTime: number;
        startTime: number;
      };
      const runner = await resolveRunner(db, eventId, event.payload);
      if (runner) {
        await db.runner.update({
          where: { id: runner.id },
          data: {
            finishTime: toRelative(finishTime, zeroTime),
            startTime: toRelative(startTime, zeroTime),
            status:
              status === 1
                ? "ok"
                : status === 3
                  ? "missing_punch"
                  : status === 4
                    ? "dnf"
                    : "unknown",
          },
        });
      }
      break;
    }

    case "start.recorded": {
      const { startTime } = event.payload as { startTime: number };
      const runner = await resolveRunner(db, eventId, event.payload);
      if (runner) {
        await db.runner.update({
          where: { id: runner.id },
          data: { startTime: toRelative(startTime, zeroTime) },
        });
      }
      break;
    }

    case "runner.registered": {
      const { name, classId, eventorClubId, clubName, cardNo, startTime } =
        event.payload as {
          name: string;
          classId: number;
          eventorClubId?: number;
          clubName?: string;
          cardNo?: number;
          startTime?: number;
        };
      // 0 (legacy sentinel) or absent → NULL (no card).
      const card = typeof cardNo === "number" && cardNo > 0 ? cardNo : null;
      // Dedupe by (eventId, cardNo) — one card per event.
      const existing =
        card != null
          ? await db.runner.findFirst({
              where: { eventId, cardNo: card, removed: false },
              select: { id: true },
            })
          : null;
      if (!existing) {
        const cls = await db.class.findFirst({
          where: { eventId, seq: classId, removed: false },
          select: { id: true },
        });
        if (cls) {
          await db.runner.create({
            data: {
              eventId,
              name,
              classId: cls.id,
              clubName: clubName ?? "",
              eventorClubId: eventorClubId ?? null,
              cardNo: card,
              startTime: startTime ? toRelative(startTime, zeroTime) : 0,
            },
          });
        }
      }
      break;
    }

    case "punch.recorded": {
      const { cardNo, controlCode, time } = event.payload as {
        cardNo: number;
        controlCode: number;
        time: number;
      };
      await db.punch.create({
        data: {
          eventId,
          cardNo,
          controlCode,
          time: toRelative(time, zeroTime),
          source: "card",
        },
      });
      break;
    }

    case "card.read": {
      const p = event.payload as {
        cardNo: number;
        punches?: Array<{ controlCode: number; time: number }>;
        checkTime?: number;
        startTime?: number;
        finishTime?: number;
        cardType?: string;
        /** Volts (straight from the SI card) — storage wants integer mV. */
        batteryVoltage?: number;
        punchesFresh?: boolean;
        ownerData?: Record<string, unknown>;
        metadata?: Record<string, unknown>;
      };
      // Dedupe: two reads of the same card within the window are one logical
      // readout (SI cards get re-read; stations can race the drain). The
      // entry stays in the journal either way — this guards the apply only.
      const windowStart = new Date(
        event.timestamp - CARD_READ_DEDUPE_WINDOW_MS,
      );
      const windowEnd = new Date(event.timestamp + CARD_READ_DEDUPE_WINDOW_MS);
      const nearby = await db.cardReadout.findMany({
        where: {
          eventId,
          cardNo: p.cardNo,
          readAt: { gte: windowStart, lte: windowEnd },
        },
        select: { cardNo: true, readAt: true },
      });
      if (
        cardReadIsDuplicate(
          nearby.map((r) => ({ cardNo: r.cardNo, timestamp: r.readAt.getTime() })),
          p.cardNo,
          event.timestamp,
        )
      ) {
        break;
      }
      // Same pipeline as an online storeReadout / backup replay. Payload
      // times are absolute deciseconds (the outbox converts at emit);
      // readAt preserves the original offline read time.
      await storeReadoutImpl(db, eventId, zeroTime, {
        cardNo: p.cardNo,
        cardType: p.cardType ?? "",
        punches: p.punches ?? [],
        checkTime: p.checkTime ?? null,
        startTime: p.startTime ?? null,
        finishTime: p.finishTime ?? null,
        voltageMv: meosFromVolts(p.batteryVoltage) ?? 0,
        punchesFresh: p.punchesFresh,
        ownerData: p.ownerData,
        metadata: p.metadata,
        stationId: event.stationId,
        readAt: new Date(event.timestamp).toISOString(),
      });
      break;
    }
  }
}
