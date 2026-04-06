import { offlineDb, type OxygenEvent } from "./db";
import { trpcVanillaClient } from "../trpc";

const BATCH_SIZE = 50;
let draining = false;

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
        const result = await trpcVanillaClient.events.push.mutate({
          events: events.map(serializeEvent),
        });

        // Mark synced events
        for (const id of result.synced) {
          await offlineDb.events.update(id, { status: "synced" });
          syncedCount++;
        }

        // Mark failed events
        for (const failure of result.failed) {
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
        // Network error — stop draining, will retry later
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
