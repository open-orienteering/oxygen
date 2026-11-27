import type {
  OxygenEvent,
  EventType,
  EventPayload,
  CardReadPayload,
  ResultAppliedPayload,
  StartRecordedPayload,
  RunnerRegisteredPayload,
} from "./db";
import { offlineDb } from "./db";
import { type Hlc, HLC_ZERO, tickHlc, compareHlc } from "@oxygen/shared";

let stationId: string | null = null;

const HLC_STORAGE_KEY = "oxygen-hlc";

/** In-memory fallbacks for when site storage is blocked or full (SYNC-24). */
let memoryHlc: Hlc | null = null;

function readStorage(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* blocked or full: the in-memory copy still keeps the clock monotonic */
  }
}

/**
 * Stamp the next HLC for a locally-emitted entry, advancing the device's
 * persisted clock. A per-device monotonic sort key — the server folds
 * received stamps into its own clock on ingestion. Storage failures fall back
 * to an in-memory clock: losing the entry over a blocked localStorage would be
 * far worse than a clock that restarts after a reload.
 */
function getNextHlc(): Hlc {
  let last: Hlc = memoryHlc ?? HLC_ZERO;
  try {
    const stored = readStorage(HLC_STORAGE_KEY);
    if (stored) {
      const parsed = JSON.parse(stored) as Hlc;
      if (!memoryHlc || compareHlc(parsed, memoryHlc) >= 0) last = parsed;
    }
  } catch {
    /* corrupt clock → keep the in-memory one (or restart from zero) */
  }
  const next = tickHlc(last, Date.now());
  memoryHlc = next;
  writeStorage(HLC_STORAGE_KEY, JSON.stringify(next));
  return next;
}

function getStationId(): string {
  if (!stationId) {
    const stored = readStorage("oxygen-station-id");
    if (stored) {
      stationId = stored;
    } else {
      stationId = crypto.randomUUID();
      writeStorage("oxygen-station-id", stationId);
    }
  }
  return stationId;
}

function createEvent(
  type: EventType,
  competitionId: string,
  payload: EventPayload,
): OxygenEvent {
  return {
    id: crypto.randomUUID(),
    type,
    competitionId,
    stationId: getStationId(),
    timestamp: Date.now(),
    hlc: getNextHlc(),
    schemaVersion: 1,
    actorId: null,
    payload,
    status: "pending",
    attempts: 0,
  };
}

// ─── Enqueue signal ─────────────────────────────────────────
//
// The auto-drain must start when an entry is queued, not when a poll happens
// to see the pending count grow (an entry queued while the previous one drains
// leaves the count unchanged). Every queueing bumps a module-level sequence
// and tells the listeners.

let enqueueSeq = 0;
const enqueueListeners = new Set<() => void>();

/** Monotonic count of entries queued (or requeued) by this page since load. */
export function getEnqueueSeq(): number {
  return enqueueSeq;
}

/** Call `listener` after every queued entry; returns the unsubscribe. */
export function subscribeEnqueue(listener: () => void): () => void {
  enqueueListeners.add(listener);
  return () => {
    enqueueListeners.delete(listener);
  };
}

function signalEnqueue(): void {
  enqueueSeq++;
  for (const listener of [...enqueueListeners]) {
    try {
      listener();
    } catch {
      /* a listener must not break queueing */
    }
  }
}

/**
 * Store an event in the local IndexedDB queue.
 * Returns the event (with generated id) for optimistic UI updates.
 */
export async function emitEvent(
  type: EventType,
  competitionId: string,
  payload: EventPayload,
): Promise<OxygenEvent> {
  const event = createEvent(type, competitionId, payload);
  await offlineDb.events.add(event);
  signalEnqueue();
  return event;
}

// ─── Typed convenience helpers ──────────────────────────────

export function emitCardRead(competitionId: string, payload: CardReadPayload) {
  return emitEvent("card.read", competitionId, payload);
}

export function emitResultApplied(competitionId: string, payload: ResultAppliedPayload) {
  return emitEvent("result.applied", competitionId, payload);
}

export function emitStartRecorded(competitionId: string, payload: StartRecordedPayload) {
  return emitEvent("start.recorded", competitionId, payload);
}

export function emitRunnerRegistered(competitionId: string, payload: RunnerRegisteredPayload) {
  return emitEvent("runner.registered", competitionId, payload);
}

// ─── Queue queries ──────────────────────────────────────────

export async function getPendingEvents(competitionId?: string) {
  let query = offlineDb.events.where("status").equals("pending");
  if (competitionId) {
    query = query.and((e) => e.competitionId === competitionId);
  }
  return query.sortBy("timestamp");
}

export async function getPendingCount(competitionId?: string): Promise<number> {
  if (competitionId) {
    return offlineDb.events
      .where("status")
      .equals("pending")
      .and((e) => e.competitionId === competitionId)
      .count();
  }
  return offlineDb.events.where("status").equals("pending").count();
}

export async function markSynced(eventId: string) {
  await offlineDb.events.update(eventId, { status: "synced" });
}

export async function markFailed(eventId: string, error: string) {
  const event = await offlineDb.events.get(eventId);
  if (event) {
    await offlineDb.events.update(eventId, {
      status: "failed",
      error,
      attempts: event.attempts + 1,
    });
  }
}

// ─── Drain rejections (pivot Step 6) ────────────────────────
//
// A failed entry means the server REJECTED the apply (as opposed to a
// network error, which leaves entries pending). These must be loud in the
// station UI — a silently dropped finish is the one unforgivable failure
// mode — and the operator decides: retry (after fixing the cause) or
// discard (the entry is wrong, e.g. a stale-card artifact).

export async function getFailedEvents(competitionId?: string) {
  let query = offlineDb.events.where("status").equals("failed");
  if (competitionId) {
    query = query.and((e) => e.competitionId === competitionId);
  }
  return query.sortBy("timestamp");
}

export async function getFailedCount(competitionId?: string): Promise<number> {
  let query = offlineDb.events.where("status").equals("failed");
  if (competitionId) {
    query = query.and((e) => e.competitionId === competitionId);
  }
  return query.count();
}

/** Requeue a failed entry — the next drain retries it. */
export async function retryFailedEvent(eventId: string): Promise<void> {
  await offlineDb.events.update(eventId, {
    status: "pending",
    error: undefined,
    capability: undefined,
    rejectedBySchema: undefined,
  });
  signalEnqueue();
}

/** Requeue every failed entry (optionally for one event). */
export async function retryAllFailedEvents(
  competitionId?: string,
): Promise<number> {
  const failed = await getFailedEvents(competitionId);
  for (const e of failed) {
    await retryFailedEvent(e.id);
  }
  return failed.length;
}

/** Drop a failed entry for good. Deliberate operator action only. */
export async function discardFailedEvent(eventId: string): Promise<void> {
  await offlineDb.events.delete(eventId);
}
