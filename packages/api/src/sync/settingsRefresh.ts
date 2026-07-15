/**
 * Venue-side refresh of cloud-owned event settings (pivot Step 4 follow-up).
 *
 * While a lease is held, the venue's copy of the event row's cloud-owned
 * columns (fees, receipts, organizer info, webhooks, LiveResults config…)
 * goes stale — those mutations forward to the cloud and execute there. The
 * refresher pulls the peer's event row on a slow cadence and copies it over
 * the local one, EXCLUDING the results-closure fields the venue owns during
 * the lease (`zeroTime`) and the row identity.
 *
 * Staleness between refreshes is harmless by the boundary rule: nothing
 * cloud-owned feeds result computation. Directories (`club_directory`,
 * `runner_directory`) are not refreshed here — they change rarely and the
 * venue can run its own Eventor sync while online.
 */

import type { EventRef, PrismaClient } from "../db.js";
import { getActiveLease, type LeasePeer } from "./lease.js";
import { nodeId } from "./nodeIdentity.js";

/**
 * Fields never copied from the peer: row identity, the results-closure
 * fields the leaseholder owns (zero time; the event date feeds stale-punch
 * day-of-week detection), and lifecycle state.
 */
const EXCLUDED_FIELDS = new Set([
  "id",
  "nameId",
  "zeroTime",
  "date",
  "removed",
  "createdAt",
  "updatedAt",
]);

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
    Object.entries(row).filter(
      ([k, v]) => !EXCLUDED_FIELDS.has(k) && v !== undefined,
    ),
  );
  if (Object.keys(data).length === 0) return false;
  await db.event.update({ where: { id: event.id }, data: data as never });
  return true;
}
