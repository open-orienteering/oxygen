/**
 * Per-event single-writer lease (pivot Step 4).
 *
 * The lease decides which node owns race-critical writes for an event. No
 * lease → the node you're talking to is the writer (single-node default).
 * Lease active → only the holder accepts race-critical mutations; everyone
 * else answers with a typed PRECONDITION_FAILED so clients can point the
 * operator at the right node.
 *
 * Checkout (venue side) = acquire on the cloud + snapshot import (rows
 * copied verbatim, UUIDs + per-event `seq` values and the `event_seqs`
 * counters preserved) + journal-from-there (the pull watermark starts at
 * the cloud's journal head; history before it is baked into the snapshot).
 *
 * Checkin (venue side) = a barrier: every local journal entry shipped and
 * acked, then release on both nodes. Nothing else to reconcile — see
 * "Consequence: checkin is cheap" in docs/offline-architecture.md.
 */

import { TRPCError } from "@trpc/server";
import { createTRPCClient, httpLink, type TRPCClient } from "@trpc/client";
import type { AppRouter } from "../routers/index.js";
import type { EventRef, PrismaClient } from "../db.js";
import { nodeId, SYNC_SECRET_HEADER } from "./nodeIdentity.js";

// ─── Active lease + write guard ─────────────────────────────

export interface ActiveLease {
  id: bigint;
  holderNodeId: string;
  acquiredAt: Date;
  forced: boolean;
}

export async function getActiveLease(
  db: PrismaClient,
  eventId: bigint,
): Promise<ActiveLease | null> {
  const row = await db.eventLease.findFirst({
    where: { eventId, releasedAt: null },
    select: { id: true, holderNodeId: true, acquiredAt: true, forced: true },
  });
  return row;
}

/**
 * Throw the typed "checked out" error when this node is not the holder of
 * an active lease. The backbone of `raceProcedure` — see trpc.ts.
 */
export async function assertRaceWritable(
  db: PrismaClient,
  eventId: bigint,
): Promise<void> {
  const lease = await getActiveLease(db, eventId);
  if (lease && lease.holderNodeId !== nodeId()) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: `Event is checked out to node "${lease.holderNodeId}" — race-critical writes must go to that node.`,
    });
  }
}

// ─── Acquire / release ──────────────────────────────────────

export async function acquireLease(
  db: PrismaClient,
  eventId: bigint,
  holderNodeId: string,
): Promise<ActiveLease> {
  try {
    const row = await db.eventLease.create({
      data: { eventId, holderNodeId },
      select: { id: true, holderNodeId: true, acquiredAt: true, forced: true },
    });
    return row;
  } catch (err) {
    // The partial unique index (one active lease per event) turns a
    // double-checkout race into a constraint violation.
    if ((err as { code?: string }).code === "P2002") {
      const current = await getActiveLease(db, eventId);
      throw new TRPCError({
        code: "CONFLICT",
        message: `Event is already checked out to "${current?.holderNodeId ?? "unknown"}".`,
      });
    }
    throw err;
  }
}

export async function releaseLease(
  db: PrismaClient,
  eventId: bigint,
  opts: { expectedHolder?: string; forced?: boolean } = {},
): Promise<void> {
  const lease = await getActiveLease(db, eventId);
  if (!lease) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "No active lease to release.",
    });
  }
  if (opts.expectedHolder && lease.holderNodeId !== opts.expectedHolder) {
    throw new TRPCError({
      code: "CONFLICT",
      message: `Lease is held by "${lease.holderNodeId}", not "${opts.expectedHolder}".`,
    });
  }
  await db.eventLease.update({
    where: { id: lease.id },
    data: { releasedAt: new Date(), forced: opts.forced ?? false },
  });
}

// ─── Snapshot export / import ───────────────────────────────

/**
 * The event-scoped tables carried by a checkout snapshot, in FK-safe insert
 * order. Rows travel verbatim (UUID PKs and `seq` values preserved); only
 * `eventId` is rewritten to the importing node's local event id. Map/tile
 * blobs and readout-backup staging rows stay behind — they are server-local
 * caches, re-creatable, and not part of the results closure.
 */
const SNAPSHOT_TABLES = [
  "control",
  "course",
  "courseControl",
  "class",
  "classCoursePool",
  "cardReadout",
  "card",
  "runner",
  "team",
  "controlUnit",
  "punch",
] as const;

type SnapshotTable = (typeof SNAPSHOT_TABLES)[number];

/** Delegate lookup that keeps Prisma's per-model types out of the loop. */
function delegate(db: PrismaClient, table: SnapshotTable) {
  return db[table] as unknown as {
    findMany(args: { where: { eventId: bigint } }): Promise<Record<string, unknown>[]>;
    createMany(args: { data: Record<string, unknown>[] }): Promise<unknown>;
  };
}

export interface EventSnapshot {
  event: Record<string, unknown>;
  tables: Record<SnapshotTable, Record<string, unknown>[]>;
  seqs: Array<{ tableName: string; nextSeq: number }>;
  /** The exporter's journal head — the importer's initial pull watermark. */
  journalCursor: { hlc: string; id: string };
}

