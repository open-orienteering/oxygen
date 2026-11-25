/**
 * Per-event lease router (pivot Step 4).
 *
 * Two audiences:
 *   - **Node-to-node** (peerProcedure, shared-secret): `acquire`, `release`,
 *     `exportSnapshot`, `exportSettings`, `exportBlob`, `exportMapRows` —
 *     the cloud-side surface a venue's checkout/checkin and refreshes drive.
 *   - **Operator** (public/eventProcedure): `status` for the shell badge,
 *     `checkout`/`checkin` on the venue box, `forceTakeover` on the node
 *     that needs control back after a venue box died.
 *
 * See docs/system/offline-architecture.md § "The lease".
 */

import { z } from "zod";
import { TRPCError } from "@trpc/server";
import {
  router,
  publicProcedure,
  viewProcedure,
  manageProcedure,
  peerProcedure,
} from "../trpc.js";
import { prisma } from "../db.js";
import { capabilitiesForContext, type EventContext } from "../trpc.js";
import {
  acquireLease,
  acquireLeaseForPeer,
  releaseLease,
  releaseLeaseForPeer,
  getActiveLease,
  exportEventSnapshot,
  importEventSnapshot,
  shippingStatus,
  makeLeasePeer,
  schemaName,
} from "../sync/lease.js";
import { shipEventOnce, makePeerTransport } from "../sync/shipper.js";
import { beginCheckin, endCheckin } from "../sync/leaseState.js";
import {
  exportBlobInput,
  fetchSnapshotBlobs,
} from "../sync/snapshotMaps.js";
import {
  exportPeerBlobSlice,
  fetchSnapshotGraphics,
  findGraphicClashes,
  graphicClashError,
} from "../sync/snapshotGraphics.js";
import { exportMapRows } from "../sync/mapRefresh.js";
import {
  nodeId,
  nodeRole,
  syncPeerUrl,
  syncSharedSecret,
} from "../sync/nodeIdentity.js";

/** Resolve the peer config or throw the typed "not a peered node" error. */
function requirePeer(): { peerUrl: string; secret: string } {
  const peerUrl = syncPeerUrl();
  const secret = syncSharedSecret();
  if (!peerUrl || !secret) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message:
        "This node has no peer configured (SYNC_PEER_URL / SYNC_SHARED_SECRET) — checkout/checkin runs on the venue box.",
    });
  }
  return { peerUrl, secret };
}


function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The tRPC code of an error thrown locally (TRPCError) or by the HTTP client (TRPCClientError). */
function errorCode(err: unknown): string | undefined {
  if (err instanceof TRPCError) return err.code;
  const data = (err as { data?: { code?: string } } | null)?.data;
  return data?.code;
}

/** Codes of an `acquire` refusal that leave the peer's lease untouched. */
const CLEAR_REFUSALS = new Set(["CONFLICT", "NOT_FOUND", "UNAUTHORIZED", "FORBIDDEN", "BAD_REQUEST"]);

/** False for a typed refusal; true for a transport failure or any other error whose outcome is unknown. */
export function acquireMayHaveSucceeded(err: unknown): boolean {
  const code = errorCode(err);
  return !(code && CLEAR_REFUSALS.has(code));
}

async function resolveLocalEvent(db: ReturnType<typeof prisma>, nameId: string) {
  const row = await db.event.findUnique({
    where: { nameId },
    select: { id: true, nameId: true, zeroTime: true, date: true, kioskKey: true },
  });
  return row;
}

/**
 * Refuse a checkout that would replace local work: a lease still held here,
 * an event this box created itself, or journal entries the cloud has not
 * received. Runs before any peer call that changes anything.
 */
