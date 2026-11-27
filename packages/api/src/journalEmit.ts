/**
 * Server-originated journal entries (`emitAndApply`).
 *
 * Race-critical mutations call `appendJournal` with the **transaction client**
 * of the same `$transaction` that performs the table write, so journal
 * completeness is a structural property: a mutation that commits has its
 * entry, a rolled-back one doesn't. See docs/system/offline-architecture.md § "The
 * journal".
 *
 * Only the race-critical set is journaled (the dependency closure of live
 * results). Everything else stays pure tRPC — journaling is opt-in; do not
 * wire it into new endpoints unless they pass the boundary rule.
 */

import type { Prisma, PrismaClient } from "./generated/prisma/client.js";
import {
  type Hlc,
  type JournalEntryType,
  type JournalPayloads,
  encodeHlc,
} from "@oxygen/shared";
import { nextServerHlc } from "./serverClock.js";
import { nodeId } from "./sync/nodeIdentity.js";
import { currentActorId } from "./auth.js";

/** Works with both the singleton client and a `$transaction` client. */
type Db = PrismaClient | Prisma.TransactionClient;

/**
 * The journal `station_id` for entries this node originates itself (as
 * opposed to entries drained from a station outbox, which keep the station's
 * own id). The configured node identity — see `sync/nodeIdentity.ts`.
 */
export const NODE_STATION_ID = nodeId();

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
    /** Authenticated user id. Defaults to the current tRPC actor, else null. */
    actorId?: string | null;
    /**
     * A clock reading taken by the caller (`nextServerHlc()`), when the row
     * must carry the entry's HLC before the payload is read (the reference
     * version token, docs/course-layer.md §7). Defaults to a fresh one.
     */
    hlc?: Hlc;
  },
): Promise<bigint> {
  const hlc = args.hlc ?? nextServerHlc();
  await db.journalEntry.create({
    data: {
      eventId: args.eventId,
      type: args.type,
      stationId: args.stationId ?? NODE_STATION_ID,
      actorId: args.actorId !== undefined ? args.actorId : currentActorId(),
      hlc: encodeHlc(hlc),
      schemaVersion: 1,
      clientTimestamp: new Date(hlc.physical),
      payload: args.payload as never,
    },
  });
  return encodeHlc(hlc);
}

/**
 * Append many journal entries in one insert (the draw writes one
 * `start.adjusted` per runner). Same contract as `appendJournal`: call it with
 * the transaction client of the table writes. Each entry gets its own HLC,
 * minted in order, so they replay in the order given.
 */
export async function appendJournalMany<T extends JournalEntryType>(
  db: Db,
  args: {
    eventId: bigint;
    type: T;
    payloads: JournalPayloads[T][];
    stationId?: string;
    actorId?: string | null;
  },
): Promise<number> {
  if (args.payloads.length === 0) return 0;
  const stationId = args.stationId ?? NODE_STATION_ID;
  const actorId = args.actorId !== undefined ? args.actorId : currentActorId();
  const res = await db.journalEntry.createMany({
    data: args.payloads.map((payload) => {
      const hlc = nextServerHlc();
      return {
        eventId: args.eventId,
        type: args.type,
        stationId,
        actorId,
        hlc: encodeHlc(hlc),
        schemaVersion: 1,
        clientTimestamp: new Date(hlc.physical),
        payload: payload as never,
      };
    }),
  });
  return res.count;
}
