/**
 * Venue-side sync of the event row during a lease (pivot Step 4 follow-up;
 * review MC-08; docs/system/offline-architecture.md "The event row during a
 * lease").
 *
 * The row has three kinds of columns (`eventOwnership.ts`):
 * - cloud-owned (name, organizer, fees, LiveResults, Eventor, layout flags…):
 *   their mutations forward to the cloud, so the box's copy goes stale. The
 *   refresher pulls the peer's row on a slow cadence and copies these over the
 *   local one.
 * - venue-owned (kiosk key, card fee, receipts and payment, AIR+, the Sheets
 *   backup, zero time, date, time zone): edited on the box during the lease,
 *   so the refresh leaves them alone and `pushVenueOwnedSettings` sends them
 *   to the cloud, which refuses its own edits of them meanwhile.
 * - identity and lifecycle: never copied.
 *
 * Staleness between refreshes is harmless by the boundary rule: nothing
 * cloud-owned feeds result computation. Directories (`club_directory`,
 * `runner_directory`) are not refreshed here — they change rarely and the
 * venue can run its own Eventor sync while online.
 */

import { TRPCError } from "@trpc/server";
import { knownFields } from "./knownFields.js";
import type { EventRef, PrismaClient } from "../db.js";
import { getActiveLease, type LeasePeer } from "./lease.js";
import { nodeId } from "./nodeIdentity.js";
import { EVENT_IDENTITY_FIELDS, VENUE_OWNED_EVENT_FIELDS, pickVenuePushedFields } from "./eventOwnership.js";

/**
 * Pull the peer's event row and copy the cloud-owned columns over the local
 * one. No-op unless THIS node holds the event's active lease. Returns true
 * when a refresh happened.
 */
export async function refreshCloudOwnedSettings(
  db: PrismaClient,
  event: EventRef,
  peer: LeasePeer,
): Promise<boolean> {
  const lease = await getActiveLease(db, event.id);
  if (!lease || lease.holderNodeId !== nodeId()) return false;

  const row = await peer.exportSettings(event.nameId);
  const data = Object.fromEntries(
    Object.entries(knownFields("event", row)).filter(
      ([k, v]) => !EVENT_IDENTITY_FIELDS.has(k) && !VENUE_OWNED_EVENT_FIELDS.has(k) && v !== undefined,
    ),
  );
  if (Object.keys(data).length === 0) return false;
  await db.event.update({ where: { id: event.id }, data: data as never });
  return true;
}

/**
 * Send this box's venue-owned settings to the peer (`lease.importSettings`).
 * No-op unless THIS node holds the event's active lease. Returns true when a
 * push happened. Idempotent: the peer overwrites its columns with the box's.
 */
export async function pushVenueOwnedSettings(
  db: PrismaClient,
  event: EventRef,
  peer: LeasePeer,
): Promise<boolean> {
  const lease = await getActiveLease(db, event.id);
  if (!lease || lease.holderNodeId !== nodeId()) return false;
  const row = await db.event.findUniqueOrThrow({ where: { id: event.id } });
  const settings = pickVenuePushedFields(row as unknown as Record<string, unknown>);
  await peer.importSettings(event.nameId, settings);
  return true;
}

/**
 * The cloud side of `pushVenueOwnedSettings` (`lease.importSettings`): write
 * the venue-owned columns `settings` carries, only when `peerNodeId` holds the
 * event's active lease. Keys that are not venue-owned, or that this schema
 * lacks, are dropped. Returns how many columns were written.
 */
export async function importVenueOwnedSettings(
  db: PrismaClient,
  eventId: bigint,
  peerNodeId: string | null | undefined,
  settings: Record<string, unknown>,
): Promise<number> {
  const lease = await getActiveLease(db, eventId);
  if (!lease || !peerNodeId || lease.holderNodeId !== peerNodeId) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: `Node "${peerNodeId ?? "(no node id)"}" does not hold the lease for this event; its settings are not taken.`,
    });
  }
  const data = pickVenuePushedFields(knownFields("event", settings));
  if (Object.keys(data).length > 0) {
    await db.event.update({ where: { id: eventId }, data: data as never });
  }
  return Object.keys(data).length;
}