export async function exportEventSnapshot(
  db: PrismaClient,
  event: EventRef,
): Promise<EventSnapshot> {
  const eventRow = await db.event.findUniqueOrThrow({
    where: { id: event.id },
  });

  const tables = {} as EventSnapshot["tables"];
  for (const t of SNAPSHOT_TABLES) {
    if (t === "courseControl") {
      tables[t] = await db.courseControl.findMany({
        where: { course: { eventId: event.id } },
      }) as unknown as Record<string, unknown>[];
      continue;
    }
    if (t === "classCoursePool") {
      tables[t] = await db.classCoursePool.findMany({
        where: { class: { eventId: event.id } },
      }) as unknown as Record<string, unknown>[];
      continue;
    }
    tables[t] = await delegate(db, t).findMany({ where: { eventId: event.id } });
  }

  const seqs = await db.eventSeq.findMany({
    where: { eventId: event.id },
    select: { tableName: true, nextSeq: true },
  });

  const head = await db.journalEntry.findFirst({
    where: { eventId: event.id },
    orderBy: [{ hlc: "desc" }, { id: "desc" }],
    select: { hlc: true, id: true },
  });

  return {
    event: eventRow as unknown as Record<string, unknown>,
    tables,
    seqs,
    journalCursor: head
      ? { hlc: head.hlc.toString(), id: head.id }
      : { hlc: "0", id: "" },
  };
}

/**
 * Import a checkout snapshot, replacing any existing local copy of the
 * event (identified by `nameId`; the cascade wipes children, seqs, journal
 * and sync state — correct on re-checkout, the previous lease's journal was
 * shipped before checkin). Returns the local EventRef.
 */
export async function importEventSnapshot(
  db: PrismaClient,
  snapshot: EventSnapshot,
): Promise<EventRef> {
  const { id: _dropId, ...eventData } = snapshot.event;
  const nameId = String(eventData.nameId);

  const localId = await db.$transaction(
    async (tx) => {
      await tx.event.deleteMany({ where: { nameId } });
      const created = await tx.event.create({
        data: eventData as never,
        select: { id: true },
      });

      for (const t of SNAPSHOT_TABLES) {
        const rows = snapshot.tables[t] ?? [];
        if (rows.length === 0) continue;
        if (t === "courseControl" || t === "classCoursePool") {
          // Join tables carry no eventId column; FKs (course/class UUIDs)
          // travel verbatim.
          await (tx[t] as unknown as {
            createMany(a: { data: Record<string, unknown>[] }): Promise<unknown>;
          }).createMany({ data: rows });
          continue;
        }
        await (tx[t] as unknown as {
          createMany(a: { data: Record<string, unknown>[] }): Promise<unknown>;
        }).createMany({
          data: rows.map((r) => ({ ...r, eventId: created.id })),
        });
      }

      // Seq counters travel with the lease — the holder is the only
      // allocator, so the importing node continues exactly where the
      // exporter stopped.
      if (snapshot.seqs.length > 0) {
        await tx.eventSeq.createMany({
          data: snapshot.seqs.map((s) => ({ ...s, eventId: created.id })),
        });
      }

      return created.id;
    },
    { timeout: 60_000 },
  );

  const ref = await db.event.findUniqueOrThrow({
    where: { id: localId },
    select: { id: true, nameId: true, zeroTime: true },
  });
  return ref;
}

// ─── Shipping status / checkin barrier ──────────────────────

export interface ShippingStatus {
  /** Local journal entries not yet acked by the peer. */
  pendingPush: number;
  /** When the watermark row last moved (≈ last successful ship). */
  lastShipAt: string | null;
}

export async function shippingStatus(
  db: PrismaClient,
  eventId: bigint,
  peerId: string,
): Promise<ShippingStatus> {
  const state = await db.journalSyncState.findUnique({
    where: { peerId_eventId: { peerId, eventId } },
  });
  const pushedHlc = state?.pushedHlc ?? 0n;
  const pushedId = state?.pushedId ?? "";
  const pendingPush = await db.journalEntry.count({
    where: {
      eventId,
      OR: [
        { hlc: { gt: pushedHlc } },
        ...(pushedId ? [{ hlc: pushedHlc, id: { gt: pushedId } }] : []),
      ],
    },
  });
  return {
    pendingPush,
    lastShipAt: state?.updatedAt.toISOString() ?? null,
  };
}

// ─── Peer lease API (node-to-node) ──────────────────────────

/** The cloud-side lease surface the venue's checkout/checkin drives. */
export interface LeasePeer {
  acquire(nameId: string, holderNodeId: string): Promise<void>;
  release(nameId: string, holderNodeId: string): Promise<void>;
  exportSnapshot(nameId: string): Promise<EventSnapshot>;
}

export function httpLeasePeer(baseUrl: string, secret: string): LeasePeer {
  const clients = new Map<string, TRPCClient<AppRouter>>();
  const clientFor = (nameId: string): TRPCClient<AppRouter> => {
    let c = clients.get(nameId);
    if (!c) {
      c = createTRPCClient<AppRouter>({
        links: [
          httpLink({
            url: `${baseUrl}/trpc`,
            headers: { "x-event-id": nameId, [SYNC_SECRET_HEADER]: secret },
          }),
        ],
      });
      clients.set(nameId, c);
    }
    return c;
  };
  return {
    async acquire(nameId, holderNodeId) {
      await clientFor(nameId).lease.acquire.mutate({ holderNodeId });
    },
    async release(nameId, holderNodeId) {
      await clientFor(nameId).lease.release.mutate({ holderNodeId });
    },
    async exportSnapshot(nameId) {
      return (await clientFor(nameId).lease.exportSnapshot.query()) as EventSnapshot;
    },
  };
}

/** Test seam: the integration harness swaps in an in-process peer. */
let leasePeerFactory: ((baseUrl: string, secret: string) => LeasePeer) | null =
  null;
export function _setLeasePeerFactory(
  f: ((baseUrl: string, secret: string) => LeasePeer) | null,
): void {
  leasePeerFactory = f;
}
export function makeLeasePeer(baseUrl: string, secret: string): LeasePeer {
  return (leasePeerFactory ?? httpLeasePeer)(baseUrl, secret);
}