async function assertCheckoutMayReplace(
  db: ReturnType<typeof prisma>,
  local: NonNullable<Awaited<ReturnType<typeof resolveLocalEvent>>>,
  peerUrl: string,
  secret: string,
  discardLocal: boolean,
): Promise<void> {
  const held = await getActiveLease(db, local.id);
  if (held) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: `CHECKOUT_LEASE_HELD: this box still holds "${local.nameId}" (node "${held.holderNodeId}"): check in first.`,
    });
  }
  const synced = await db.journalSyncState.findUnique({
    where: { peerId_eventId: { peerId: peerUrl, eventId: local.id } },
    select: { eventId: true },
  });
  if (!synced) {
    if (discardLocal) {
      console.warn(`[lease] checkout of ${local.nameId} replaces an event created on this box (discardLocal).`);
      return;
    }
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: `CHECKOUT_LOCAL_EVENT: "${local.nameId}" exists on this box but was never checked out from the cloud; checking out would replace it.`,
    });
  }
  // One last ship cycle, so a healthy link leaves nothing behind.
  try {
    await shipEventOnce(db, local, peerUrl, makePeerTransport(peerUrl, secret), { pull: false });
  } catch (err) {
    console.warn(`[lease] pre-checkout ship of ${local.nameId} failed (peer unreachable?): ${errMessage(err)}`);
  }
  const unshipped = await db.journalEntry.count({ where: { eventId: local.id, pushedAt: null } });
  if (unshipped > 0) {
    if (!discardLocal) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: `CHECKOUT_UNSHIPPED: ${unshipped} journal entries not yet on the cloud; checking out would discard them.`,
      });
    }
    console.warn(`[lease] checkout of ${local.nameId} discards ${unshipped} unshipped journal entries (discardLocal).`);
  }
}

