/**
 * Offline operational event-log router (formerly oxygen_events).
 *
 * Clients push events while online or offline; the queue is drained to
 * this endpoint when connectivity returns. Each event is applied
 * idempotently — duplicate IDs are silently skipped.
 */

import { z } from "zod";
import { router, eventProcedure } from "../trpc.js";
import { toRelative } from "../timeConvert.js";
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
          const existing = await ctx.db.eventLogEntry.findUnique({
            where: { id: event.id },
            select: { id: true },
          });
          if (existing) {
            synced.push(event.id);
            continue;
          }

          await applyEvent(ctx.db, ctx.event.id, ctx.event.zeroTime, event);

          await ctx.db.eventLogEntry.create({
            data: {
              id: event.id,
              eventId: ctx.event.id,
              type: event.type,
              stationId: event.stationId,
              clientTimestamp: new Date(event.timestamp),
              payload: event.payload as never,
            },
          });

          synced.push(event.id);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.error(
            `[events.push] Failed to apply event ${event.id} (${event.type}):`,
            message,
          );
          failed.push({ id: event.id, error: message });
        }
      }

      return { synced, failed };
    }),
});

interface OfflineEvent {
  id: string;
  type: string;
  payload: Record<string, unknown>;
}

async function applyEvent(
  db: PrismaClient,
  eventId: bigint,
  zeroTime: number,
  event: OfflineEvent,
) {
  switch (event.type) {
    case "finish.recorded": {
      const { runnerId, finishTime } = event.payload as {
        runnerId: number;
        finishTime: number;
      };
      const runner = await db.runner.findFirst({
        where: { eventId, seq: runnerId, removed: false },
        select: { id: true, finishTime: true },
      });
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
      const { runnerId, status, finishTime, startTime } = event.payload as {
        runnerId: number;
        status: number;
        finishTime: number;
        startTime: number;
      };
      const runner = await db.runner.findFirst({
        where: { eventId, seq: runnerId, removed: false },
        select: { id: true },
      });
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
      const { runnerId, startTime } = event.payload as {
        runnerId: number;
        startTime: number;
      };
      const runner = await db.runner.findFirst({
        where: { eventId, seq: runnerId, removed: false },
        select: { id: true },
      });
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
          cardNo: number;
          startTime?: number;
        };
      const existing = cardNo > 0
        ? await db.runner.findFirst({
            where: { eventId, cardNo, removed: false },
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
              cardNo,
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
  }
}
