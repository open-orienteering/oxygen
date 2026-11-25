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
 * "Consequence: checkin is cheap" in docs/system/offline-architecture.md.
 */

import { TRPCError } from "@trpc/server";
import { createTRPCClient, httpLink, type TRPCClient } from "@trpc/client";
import type { AppRouter } from "../routers/index.js";
import type { EventRef, PrismaClient } from "../db.js";
import { Prisma } from "../generated/prisma/client.js";
import { nodeId, nodeRole, SYNC_NODE_ID_HEADER, SYNC_SECRET_HEADER } from "./nodeIdentity.js";
import { isCheckingIn } from "./leaseState.js";
import { makeSyncHeaders } from "./googleIdToken.js";
import {
  applyTokens,
  exportSnapshotMaps,
  importSnapshotMaps,
  tokenMapOf,
  withDbNulls,
  type ExportBlobInput,
  type ExportBlobResult,
  type SnapshotBlobs,
  type SnapshotMaps,
} from "./snapshotMaps.js";
import {
  exportSnapshotGraphics,
  importSnapshotGraphics,
  type SnapshotGraphic,
  type SnapshotGraphicBlobs,
} from "./snapshotGraphics.js";
import { withoutDroppedFields } from "./dropped-columns.js";
import type { MapRows } from "./mapRefresh.js";

// ─── Active lease + write guard ─────────────────────────────

export interface ActiveLease {
  id: bigint;
  holderNodeId: string;
  acquiredAt: Date;
  forced: boolean;
}

export async function getActiveLease(
  db: PrismaClient | Prisma.TransactionClient,
  eventId: bigint,
): Promise<ActiveLease | null> {
  const row = await db.eventLease.findFirst({
    where: { eventId, releasedAt: null },
    select: { id: true, holderNodeId: true, acquiredAt: true, forced: true },
  });
  return row;
}

export type WriteRefusal = "held-elsewhere" | "checked-in" | "checking-in";
export type WriteVerdict = { ok: true } | { ok: false; reason: WriteRefusal; holder?: string };

/**
 * The single guard: may THIS node originate race or course data for the
 * event? Every writer outside a request that already went through
 * `raceProcedure` (background jobs that emit course data, a push from a
 * station) asks here rather than re-deriving the rule.
 *
 * - Another node holds the active lease: no (`held-elsewhere`).
 * - A checkin barrier of this process is running: no (`checking-in`).
 * - On a venue box, the event has lease history but this box does not hold
 *   the active lease: no (`checked-in`). The box handed the event back (or
 *   lost it to a takeover); its copy is no longer the writer. A box-local
 *   event with no lease rows stays writable, as does any event on the cloud
 *   without a lease ("no lease: the node you talk to is the writer").
 */
export async function mayWriteEventData(
  db: PrismaClient | Prisma.TransactionClient,
  eventId: bigint,
): Promise<WriteVerdict> {
  if (isCheckingIn(eventId)) return { ok: false, reason: "checking-in" };
  const lease = await getActiveLease(db, eventId);
  if (lease) {
    return lease.holderNodeId === nodeId()
      ? { ok: true }
      : { ok: false, reason: "held-elsewhere", holder: lease.holderNodeId };
  }
  if (nodeRole() === "venue" && (await db.eventLease.count({ where: { eventId } })) > 0) {
    return { ok: false, reason: "checked-in" };
  }
  return { ok: true };
}

/**
 * Whether `peerNodeId` is a node whose lease on the event ended in a forced
 * takeover and which no longer holds it: what it still delivers is a late
 * backlog the cloud applies but names in its log.
 */
export async function isStaleHolder(
  db: PrismaClient | Prisma.TransactionClient,
  eventId: bigint,
  peerNodeId: string | null | undefined,
): Promise<boolean> {
  if (!peerNodeId) return false;
  const active = await getActiveLease(db, eventId);
  if (active?.holderNodeId === peerNodeId) return false;
  const last = await db.eventLease.findFirst({
    where: { eventId, holderNodeId: peerNodeId },
    orderBy: { id: "desc" },
    select: { releasedAt: true, forced: true },
  });
  return last?.releasedAt != null && last.forced;
}