export const leaseRouter = router({
  /** Lease + shipping state for the shell badge and the EventPage panel. */
  status: viewProcedure.query(async ({ ctx }) => {
    const lease = await getActiveLease(ctx.db, ctx.event.id);
    const peerUrl = syncPeerUrl();
    const shipping = peerUrl
      ? await shippingStatus(ctx.db, ctx.event.id, peerUrl)
      : null;
    return {
      nodeId: nodeId(),
      nodeRole: nodeRole(),
      peerConfigured: peerUrl !== null,
      lease: lease
        ? {
            holderNodeId: lease.holderNodeId,
            acquiredAt: lease.acquiredAt.toISOString(),
            forced: lease.forced,
            heldByThisNode: lease.holderNodeId === nodeId(),
          }
        : null,
      shipping,
    };
  }),

  // ─── Node-to-node surface (shared secret) ─────────────────

  acquire: peerProcedure
    .input(z.object({ holderNodeId: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const lease = await acquireLeaseForPeer(ctx.db, ctx.event.id, input.holderNodeId);
      return { ok: true as const, acquiredAt: lease.acquiredAt.toISOString() };
    }),

  release: peerProcedure
    .input(z.object({ holderNodeId: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      await releaseLeaseForPeer(ctx.db, ctx.event.id, input.holderNodeId);
      return { ok: true as const };
    }),

  /** Who holds the active lease, for a peer that wants to know whether it still does (takeover detection). */
  holder: peerProcedure.query(async ({ ctx }) => {
    const lease = await getActiveLease(ctx.db, ctx.event.id);
    return { holderNodeId: lease?.holderNodeId ?? null, schema: await schemaName(ctx.db) };
  }),

  exportSnapshot: peerProcedure.query(async ({ ctx }) => {
    return exportEventSnapshot(ctx.db, ctx.event);
  }),

  /** The full event row — source for the venue's settings refresh. */
  exportSettings: peerProcedure.query(async ({ ctx }) => {
    const row = await ctx.db.event.findUniqueOrThrow({
      where: { id: ctx.event.id },
    });
    return row as unknown as Record<string, unknown>;
  }),

  /**
   * One slice (≤ 4 MiB, base64) of a map blob the event's `map_files` pin,
   * or of a graphic the event draws — the bytes of the snapshot's `maps`
   * and `graphics` parts (docs/map-storage.md §7.2).
   */
  exportBlob: peerProcedure
    .input(exportBlobInput)
    .query(async ({ ctx, input }) => exportPeerBlobSlice(ctx.db, ctx.event.id, input)),

  /**
   * The event's cloud-owned map rows without bytes — the source of a box's
   * map refresh during a lease (row G19, docs/map-storage.md §7.2
   * "Following the cloud during a lease"). Bytes follow through `exportBlob`.
   */
  exportMapRows: peerProcedure.query(async ({ ctx }) => exportMapRows(ctx.db, ctx.event.id)),

  // ─── Operator surface ─────────────────────────────────────

  /**
   * Check an event out to THIS node (run on the venue box). Acquires the
   * lease on the peer first — from that moment the cloud rejects
   * race-critical writes — then imports the snapshot and records the local
   * lease. Public (not event-scoped) because the event may not exist
   * locally yet.
   *
   * A checkout replaces the box's copy of the event, so it refuses while the
   * copy would lose something: a lease still held here (`CHECKOUT_LEASE_HELD`),
   * an event the box created itself (`CHECKOUT_LOCAL_EVENT`) or journal
   * entries the cloud has not received (`CHECKOUT_UNSHIPPED`). The last two
   * are overridden with `discardLocal`. A graphic id that belongs to another
   * event on the box fails with `GRAPHIC_ID_CLASH` unless
   * `replaceClashingGraphics`. The messages start with the code, as
   * `PATCH_STALE` does, so the web can offer the matching confirmation.
   */
  checkout: publicProcedure
    .input(
      z.object({
        nameId: z.string().min(1),
        discardLocal: z.boolean().optional(),
        replaceClashingGraphics: z.boolean().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (ctx.authEnabled && !ctx.user) {
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "Not authenticated",
        });
      }
      const { peerUrl, secret } = requirePeer();
      const peer = makeLeasePeer(peerUrl, secret);
      const db = prisma();

      // Who may replace this box's copy: the event's managers, or for an
      // event the box does not hold yet, an instance admin.
      const local = await resolveLocalEvent(db, input.nameId);
      if (ctx.authEnabled) {
        if (local) {
          const caps = await capabilitiesForContext({ ...ctx, event: local, db } as EventContext);
          if (!caps.has("event.manage")) {
            throw new TRPCError({ code: "FORBIDDEN", message: "Missing capability event.manage" });
          }
        } else if (!ctx.user?.isAdmin) {
          throw new TRPCError({ code: "FORBIDDEN", message: "Admin access required" });
        }
      }
      if (local) await assertCheckoutMayReplace(db, local, peerUrl, secret, input.discardLocal === true);

      let peerAcquired = false;
      try {
        try {
          await peer.acquire(input.nameId, nodeId());
        } catch (err) {
          // A clear refusal (someone else holds it, no such event, bad
          // credentials): the peer took nothing, nothing of ours to roll
          // back. Anything else (a lost reply, a 5xx) is an unknown
          // outcome: roll back below.
          if (!acquireMayHaveSucceeded(err)) throw err;
          peerAcquired = true;
          throw err;
        }
        peerAcquired = true;

        const snapshot = await peer.exportSnapshot(input.nameId);
        // Different versions: rows still import (unknown columns are
        // ignored), but say so, so a box that lags the cloud is noticed.
        const localSchema = await schemaName(db);
        const peerSchema = snapshot.schema ?? null;
        const schemaDiffers = peerSchema !== null && localSchema !== null && peerSchema !== localSchema;
        if (schemaDiffers) {
          console.warn(
            `[lease] checkout of ${input.nameId}: the cloud's schema (${peerSchema}) differs from this box's (${localSchema}); unknown columns are ignored. Update the older node.`,
          );
        }
        // A graphic id another event on this box owns is not replaced
        // unasked (decision D10): refuse before any bytes are fetched.
        if (snapshot.graphics && !input.replaceClashingGraphics) {
          const clashes = await findGraphicClashes(db, snapshot.graphics, local?.id ?? null);
          if (clashes.length > 0) throw graphicClashError(clashes);
        }
        // Map blobs before the transaction: network reads, verified by hash.
        const blobs = snapshot.maps
          ? await fetchSnapshotBlobs(db, snapshot.maps, (table, hash, start, length) =>
              peer.exportBlob(input.nameId, { table, hash, start, length }),
            )
          : undefined;
        // Graphics the same way, by id (docs/map-storage.md §7.2).
        const graphicBlobs = snapshot.graphics
          ? await fetchSnapshotGraphics(db, snapshot.graphics, (id, start, length) =>
              peer.exportBlob(input.nameId, { table: "graphics", id, start, length }),
            )
          : undefined;
        const event = await importEventSnapshot(db, snapshot, blobs, graphicBlobs, {
          // Committed with the import: the sync-state row (which scopes the
          // shipper to this event) and the local lease. Journal-from-there:
          // the snapshot holds history, and the cloud marked its journal
          // delivered when it handed out the lease, so pulls start clean.
          replaceOtherEvents: input.replaceClashingGraphics === true,
          afterImport: async (tx, eventId) => {
            await tx.journalSyncState.upsert({
              where: { peerId_eventId: { peerId: peerUrl, eventId } },
              create: {
                peerId: peerUrl,
                eventId,
                pulledHlc: BigInt(snapshot.journalCursor.hlc),
                pulledId: snapshot.journalCursor.id,
              },
              update: {
                pulledHlc: BigInt(snapshot.journalCursor.hlc),
                pulledId: snapshot.journalCursor.id,
                pushedHlc: 0n,
                pushedId: "",
              },
            });
            await acquireLease(tx, eventId, nodeId());
          },
        });
        return {
          ok: true as const,
          eventId: Number(event.id),
          ...(schemaDiffers ? { peerSchema, localSchema } : {}),
          imported: Object.fromEntries(
            Object.entries(snapshot.tables).map(([t, rows]) => [t, rows.length]),
          ),
          maps: {
            files: snapshot.maps?.files.length ?? 0,
            sources: snapshot.maps?.sources.length ?? 0,
            documents: snapshot.maps?.documents.length ?? 0,
            fetchedBytes: blobs?.fetchedBytes ?? 0,
            skipped: snapshot.maps?.skipped ?? 0,
            decisions: snapshot.maps?.decisions?.length ?? 0,
            patches: snapshot.maps?.patch ? 1 : 0,
          },
          graphics: {
            rows: snapshot.graphics?.length ?? 0,
            fetchedBytes: graphicBlobs?.fetchedBytes ?? 0,
          },
        };
      } catch (err) {
        // Roll the peer lease back so a failed import doesn't leave the
        // event stranded in checked-out limbo.
        if (peerAcquired) {
          await peer.release(input.nameId, nodeId()).catch((relErr) => {
            console.error(
              `[lease] checkout of ${input.nameId} failed and the lease on the peer could not be released (${errMessage(relErr)}): retry the checkout (taking the lease again is a no-op for this node), or force a takeover on the cloud.`,
            );
          });
        }
        throw err;
      }
    }),

  /**
   * Check the event back in (run on the venue box). A barrier: every local
   * journal entry must be shipped and acked before the peer resumes
   * writing. Runs one final ship cycle first, so a healthy link needs no
   * separate "wait for the shipper". While the barrier runs, race writes on
   * this box are refused (they would land after the count and never ship).
   * Restart-safe: the peer's release is idempotent for this holder, and a
   * peer that already lets go (a takeover, or a lost reply) does not strand
   * the box.
   */
  checkin: manageProcedure.mutation(async ({ ctx }) => {
    const { peerUrl, secret } = requirePeer();
    const lease = await getActiveLease(ctx.db, ctx.event.id);
    if (!lease) {
      // A box that already let go (it released itself after a takeover, or an
      // earlier checkin got that far) has nothing left to do: report it, so a
      // retried or late checkin is not an error.
      const latest = await ctx.db.eventLease.findFirst({
        where: { eventId: ctx.event.id },
        orderBy: { id: "desc" },
        select: { holderNodeId: true },
      });
      if (latest?.holderNodeId === nodeId()) {
        const stats = await shipEventOnce(ctx.db, ctx.event, peerUrl, makePeerTransport(peerUrl, secret), { pull: false });
        const { pendingPush } = await shippingStatus(ctx.db, ctx.event.id, peerUrl);
        if (pendingPush > 0) {
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message: `${pendingPush} journal entr(ies) of this released copy are not yet on the cloud (${stats.errors.length} error(s)). Fix connectivity and retry.`,
          });
        }
        return { ok: true as const, pushed: stats.pushed, alreadyReleased: true as const };
      }
    }
    if (!lease || lease.holderNodeId !== nodeId()) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: "This node does not hold the lease for this event.",
      });
    }

    beginCheckin(ctx.event.id);
    try {
      const stats = await shipEventOnce(
        ctx.db,
        ctx.event,
        peerUrl,
        makePeerTransport(peerUrl, secret),
      );
      const shipping = await shippingStatus(ctx.db, ctx.event.id, peerUrl);
      if (shipping.pendingPush > 0) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: `Checkin barrier: ${shipping.pendingPush} journal entr(ies) not yet acked by the peer (${stats.errors.length} error(s)). Fix connectivity and retry.`,
        });
      }

      const peer = makeLeasePeer(peerUrl, secret);
      let peerAlreadyReleased = false;
      try {
        await peer.release(ctx.event.nameId, nodeId());
      } catch (err) {
        // The peer no longer lists this box as holder (taken over, or the
        // lease moved on): every entry is delivered, so let go locally.
        const code = errorCode(err);
        const noLease = code === "PRECONDITION_FAILED" && errMessage(err).includes("No active lease");
        if (code !== "CONFLICT" && !noLease) throw err;
        peerAlreadyReleased = true;
        console.warn(`[lease] checkin of ${ctx.event.nameId}: the peer no longer holds this box's lease (${errMessage(err)}); releasing locally.`);
      }
      const still = await getActiveLease(ctx.db, ctx.event.id);
      if (still && still.holderNodeId === nodeId()) {
        await releaseLease(ctx.db, ctx.event.id, {
          expectedHolder: nodeId(),
          forced: peerAlreadyReleased,
        });
      }
      return {
        ok: true as const,
        pushed: stats.pushed,
        ...(peerAlreadyReleased ? { peerAlreadyReleased: true as const } : {}),
      };
    } finally {
      endCheckin(ctx.event.id);
    }
  }),

  /**
   * Take control back on THIS node without the holder's cooperation — the
   * venue-box-died path. Requires explicit confirmation; the recovery point
   * is whatever the box shipped before dying. A revived box's un-shipped
   * entries drain later through `events.push` (loud, logged).
   */
  forceTakeover: manageProcedure
    .input(z.object({ confirm: z.literal(true) }))
    .mutation(async ({ ctx }) => {
      const lease = await getActiveLease(ctx.db, ctx.event.id);
      if (!lease) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "No active lease to take over.",
        });
      }
      if (lease.holderNodeId === nodeId()) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "This node already holds the lease.",
        });
      }
      console.warn(
        `[lease] FORCE TAKEOVER of event ${ctx.event.nameId} from node "${lease.holderNodeId}" — un-shipped venue entries will drain via events.push when the box revives.`,
      );
      await releaseLease(ctx.db, ctx.event.id, { forced: true });
      return { ok: true as const, takenFrom: lease.holderNodeId };
    }),
});
