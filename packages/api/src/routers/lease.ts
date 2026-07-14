/**
 * Per-event lease router (pivot Step 4).
 *
 * Two audiences:
 *   - **Node-to-node** (peerProcedure, shared-secret): `acquire`, `release`,
 *     `exportSnapshot` — the cloud-side surface a venue's checkout/checkin
 *     drives.
 *   - **Operator** (public/eventProcedure): `status` for the shell badge,
 *     `checkout`/`checkin` on the venue box, `forceTakeover` on the node
 *     that needs control back after a venue box died.
 *
 * See docs/offline-architecture.md § "The lease".
 */

import { z } from "zod";
import { TRPCError } from "@trpc/server";
import {
  router,
  publicProcedure,
  eventProcedure,
  peerProcedure,
} from "../trpc.js";
import { prisma } from "../db.js";
import {
  acquireLease,
  releaseLease,
  getActiveLease,
  exportEventSnapshot,
  importEventSnapshot,
  shippingStatus,
  makeLeasePeer,
} from "../sync/lease.js";
import { shipEventOnce, makePeerTransport } from "../sync/shipper.js";
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

export const leaseRouter = router({
  /** Lease + shipping state for the shell badge and the EventPage panel. */
  status: eventProcedure.query(async ({ ctx }) => {
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
      const lease = await acquireLease(ctx.db, ctx.event.id, input.holderNodeId);
      return { ok: true as const, acquiredAt: lease.acquiredAt.toISOString() };
    }),

  release: peerProcedure
    .input(z.object({ holderNodeId: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      await releaseLease(ctx.db, ctx.event.id, {
        expectedHolder: input.holderNodeId,
      });
      return { ok: true as const };
    }),

  exportSnapshot: peerProcedure.query(async ({ ctx }) => {
    return exportEventSnapshot(ctx.db, ctx.event);
  }),

  // ─── Operator surface ─────────────────────────────────────

  /**
   * Check an event out to THIS node (run on the venue box). Acquires the
   * lease on the peer first — from that moment the cloud rejects
   * race-critical writes — then imports the snapshot and records the local
   * lease. Public (not event-scoped) because the event may not exist
   * locally yet.
   */
  checkout: publicProcedure
    .input(z.object({ nameId: z.string().min(1) }))
    .mutation(async ({ input }) => {
      const { peerUrl, secret } = requirePeer();
      const peer = makeLeasePeer(peerUrl, secret);
      const db = prisma();

      await peer.acquire(input.nameId, nodeId());
      try {
        const snapshot = await peer.exportSnapshot(input.nameId);
        const event = await importEventSnapshot(db, snapshot);
        // Journal-from-there: pulls start at the exporter's journal head;
        // history before it is baked into the snapshot. Push starts empty.
        await db.journalSyncState.upsert({
          where: {
            peerId_eventId: { peerId: peerUrl, eventId: event.id },
          },
          create: {
            peerId: peerUrl,
            eventId: event.id,
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
        await acquireLease(db, event.id, nodeId());
        return {
          ok: true as const,
          eventId: Number(event.id),
          imported: Object.fromEntries(
            Object.entries(snapshot.tables).map(([t, rows]) => [t, rows.length]),
          ),
        };
      } catch (err) {
        // Roll the peer lease back so a failed import doesn't leave the
        // event stranded in checked-out limbo.
        await peer.release(input.nameId, nodeId()).catch(() => {});
        throw err;
      }
    }),

  /**
   * Check the event back in (run on the venue box). A barrier: every local
   * journal entry must be shipped and acked before the peer resumes
   * writing. Runs one final ship cycle first, so a healthy link needs no
   * separate "wait for the shipper".
   */
  checkin: eventProcedure.mutation(async ({ ctx }) => {
    const { peerUrl, secret } = requirePeer();
    const lease = await getActiveLease(ctx.db, ctx.event.id);
    if (!lease || lease.holderNodeId !== nodeId()) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: "This node does not hold the lease for this event.",
      });
    }

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
    await peer.release(ctx.event.nameId, nodeId());
    await releaseLease(ctx.db, ctx.event.id, { expectedHolder: nodeId() });
    return { ok: true as const, pushed: stats.pushed };
  }),

  /**
   * Take control back on THIS node without the holder's cooperation — the
   * venue-box-died path. Requires explicit confirmation; the recovery point
   * is whatever the box shipped before dying. A revived box's un-shipped
   * entries drain later through `events.push` (loud, logged).
   */
  forceTakeover: eventProcedure
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