/** Whether this node may originate race-critical writes (see `mayWriteEventData`). */
export async function isRaceWritable(db: PrismaClient | Prisma.TransactionClient, eventId: bigint): Promise<boolean> {
  return (await mayWriteEventData(db, eventId)).ok;
}

/** The typed refusal for a verdict that is not ok. */
export function writeRefusalError(v: Extract<WriteVerdict, { ok: false }>): TRPCError {
  const message =
    v.reason === "checking-in"
      ? "Event is being checked in — race-critical writes resume on the cloud once the checkin finishes."
      : v.reason === "checked-in"
        ? "This copy was checked in or taken over; race writes go to the cloud."
        : `Event is checked out to node "${v.holder}" — race-critical writes must go to that node.`;
  return new TRPCError({ code: "PRECONDITION_FAILED", message });
}

/**
 * Throw the typed "checked out" error when this node may not write the
 * event's race data. The backbone of `raceProcedure` — see trpc.ts.
 */
export async function assertRaceWritable(
  db: PrismaClient,
  eventId: bigint,
): Promise<void> {
  const v = await mayWriteEventData(db, eventId);
  if (!v.ok) throw writeRefusalError(v);
}

// ─── Acquire / release ──────────────────────────────────────

export async function acquireLease(
  db: PrismaClient | Prisma.TransactionClient,
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
      // The same holder asking again (a retried checkout whose first attempt
      // died after the peer took the lease) is not a conflict.
      if (current && current.holderNodeId === holderNodeId) return current;
      throw new TRPCError({
        code: "CONFLICT",
        message: `Event is already checked out to "${current?.holderNodeId ?? "unknown"}".`,
      });
    }
    throw err;
  }
}

/**
 * The cloud side of a checkout: take the lease, then mark every entry already
 * in the journal as delivered. Their effects are in the snapshot the box is
 * about to read, so the box must not pull them. Marking runs before the
 * snapshot is read; an entry committed after it stays unmarked and reaches
 * the box through its first pull even when the snapshot already holds its
 * effect (applying it twice is a no-op, review MC-22).
 */
export async function acquireLeaseForPeer(
  db: PrismaClient,
  eventId: bigint,
  holderNodeId: string,
): Promise<ActiveLease> {
  const lease = await acquireLease(db, eventId, holderNodeId);
  await db.journalEntry.updateMany({
    where: { eventId, pushedAt: null },
    data: { pushedAt: new Date() },
  });
  return lease;
}

/**
 * The cloud side of a checkin. Idempotent for the caller: when the lease was
 * already released by this holder (the first reply was lost), answer ok.
 */
