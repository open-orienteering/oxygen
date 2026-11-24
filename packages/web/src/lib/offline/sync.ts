import { offlineDb, type OxygenEvent } from "./db";
import { trpcVanillaClient } from "../trpc";
import { recordClockSkew } from "./clock-skew";

const BATCH_SIZE = 50;
let draining = false;

/**
 * Why the last drain stopped. "auth" = the server refused the push (a device
 * with only a kiosk key, or a session that ended): the entries stay pending on
 * this device until an operator signs in, which is not a network error and
 * must not look like one (D11, SYNC-03).
 */
let blockedReason: "auth" | null = null;
export function getDrainBlockedReason(): "auth" | null {
  return blockedReason;
}

/** tRPC UNAUTHORIZED / FORBIDDEN from a failed push. */
export function isAuthRefusal(err: unknown): boolean {
  const code = (err as { data?: { code?: string } } | null)?.data?.code;
  return code === "UNAUTHORIZED" || code === "FORBIDDEN";
}

/**
 * Drain the pending event queue, sending events to the server in order.
 * Called when connectivity is restored.
 *
 * Returns the number of successfully synced events.
 */
export async function drainEventQueue(competitionId?: string): Promise<number> {
  if (draining) return 0;
  draining = true;

  let syncedCount = 0;
  blockedReason = null;

  try {
    while (true) {
      // Fetch next batch of pending events
      let query = offlineDb.events.where("status").equals("pending");
      if (competitionId) {
        query = query.and((e) => e.competitionId === competitionId);
      }
      const batch = await query.sortBy("timestamp");
      const events = batch.slice(0, BATCH_SIZE);

      if (events.length === 0) break;

      // Try to sync the batch
      try {
        console.log(`[offline-sync] Pushing ${events.length} events...`, events.map(e => e.type));
        const result = await trpcVanillaClient.events.push.mutate({
          events: events.map(serializeEvent),
        });
        console.log(`[offline-sync] Push result: ${result.synced.length} synced, ${result.failed.length} failed`);

        // Detect a skewed local clock from the server's response time.
        if (typeof result.serverTimeMs === "number") {
          recordClockSkew(result.serverTimeMs, Date.now());
        }

        // Mark synced events
        for (const id of result.synced) {
          await offlineDb.events.update(id, { status: "synced" });
          syncedCount++;
        }

        // Mark failed events
        for (const failure of result.failed) {
          console.warn(`[offline-sync] Event ${failure.id} failed:`, failure.error);
          const event = await offlineDb.events.get(failure.id);
          if (event) {
            await offlineDb.events.update(failure.id, {
              status: "failed",
              error: failure.error,
              attempts: event.attempts + 1,
            });
          }
        }
      } catch (err) {
        // Network error or refusal — stop draining, will retry later
        if (isAuthRefusal(err)) blockedReason = "auth";
        console.warn("[offline-sync] Failed to push events, will retry later:", err);
        break;
      }
    }
  } finally {
    draining = false;
  }

  return syncedCount;
}

function serializeEvent(event: OxygenEvent) {
  return {
    id: event.id,
    type: event.type,
    competitionId: event.competitionId,
    stationId: event.stationId,
    timestamp: event.timestamp,
    hlc: event.hlc,
    schemaVersion: event.schemaVersion,
    actorId: event.actorId,
    payload: event.payload as unknown as Record<string, unknown>,
  };
}

/**
 * Clean up old synced events (older than 24 hours).
 */
export async function cleanupSyncedEvents(): Promise<number> {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  const old = await offlineDb.events
    .where("status")
    .equals("synced")
    .and((e) => e.timestamp < cutoff)
    .toArray();

  if (old.length > 0) {
    await offlineDb.events.bulkDelete(old.map((e) => e.id));
  }
  return old.length;
}
