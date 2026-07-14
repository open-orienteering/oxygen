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
import { router, eventProcedure, peerProcedure } from "../trpc.js";
import { toRelative } from "../timeConvert.js";
import {
  encodeHlc,
  decodeHlc,
  resolveHlc,
  cardReadIsDuplicate,
  CARD_READ_DEDUPE_WINDOW_MS,
  meosFromVolts,
  type Hlc,
} from "@oxygen/shared";
import { storeReadoutImpl } from "./cardReadout.js";
import { buildRunnerUpdateData } from "./runner.js";
import { valueToRunnerStatus } from "../statusConvert.js";
import { foldServerHlc } from "../serverClock.js";
import type { EventRef } from "../db.js";
import type { PrismaClient } from "@prisma/client";

const eventPayloadSchema = z.object({
  id: z.string().uuid(),
  type: z.enum([
    "card.read",
    "finish.recorded",
    "finish.adjusted",
    "result.applied",
    "start.recorded",
    "start.adjusted",
    "runner.registered",
    "runner.updated",
    "runner.deleted",
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

/** A journal entry on the wire — station outbox drain and node shipping alike. */
export type WireJournalEntry = z.infer<typeof eventPayloadSchema>;

/**
 * Ingest a batch of journal entries: apply each to the relational tables and
 * record it in the journal, idempotently by entry `id`. Shared by the
 * `events.push` endpoint (station outbox drain + node-to-node push) and the
 * shipper's pull path, so every ingestion route has identical semantics.
 */
export async function ingestJournalEntries(
  db: PrismaClient,
  event: EventRef,
  entries: WireJournalEntry[],
): Promise<{ synced: string[]; failed: Array<{ id: string; error: string }> }> {
  const synced: string[] = [];
  const failed: Array<{ id: string; error: string }> = [];

  for (const entry of entries) {
    try {
      // Idempotency check — same UUID returns success.
      const existing = await db.journalEntry.findUnique({
        where: { id: entry.id },
        select: { id: true },
      });
      if (existing) {
        synced.push(entry.id);
        continue;
      }

      await applyEvent(db, event.id, event.zeroTime, entry);

      const resolved = resolveHlc({
        id: entry.id,
        stationId: entry.stationId,
        timestamp: entry.timestamp,
        hlc: entry.hlc,
      });
      // Keep the node clock ahead of everything it has seen, so
      // server-originated entries never sort behind station entries
      // already ingested (HLC receive rule).
      foldServerHlc(resolved);
      const hlc = encodeHlc(resolved);

      await db.journalEntry.create({
        data: {
          id: entry.id,
          eventId: event.id,
          type: entry.type,
          stationId: entry.stationId,
          actorId: entry.actorId ?? null,
          hlc,
          schemaVersion: entry.schemaVersion ?? 1,
          clientTimestamp: new Date(entry.timestamp),
          payload: entry.payload as never,
        },
      });

      synced.push(entry.id);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(
        `[events.ingest] Failed to apply entry ${entry.id} (${entry.type}):`,
        message,
      );
      failed.push({ id: entry.id, error: message });
    }
  }

  return { synced, failed };
}

/** Cursor into an event's journal: strictly after `(hlc, id)`. */
export interface JournalCursor {
  /** Encoded HLC as a decimal string (BigInt-safe on the wire). */
  hlc: string;
  /** Entry id tie-break within one encoded HLC value. */
  id: string;
}

export interface JournalPage {
  entries: Array<{
    id: string;
    type: WireJournalEntry["type"];
    competitionId: string;
    stationId: string;
    timestamp: number;
    hlc: Hlc;
    schemaVersion: number;
    actorId: string | null;
    payload: Record<string, unknown>;
  }>;
  /** Cursor of the last returned entry — pass back to continue. */
  nextCursor: JournalCursor;
  hasMore: boolean;
}

/** Sorts before every real entry id — the "from the beginning" cursor. */
const ZERO_UUID = "00000000-0000-0000-0000-000000000000";

/**
 * Page through an event's journal in canonical `(hlc, id)` order, strictly
 * after the cursor. Backs `events.since` and the two-node test harness.
 */
export async function listJournalEntriesSince(
  db: PrismaClient,
  event: EventRef,
  cursor: JournalCursor,
  limit: number,
): Promise<JournalPage> {
  const afterHlc = BigInt(cursor.hlc);
  // `journal.id` is a Postgres uuid — an empty "start" cursor must be the
  // zero uuid, not "", or the tie-break comparison fails to parse.
  const afterId = cursor.id || ZERO_UUID;
  const rows = await db.journalEntry.findMany({
    where: {
      eventId: event.id,
      OR: [
        { hlc: { gt: afterHlc } },
        { hlc: afterHlc, id: { gt: afterId } },
      ],
    },
    orderBy: [{ hlc: "asc" }, { id: "asc" }],
    take: limit + 1,
  });
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page.at(-1);
  return {
    entries: page.map((r) => ({
      id: r.id,
      type: r.type as WireJournalEntry["type"],
      competitionId: event.nameId,
      stationId: r.stationId,
      timestamp: r.clientTimestamp.getTime(),
      hlc: decodeHlc(r.hlc),
      schemaVersion: r.schemaVersion,
      actorId: r.actorId,
      payload: (r.payload ?? {}) as Record<string, unknown>,
    })),
    nextCursor: last
      ? { hlc: last.hlc.toString(), id: last.id }
      : { ...cursor },
    hasMore,
  };
}

export const eventsRouter = router({
  push: eventProcedure
    .input(z.object({ events: z.array(eventPayloadSchema) }))
    .mutation(async ({ ctx, input }) => {
      const { synced, failed } = await ingestJournalEntries(
        ctx.db,
        ctx.event,
        input.events,
      );
      // serverTimeMs lets the client detect a skewed local clock (see the
      // clock-skew banner). It is the cloud's wall clock at response time.
      return { synced, failed, serverTimeMs: Date.now() };
    }),

  /**
   * Node-to-node paginated journal pull (pivot Step 3). The venue's shipper
   * calls this on the cloud to fetch entries it doesn't have (e.g. ROC
   * punches ingested at the cloud during a lease) — and vice versa when the
   * cloud is configured to dial a venue. Guarded by the shared sync secret;
   * stations never call this.
   */
  since: peerProcedure
    .input(
      z.object({
        afterHlc: z.string().regex(/^\d+$/).default("0"),
        afterId: z.string().default(""),
        limit: z.number().int().min(1).max(500).default(200),
      }),
    )
    .query(async ({ ctx, input }) => {
      return listJournalEntriesSince(
        ctx.db,
        ctx.event,
        { hlc: input.afterHlc, id: input.afterId },
        input.limit,
      );
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

    case "finish.adjusted": {
      // Operator correction — last-write-wins, unlike the first-write-wins
      // station `finish.recorded`. The receiving node serializes writes, so
      // "apply unconditionally" is the LWW rule at this arrival point.
      const { finishTime, status } = event.payload as {
        finishTime: number;
        status?: number;
      };
      const runner = await resolveRunner(db, eventId, event.payload);
      if (runner) {
        await db.runner.update({
          where: { id: runner.id },
          data: {
            finishTime: finishTime > 0 ? toRelative(finishTime, zeroTime) : 0,
            ...(typeof status === "number"
              ? { status: valueToRunnerStatus(status) }
              : {}),
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

    case "start.adjusted": {
      // Draw / manual start-time set — last-write-wins.
      const { startTime } = event.payload as { startTime: number };
      const runner = await resolveRunner(db, eventId, event.payload);
      if (runner) {
        await db.runner.update({
          where: { id: runner.id },
          data: {
            startTime: startTime > 0 ? toRelative(startTime, zeroTime) : 0,
          },
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

    case "runner.updated": {
      // Field-patch replay: `fields` is the portable flat patch (absolute
      // deciseconds / class seq / numeric status) captured at emit; it goes
      // through the same translation as the `runner.update` mutation. The
      // follower applies verbatim — no card-conflict re-validation, the
      // originating node already made that decision.
      const { fields } = event.payload as {
        fields?: Record<string, unknown>;
      };
      const runner = await resolveRunner(db, eventId, event.payload);
      if (runner && fields && Object.keys(fields).length > 0) {
        const data = await buildRunnerUpdateData(
          db,
          eventId,
          zeroTime,
          fields,
        );
        if (Object.keys(data).length > 0) {
          await db.runner.update({ where: { id: runner.id }, data });
        }
      }
      break;
    }

    case "runner.deleted": {
      const runner = await resolveRunner(db, eventId, event.payload);
      if (runner) {
        await db.runner.update({
          where: { id: runner.id },
          data: { removed: true },
        });
      }
      break;
    }

    case "punch.recorded": {
      const { cardNo, controlCode, time } = event.payload as {
        cardNo: number;
        controlCode: number;
        time: number;
      };
      // Journal entries cross node boundaries — validate before the dedupe
      // lookup, where an undefined field would silently drop the filter.
      if (
        typeof cardNo !== "number" ||
        typeof controlCode !== "number" ||
        typeof time !== "number"
      ) {
        throw new Error("punch.recorded: malformed payload");
      }
      // Grow-only set semantics: punches dedupe by (cardNo, controlCode,
      // time) — see `punchDedupeKey` in @oxygen/shared. Without this guard
      // the same physical punch arriving via two entry ids (two stations
      // relaying one radio punch, or a crash between apply and journal
      // insert) would duplicate the row.
      const relTime = toRelative(time, zeroTime);
      const dup = await db.punch.findFirst({
        where: {
          eventId,
          cardNo,
          controlCode,
          time: relTime,
          removed: false,
        },
        select: { id: true },
      });
      if (!dup) {
        await db.punch.create({
          data: {
            eventId,
            cardNo,
            controlCode,
            time: relTime,
            source: "card",
          },
        });
      }
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
