import { z } from "zod";
import { router, competitionProcedure } from "../trpc.js";
import { getZeroTime, incrementCounter, ensureReadoutTable } from "../db.js";
import { toRelative } from "../timeConvert.js";
import { RunnerStatus } from "@oxygen/shared";

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
  /**
   * Push events from a client station.
   * Events are applied to the DB in order. Idempotent — same event ID is applied once.
   */
  push: competitionProcedure
    .input(z.object({
      events: z.array(eventPayloadSchema),
    }))
    .mutation(async ({ ctx, input }) => {
      const client = ctx.db;
      const synced: string[] = [];
      const failed: Array<{ id: string; error: string }> = [];

      // Ensure the event tracking table exists
      await ensureEventTable(client, ctx.dbName);

      for (const event of input.events) {
        try {
          // Idempotency check
          const existing = await client.$queryRawUnsafe<Array<{ id: string }>>(
            `SELECT id FROM oxygen_events WHERE id = ? LIMIT 1`,
            event.id,
          );
          if (existing.length > 0) {
            synced.push(event.id);
            continue;
          }

          // Apply the event
          await applyEvent(client, ctx.dbName, event);

          // Record the event
          await client.$executeRawUnsafe(
            `INSERT INTO oxygen_events (id, type, competition_id, station_id, client_timestamp, payload)
             VALUES (?, ?, ?, ?, ?, ?)`,
            event.id,
            event.type,
            event.competitionId,
            event.stationId,
            new Date(event.timestamp),
            JSON.stringify(event.payload),
          );

          synced.push(event.id);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.error(`[events.push] Failed to apply event ${event.id} (${event.type}):`, message);
          failed.push({ id: event.id, error: message });
        }
      }

      return { synced, failed };
    }),
});

// ─── Event Application ──────────────────────────────────────

interface EventInput {
  id: string;
  type: string;
  competitionId: string;
  stationId: string;
  timestamp: number;
  payload: Record<string, unknown>;
}

async function applyEvent(
  client: import("@prisma/client").PrismaClient,
  dbName: string,
  event: EventInput,
) {
  const zeroTime = await getZeroTime(client);

  switch (event.type) {
    case "finish.recorded": {
      const { runnerId, finishTime } = event.payload as { runnerId: number; finishTime: number };
      // Only update if runner doesn't already have a finish time
      const runner = await client.oRunner.findUnique({ where: { Id: runnerId }, select: { FinishTime: true } });
      if (runner && runner.FinishTime === 0) {
        await client.oRunner.update({
          where: { Id: runnerId },
          data: {
            FinishTime: toRelative(finishTime, zeroTime),
            Status: RunnerStatus.OK,
          },
        });
        await incrementCounter("oRunner", runnerId, dbName);
      }
      break;
    }

    case "result.applied": {
      const { runnerId, status, finishTime, startTime } = event.payload as {
        runnerId: number; status: number; finishTime: number; startTime: number;
      };
      await client.oRunner.update({
        where: { Id: runnerId },
        data: {
          Status: status,
          FinishTime: toRelative(finishTime, zeroTime),
          StartTime: toRelative(startTime, zeroTime),
        },
      });
      await incrementCounter("oRunner", runnerId, dbName);
      break;
    }

    case "start.recorded": {
      const { runnerId, startTime } = event.payload as { runnerId: number; startTime: number };
      await client.oRunner.update({
        where: { Id: runnerId },
        data: { StartTime: toRelative(startTime, zeroTime) },
      });
      await incrementCounter("oRunner", runnerId, dbName);
      break;
    }

    case "card.read": {
      // Card reads are handled by the existing storeReadout mutation.
      // For now, just record that the event happened — actual card storage
      // is done via the dedicated storeReadout call path which has complex
      // logic (stale detection, oCard upsert, Google Sheets backup).
      // The event is recorded for audit/sync purposes.
      break;
    }

    case "runner.registered": {
      const { name, classId, clubId, cardNo, startTime } = event.payload as {
        tempId: string; name: string; classId: number; clubId: number;
        cardNo: number; startTime?: number;
      };
      // Check card not already taken (skip check if no card assigned)
      const existing = cardNo > 0
        ? await client.oRunner.findFirst({
            where: { CardNo: cardNo, Removed: false },
            select: { Id: true },
          })
        : null;
      if (!existing) {
        await client.oRunner.create({
          data: {
            Name: name,
            Class: classId,
            Club: clubId,
            CardNo: cardNo,
            StartTime: startTime ? toRelative(startTime, zeroTime) : 0,
          },
        });
      }
      break;
    }

    case "runner.updated": {
      const { runnerId, fields } = event.payload as { runnerId: number; fields: Record<string, unknown> };
      // Only allow safe field updates
      const safeFields: Record<string, unknown> = {};
      if ("Name" in fields) safeFields.Name = fields.Name;
      if ("Class" in fields) safeFields.Class = fields.Class;
      if ("Club" in fields) safeFields.Club = fields.Club;
      if ("CardNo" in fields) safeFields.CardNo = fields.CardNo;
      if (Object.keys(safeFields).length > 0) {
        await client.oRunner.update({
          where: { Id: runnerId },
          data: safeFields,
        });
        await incrementCounter("oRunner", runnerId, dbName);
      }
      break;
    }

    case "punch.recorded": {
      const { cardNo, controlCode, time } = event.payload as {
        cardNo: number; controlCode: number; time: number;
      };
      await client.oPunch.create({
        data: {
          CardNo: cardNo,
          Type: controlCode,
          Time: toRelative(time, zeroTime),
          Origin: 0,
        },
      });
      break;
    }
  }
}

// ─── Table Management ───────────────────────────────────────

const ensuredDbs = new Set<string>();

async function ensureEventTable(
  client: import("@prisma/client").PrismaClient,
  dbName: string,
) {
  if (ensuredDbs.has(dbName)) return;
  await client.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS oxygen_events (
      id VARCHAR(36) PRIMARY KEY,
      type VARCHAR(50) NOT NULL,
      competition_id VARCHAR(255) NOT NULL,
      station_id VARCHAR(36) NOT NULL,
      client_timestamp DATETIME NOT NULL,
      payload JSON,
      applied_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_type (type),
      INDEX idx_station (station_id),
      INDEX idx_timestamp (client_timestamp)
    )
  `);
  ensuredDbs.add(dbName);
}
