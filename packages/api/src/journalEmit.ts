/**
 * Server-originated journal entries (`emitAndApply`).
 *
 * Race-critical mutations call `appendJournal` with the **transaction client**
 * of the same `$transaction` that performs the table write, so journal
 * completeness is a structural property: a mutation that commits has its
 * entry, a rolled-back one doesn't. See docs/offline-architecture.md § "The
 * journal".
 *
 * Only the race-critical set is journaled (the dependency closure of live
 * results). Everything else stays pure tRPC — journaling is opt-in; do not
 * wire it into new endpoints unless they pass the boundary rule.
 */

import type { Prisma, PrismaClient } from "@prisma/client";
import {
  type JournalEntryType,
  type JournalPayloads,
  encodeHlc,
} from "@oxygen/shared";
import { nextServerHlc } from "./serverClock.js";

/** Works with both the singleton client and a `$transaction` client. */
type Db = PrismaClient | Prisma.TransactionClient;

/**
 * The journal `station_id` for entries this node originates itself (as
 * opposed to entries drained from a station outbox, which keep the station's
 * own id). Becomes the configured node identity in pivot Step 3.
 */
export const NODE_STATION_ID = process.env.NODE_ID ?? "cloud";

/**
 * Append one journal entry. MUST be called with the same transaction client
 * as the table write it records — passing the bare singleton alongside a
 * separate write defeats the completeness guarantee.
 */
export async function appendJournal<T extends JournalEntryType>(
  db: Db,
  args: {
    eventId: bigint;
    type: T;
    payload: JournalPayloads[T];
    /** Defaults to this node's identity. */
    stationId?: string;
    /** Always null until the permissions system ships. */
    actorId?: string | null;
  },
): Promise<void> {
  const hlc = nextServerHlc();
  await db.journalEntry.create({
    data: {
      eventId: args.eventId,
      type: args.type,
      stationId: args.stationId ?? NODE_STATION_ID,
      actorId: args.actorId ?? null,
      hlc: encodeHlc(hlc),
      schemaVersion: 1,
      clientTimestamp: new Date(hlc.physical),
      payload: args.payload as never,
    },
  });
}
