import type { Capability } from "@oxygen/shared";
import { offlineDb, type OxygenEvent } from "./db";
import { trpcClientForEvent } from "../trpc";
import { recordClockSkew } from "./clock-skew";
import { isNetworkFailure } from "../trpc-links";

const BATCH_SIZE = 50;

/**
 * Why the last drain stopped.
 * - "auth": the server refused the push (a device with only a kiosk key, or a
 *   session that ended): the entries stay pending until an operator signs in,
 *   which is not a network error and must not look like one (D11, SYNC-03).
 * - "event": the server does not know the event the entries belong to (the
 *   batch was rejected as malformed and an empty probe was too).
 * - "server": the server answered 5xx / an HTML error page.
 */
export type DrainBlockedReason = "auth" | "event" | "server";

/** Per competition: one competition's block says nothing about another's. */
const blockedReasons = new Map<string, DrainBlockedReason>();
export function getDrainBlockedReason(competitionId: string | undefined): DrainBlockedReason | null {
  return (competitionId && blockedReasons.get(competitionId)) || null;
}

/**
 * Failure codes after which the server stopped the batch (the entries behind
 * the failed one came back in neither list). A pending entry ordered behind
 * one of these in the same competition is held until the operator retries or
 * discards the failed entry, so a later finish / result never applies before
 * a failed registration. A refusal that does not stop the server (FORBIDDEN,
 * COMPETITION_MISMATCH, ...) holds nothing.
 */
const BATCH_STOPPING_CODES: ReadonlySet<string> = new Set(["APPLY_FAILED", "INVALID_PAYLOAD"]);

/** tRPC UNAUTHORIZED / FORBIDDEN from a failed push. */
export function isAuthRefusal(err: unknown): boolean {
  const code = errorCode(err);
  return code === "UNAUTHORIZED" || code === "FORBIDDEN";
}

function errorCode(err: unknown): string | undefined {
  return (err as { data?: { code?: string } } | null)?.data?.code;
}

type FailureKind = "network" | "auth" | "bad-request" | "server";

/** Sort a thrown push error into what the drain does about it (BLD-25). */
export function classifyPushError(err: unknown): FailureKind {
  if (isNetworkFailure(err)) return "network";
  if (isAuthRefusal(err)) return "auth";
  if (errorCode(err) === "BAD_REQUEST") return "bad-request";
  // INTERNAL_SERVER_ERROR, 5xx, an HTML answer from a proxy, anything unknown:
  // the entries are fine, the server is not.
  return "server";
}

// ─── Wire shapes and the injectable drain ───────────────────

export interface PushEntry {
  id: string;
  type: string;
  competitionId: string;
  stationId: string;
  timestamp: number;
  hlc?: { physical: number; logical: number };
  schemaVersion?: number;
  actorId?: string | null;
  payload: Record<string, unknown>;
}

export interface PushResult {
  synced: string[];
  failed: Array<{ id: string; error: string; capability?: Capability }>;
  serverTimeMs?: number;
}

export type PushFn = (input: { events: PushEntry[] }) => Promise<PushResult>;

export interface EventStore {
  /** Pending entries ordered by timestamp, optionally for one competition. */
  pending(competitionId?: string): Promise<OxygenEvent[]>;
  /** Failed entries of one competition. */
  failed(competitionId: string): Promise<OxygenEvent[]>;
  get(id: string): Promise<OxygenEvent | undefined>;
  update(id: string, patch: Partial<OxygenEvent>): Promise<void>;
  bulkDelete(ids: string[]): Promise<void>;
  syncedOlderThan(cutoff: number): Promise<OxygenEvent[]>;
}

export const dexieEventStore: EventStore = {
  async pending(competitionId) {
    let query = offlineDb.events.where("status").equals("pending");
    if (competitionId) query = query.and((e) => e.competitionId === competitionId);
    return query.sortBy("timestamp");
  },
  async failed(competitionId) {
    return offlineDb.events
      .where("status")
      .equals("failed")
      .and((e) => e.competitionId === competitionId)
      .toArray();
  },
  get: (id) => offlineDb.events.get(id),
  async update(id, patch) {
    await offlineDb.events.update(id, patch);
  },
  async bulkDelete(ids) {
    await offlineDb.events.bulkDelete(ids);
  },
  syncedOlderThan(cutoff) {
    return offlineDb.events
      .where("status")
      .equals("synced")
      .and((e) => e.timestamp < cutoff)
      .toArray();
  },
};