export async function releaseLeaseForPeer(
  db: PrismaClient,
  eventId: bigint,
  holderNodeId: string,
): Promise<void> {
  const active = await getActiveLease(db, eventId);
  if (!active) {
    const latest = await db.eventLease.findFirst({
      where: { eventId },
      orderBy: { id: "desc" },
      select: { holderNodeId: true },
    });
    if (latest?.holderNodeId === holderNodeId) return;
  }
  await releaseLease(db, eventId, { expectedHolder: holderNodeId });
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
 * `eventId` is rewritten to the importing node's local event id.
 * Readout-backup staging rows stay behind — they are server-local,
 * re-creatable, and not part of the results closure. The
 * event's map rows travel separately as `maps` (docs/map-storage.md §7.2),
 * the map patch with them (docs/map-patches.md §3.4: its FK needs the
 * documents, and its token must not cross the JSON body as a number).
 * Course objects, templates and sheets are cloud-owned (their writes are
 * forwarded from a venue) but travel here: the kiosk map at the venue draws
 * the objects (docs/course-layer.md §8) and the box prints from its copy
 * (slice G answer 4; docs/map-storage.md §7.2). Their tokens also travel
 * exactly, in `versions`.
 */
const SNAPSHOT_TABLES = [
  "control",
  "course",
  "courseControl",
  // Before the classes: `classes.sheet_template_id` references it.
  "mapTemplate",
  "class",
  "classCoursePool",
  // After courses, classes and templates, which it references.
  "courseMap",
  // Not in the results closure, but the venue's map draws them (08 §4.8).
  "courseObject",
  "cardReadout",
  "card",
  "runner",
  "team",
  "controlUnit",
  "punch",
] as const;

type SnapshotTable = (typeof SNAPSHOT_TABLES)[number];

/** The cloud-owned layout tables whose tokens travel exactly in `versions`. */
export const TOKEN_TABLES = ["courseObject", "courseMap", "mapTemplate"] as const;
export type TokenTable = (typeof TOKEN_TABLES)[number];

/** `course_maps` columns typed `Json?` (schema.prisma). */
export const NULLABLE_JSON_SHEET_FIELDS = ["windowCenter"] as const;
/** `course_objects` columns typed `Json?` (J10's `attach`). */
export const NULLABLE_JSON_OBJECT_FIELDS = ["attach"] as const;

/**
 * Rows of a snapshot table as the importer inserts them: exact tokens, a
 * template reference NULL when the template did not travel (an exporter
 * that predates templates in the snapshot), JSON nulls as `DbNull`.
 */
function importRows(
  t: SnapshotTable,
  rows: Record<string, unknown>[],
  snapshot: EventSnapshot,
): Record<string, unknown>[] {
  if (t === "course") return rows.map((r) => withoutDroppedFields("course", r));
  const templateIds = new Set((snapshot.tables.mapTemplate ?? []).map((r) => String(r.id)));
  const knownTemplate = (v: unknown) => (typeof v === "string" && templateIds.has(v) ? v : null);
  if (t === "class") {
    return rows.map((r) => ("sheetTemplateId" in r ? { ...r, sheetTemplateId: knownTemplate(r.sheetTemplateId) } : r));
  }
  if ((TOKEN_TABLES as readonly string[]).includes(t)) {
    const exact = applyTokens(rows, snapshot.versions?.[t as TokenTable]);
    if (t === "courseObject") return exact.map((r) => withDbNulls(r, NULLABLE_JSON_OBJECT_FIELDS));
    if (t !== "courseMap") return exact;
    return exact.map((r) => withDbNulls({ ...r, templateId: knownTemplate(r.templateId) }, NULLABLE_JSON_SHEET_FIELDS));
  }
  return rows;
}

/** Delegate lookup that keeps Prisma's per-model types out of the loop. */
function delegate(db: PrismaClient | Prisma.TransactionClient, table: SnapshotTable) {
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
  /**
   * Pinned map rows without bytes (docs/map-storage.md §7.2); the blobs
   * follow through `lease.exportBlob`. Absent from an exporter that
   * predates it.
   */
  maps?: SnapshotMaps;
  /**
   * Exact tokens of the cloud-owned layout rows, decimal strings by row id
   * (the rows' own `version` is rounded once the snapshot crosses HTTP).
   * Absent from an exporter that predates it.
   */
  versions?: Partial<Record<TokenTable, Record<string, string>>>;
  /**
   * The event's graphics and the club graphics its layout rows reference,
   * without bytes (docs/map-storage.md §7.2); the bytes follow through
   * `lease.exportBlob`. Absent from an exporter that predates it.
   */
  graphics?: SnapshotGraphic[];
}

export async function exportEventSnapshot(
  db: PrismaClient,
  event: EventRef,
): Promise<EventSnapshot> {
  // One snapshot of the database for every read: tables, counters, journal
  // head and the map and graphic parts all describe the same moment, so a
  // write committing mid-export can show up in one part and not another
  // (review MC-22). REPEATABLE READ does not block writers.
  return db.$transaction(
    async (tx) => {
      const eventRow = await tx.event.findUniqueOrThrow({
        where: { id: event.id },
      });

      const tables = {} as EventSnapshot["tables"];
      for (const t of SNAPSHOT_TABLES) {
        if (t === "courseControl") {
          tables[t] = await tx.courseControl.findMany({
            where: { course: { eventId: event.id } },
          }) as unknown as Record<string, unknown>[];
          continue;
        }
        if (t === "classCoursePool") {
          tables[t] = await tx.classCoursePool.findMany({
            where: { class: { eventId: event.id } },
          }) as unknown as Record<string, unknown>[];
          continue;
        }
        tables[t] = await delegate(tx, t).findMany({ where: { eventId: event.id } });
      }

      const seqs = await tx.eventSeq.findMany({
        where: { eventId: event.id },
        select: { tableName: true, nextSeq: true },
      });

      const head = await tx.journalEntry.findFirst({
        where: { eventId: event.id },
        orderBy: [{ hlc: "desc" }, { id: "desc" }],
        select: { hlc: true, id: true },
      });

      return {
        event: eventRow as unknown as Record<string, unknown>,
        tables,
        seqs,
        // Kept for a box that still pulls by HLC cursor.
        journalCursor: head
          ? { hlc: head.hlc.toString(), id: head.id }
          : { hlc: "0", id: "" },
        maps: await exportSnapshotMaps(tx, event.id),
        versions: Object.fromEntries(TOKEN_TABLES.map((t) => [t, tokenMapOf(tables[t])])),
        graphics: await exportSnapshotGraphics(tx, event.id),
      };
    },
    { isolationLevel: "RepeatableRead", timeout: 60_000 },
  );
}

export interface ImportOptions {
  /**
   * Runs inside the import transaction once the event is in place: whatever
   * must commit with it or not at all (the checkout's sync-state row and
   * local lease), so a crash leaves either the whole checkout or none of it.
   */
  afterImport?: (tx: Prisma.TransactionClient, eventId: bigint) => Promise<void>;
  /** Replace graphics owned by another event on this box (`GRAPHIC_ID_CLASH` otherwise). */
  replaceOtherEvents?: boolean;
}

/**
 * Import a checkout snapshot, replacing any existing local copy of the
 * event (identified by `nameId`; the cascade wipes children, seqs, journal
 * and sync state — correct on re-checkout, the previous lease's journal was
 * shipped before checkin). Returns the local EventRef.
 *
 * `blobs` are the map blobs `fetchSnapshotBlobs` fetched for
 * `snapshot.maps`; without them the map part is not imported.
 * `graphicBlobs` are the bytes `fetchSnapshotGraphics` fetched for
 * `snapshot.graphics`; without them no graphic is imported.
 */
export async function importEventSnapshot(
  db: PrismaClient,
  snapshot: EventSnapshot,
  blobs?: SnapshotBlobs,
  graphicBlobs?: SnapshotGraphicBlobs,
  opts: ImportOptions = {},
): Promise<EventRef> {
  // A v0.6.0 exporter still sends the columns E5 dropped.
  const { id: _dropId, ...eventData } = withoutDroppedFields("event", snapshot.event);
  const nameId = String(eventData.nameId);

  const localId = await db.$transaction(
    async (tx) => {
      // Readout-backup staging rows are server-local and not in the snapshot,
      // but they are the only copy of what a station's flash held: carry
      // them over a re-checkout.
      const backups = await tx.cardReadoutBackup.findMany({
        where: { event: { nameId } },
      });
      await tx.event.deleteMany({ where: { nameId } });
      const created = await tx.event.create({
        data: eventData as never,
        select: { id: true },
      });
      if (backups.length > 0) {
        await tx.cardReadoutBackup.createMany({
          data: backups.map((b) => ({
            ...b,
            eventId: created.id,
            ownerData: b.ownerData === null ? Prisma.DbNull : b.ownerData,
          })) as Prisma.CardReadoutBackupCreateManyInput[],
        });
      }

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
          data: importRows(t, rows, snapshot).map((r) => ({ ...r, eventId: created.id })),
        });
      }

      // Graphics by the cloud's id: the layout rows reference them by number.
      if (snapshot.graphics && graphicBlobs) {
        await importSnapshotGraphics(tx, created.id, snapshot.graphics, graphicBlobs, {
          replaceOtherEvents: opts.replaceOtherEvents,
        });
      }

      // Content-addressed blobs (append-only) and the event's map pins.
      if (snapshot.maps && blobs) {
        await importSnapshotMaps(tx, created.id, snapshot.maps, blobs);
      }

      // Seq counters travel with the lease — the holder is the only
      // allocator, so the importing node continues exactly where the
      // exporter stopped. `allocate_event_seq()` already advanced the
      // counters past the explicit seq values just inserted; the exporter's
      // counter wins only when it is higher (it may have burnt values).
      for (const s of snapshot.seqs) {
        await tx.$executeRaw`
          INSERT INTO oxygen.event_seqs (event_id, table_name, next_seq)
          VALUES (${created.id}, ${s.tableName}, ${s.nextSeq})
          ON CONFLICT (event_id, table_name)
          DO UPDATE SET next_seq = GREATEST(oxygen.event_seqs.next_seq, EXCLUDED.next_seq)`;
      }

      await opts.afterImport?.(tx, created.id);

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
  /** When an entry was last delivered to (or received from) the peer. */
  lastShipAt: string | null;
}

