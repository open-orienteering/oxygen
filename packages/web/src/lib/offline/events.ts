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

let stationId: string | null = null;

function getStationId(): string {
  if (!stationId) {
    const stored = localStorage.getItem("oxygen-station-id");
    if (stored) {
      stationId = stored;
    } else {
      stationId = crypto.randomUUID();
      localStorage.setItem("oxygen-station-id", stationId);
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
    payload,
    status: "pending",
    attempts: 0,
  };
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