export function serializeEvent(event: OxygenEvent): PushEntry {
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

export interface EventDrainerDeps {
  store: EventStore;
  /** The push for one competition: header and `?event=` come from that id, never from the URL. */
  pushFor: (competitionId: string) => PushFn;
  now?: () => number;
}

export function createEventDrainer({ store, pushFor, now = Date.now }: EventDrainerDeps) {
  /** Competitions with a drain running. A drain of B never waits for A (MC-01). */
  const draining = new Set<string>();

  async function markFailure(
    failure: PushResult["failed"][number],
  ): Promise<void> {
    console.warn(`[offline-sync] Event ${failure.id} failed:`, failure.error);
    const event = await store.get(failure.id);
    if (!event) return;
    await store.update(failure.id, {
      status: "failed",
      error: failure.error,
      capability: failure.capability,
      attempts: event.attempts + 1,
    });
  }

  /** Apply a push answer; returns how many entries it settled (synced + failed). */
  async function applyResult(result: PushResult): Promise<{ synced: number; settled: number }> {
    if (typeof result.serverTimeMs === "number") {
      recordClockSkew(result.serverTimeMs, now());
    }
    for (const id of result.synced) await store.update(id, { status: "synced" });
    for (const failure of result.failed) await markFailure(failure);
    return { synced: result.synced.length, settled: result.synced.length + result.failed.length };
  }

  /** `stop`: this drain pass ends (the rest stays pending). */
  type Step = { synced: number; stop: boolean; stopAll: boolean };

  /** The batch was malformed to the server: is it the event or one entry? */
  async function resolveBadRequest(competitionId: string, events: OxygenEvent[]): Promise<Step> {
    const push = pushFor(competitionId);
    try {
      await push({ events: [] });
    } catch (probeErr) {
      // Even an empty batch is refused under this header: the server does not
      // know the event. Nothing is wrong with the entries.
      if (isNetworkFailure(probeErr)) return { synced: 0, stop: true, stopAll: true };
      blockedReasons.set(competitionId, classifyPushError(probeErr) === "auth" ? "auth" : "event");
      return { synced: 0, stop: true, stopAll: false };
    }
    let synced = 0;
    for (const event of events) {
      try {
        const result = await push({ events: [serializeEvent(event)] });
        synced += (await applyResult(result)).synced;
      } catch (err) {
        const kind = classifyPushError(err);
        if (kind === "bad-request") {
          const current = await store.get(event.id);
          await store.update(event.id, {
            status: "failed",
            error: "INVALID_PAYLOAD",
            capability: undefined,
            attempts: (current?.attempts ?? event.attempts) + 1,
          });
          continue;
        }
        if (kind === "network") return { synced, stop: true, stopAll: true };
        blockedReasons.set(competitionId, kind === "auth" ? "auth" : "server");
        return { synced, stop: true, stopAll: false };
      }
    }
    return { synced, stop: false, stopAll: false };
  }

  /**
   * The pending entries that may go out: those ordered before the earliest
   * failed entry the server stopped a batch at. Everything behind it waits
   * until that entry is retried (it is pending again, so it goes first) or
   * discarded.
   */
  async function sendable(competitionId: string): Promise<OxygenEvent[]> {
    const pending = await store.pending(competitionId);
    const stops = (await store.failed(competitionId))
      .filter((e) => e.error && BATCH_STOPPING_CODES.has(e.error))
      .map((e) => e.timestamp);
    if (stops.length === 0) return pending;
    const limit = Math.min(...stops);
    return pending.filter((e) => e.timestamp < limit);
  }

  async function drainOne(competitionId: string): Promise<Step> {
    let synced = 0;
    while (true) {
      const events = (await sendable(competitionId)).slice(0, BATCH_SIZE);
      if (events.length === 0) break;

      try {
        console.log(`[offline-sync] Pushing ${events.length} events to ${competitionId}...`, events.map((e) => e.type));
        const result = await pushFor(competitionId)({ events: events.map(serializeEvent) });
        console.log(`[offline-sync] Push result: ${result.synced.length} synced, ${result.failed.length} failed`);
        const applied = await applyResult(result);
        synced += applied.synced;
        // The server stopped its batch at a failed entry: the rest of this
        // competition waits behind it (see `sendable`).
        if (result.failed.some((f) => BATCH_STOPPING_CODES.has(f.error))) {
          return { synced, stop: true, stopAll: false };
        }
        // An answer that settled nothing would repeat forever.
        if (applied.settled === 0) break;
      } catch (err) {
        const kind = classifyPushError(err);
        console.warn("[offline-sync] Failed to push events, will retry later:", err);
        if (kind === "network") return { synced, stop: true, stopAll: true };
        if (kind === "bad-request") {
          const step = await resolveBadRequest(competitionId, events);
          synced += step.synced;
          if (step.stop) return { synced, stop: true, stopAll: step.stopAll };
          continue;
        }
        blockedReasons.set(competitionId, kind === "auth" ? "auth" : "server");
        return { synced, stop: true, stopAll: false };
      }
    }
    return { synced, stop: false, stopAll: false };
  }

  /**
   * Drain the pending queue in order, every competition's entries under that
   * competition's own header. With a `competitionId` only that one drains.
   * Returns the number of entries synced.
   */
  async function drain(competitionId?: string): Promise<number> {
    const ids = competitionId
      ? [competitionId]
      : [...new Set((await store.pending()).map((e) => e.competitionId))];
    let syncedCount = 0;
    for (const id of ids) {
      if (draining.has(id)) continue;
      draining.add(id);
      blockedReasons.delete(id);
      try {
        const step = await drainOne(id);
        syncedCount += step.synced;
        if (step.stopAll) break;
      } finally {
        draining.delete(id);
      }
    }
    return syncedCount;
  }

  /** Delete synced entries older than 24 hours; pending and failed stay. */
  async function cleanupSynced(): Promise<number> {
    const old = await store.syncedOlderThan(now() - 24 * 60 * 60 * 1000);
    if (old.length > 0) await store.bulkDelete(old.map((e) => e.id));
    return old.length;
  }

  return { drain, cleanupSynced };
}

const dexieDrainer = createEventDrainer({
  store: dexieEventStore,
  pushFor: (competitionId) => (input) =>
    trpcClientForEvent(competitionId).events.push.mutate(input as never) as Promise<PushResult>,
});

/** Drain the pending event queue; called when connectivity is restored. */
export const drainEventQueue = dexieDrainer.drain;

/** Clean up old synced events (older than 24 hours). */
export const cleanupSyncedEvents = dexieDrainer.cleanupSynced;