export async function shippingStatus(
  db: PrismaClient,
  eventId: bigint,
  _peerId: string,
): Promise<ShippingStatus> {
  const [pendingPush, last] = await Promise.all([
    db.journalEntry.count({ where: { eventId, pushedAt: null } }),
    db.journalEntry.aggregate({ where: { eventId }, _max: { pushedAt: true } }),
  ]);
  return {
    pendingPush,
    lastShipAt: last._max.pushedAt?.toISOString() ?? null,
  };
}

// ─── Peer lease API (node-to-node) ──────────────────────────

/** The cloud-side lease surface the venue's checkout/checkin drives. */
export interface LeasePeer {
  acquire(nameId: string, holderNodeId: string): Promise<void>;
  release(nameId: string, holderNodeId: string): Promise<void>;
  exportSnapshot(nameId: string): Promise<EventSnapshot>;
  /**
   * Who holds the peer's active lease for the event (null: none). Optional:
   * a peer that predates it answers NOT_FOUND, which callers treat as "unknown".
   */
  holder?(nameId: string): Promise<{ holderNodeId: string | null }>;
  /** The peer's full event row — the settings-refresh source. */
  exportSettings(nameId: string): Promise<Record<string, unknown>>;
  /** One slice of a map blob the event pins (docs/map-storage.md §7.2). */
  exportBlob(nameId: string, input: ExportBlobInput): Promise<ExportBlobResult>;
  /** The event's cloud-owned map rows without bytes — the map-refresh source (row G19). */
  exportMapRows(nameId: string): Promise<MapRows>;
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
            // Async provider with a Bearer ID token when the cloud peer
            // sits behind IAP (SYNC_GOOGLE_AUDIENCE); plain headers otherwise.
            headers: makeSyncHeaders({
              "x-event-id": nameId,
              [SYNC_SECRET_HEADER]: secret,
              [SYNC_NODE_ID_HEADER]: nodeId(),
            }),
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
    async exportSettings(nameId) {
      return (await clientFor(nameId).lease.exportSettings.query()) as Record<
        string,
        unknown
      >;
    },
    async holder(nameId) {
      return clientFor(nameId).lease.holder.query();
    },
    async exportBlob(nameId, input) {
      return clientFor(nameId).lease.exportBlob.query(input);
    },
    async exportMapRows(nameId) {
      return (await clientFor(nameId).lease.exportMapRows.query()) as MapRows;
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
