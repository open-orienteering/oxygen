import Dexie, { type Table } from "dexie";
import type { CardReadPayload as JournalCardReadPayload } from "@oxygen/shared";

// ─── Event Types ────────────────────────────────────────────

export type EventType =
  | "card.read"
  | "finish.recorded"
  | "result.applied"
  | "start.recorded"
  | "runner.registered"
  | "runner.updated"
  | "punch.recorded";

export interface CardReadPayload {
  cardNo: number;
  punches: Array<{ controlCode: number; time: number }>;
  checkTime?: number;
  startTime?: number;
  finishTime?: number;
  cardType?: string;
  batteryVoltage?: number;
  punchesFresh?: boolean;
  ownerData?: Record<string, string | undefined>;
  metadata?: Record<string, string | number | undefined>;
}

export interface FinishRecordedPayload {
  runnerId: number;
  finishTime: number;
  cardNo: number;
}

export interface ResultAppliedPayload {
  runnerId: number;
  /** SI card number — lets the cloud resolve an offline-registered runner by
   * (eventId, cardNo) before any seq exists. Omitted for cardless runners. */
  cardNo?: number;
  status: number;
  finishTime: number;
  startTime: number;
}

export interface StartRecordedPayload {
  runnerId: number;
  startTime: number;
}

export interface RunnerRegisteredPayload {
  tempId: string;
  name: string;
  classId: number;
  clubId: number;
  cardNo: number;
  startTime?: number;
}

export interface RunnerUpdatedPayload {
  runnerId: number;
  fields: Record<string, unknown>;
}

export interface PunchRecordedPayload {
  cardNo: number;
  controlCode: number;
  time: number;
  origin: string;
}

export type EventPayload =
  | CardReadPayload
  | FinishRecordedPayload
  | ResultAppliedPayload
  | StartRecordedPayload
  | RunnerRegisteredPayload
  | RunnerUpdatedPayload
  | PunchRecordedPayload;

export interface OxygenEvent {
  id: string;
  type: EventType;
  competitionId: string;
  stationId: string;
  timestamp: number; // ms since epoch
  /** Hybrid logical clock stamped at emit (decoded {physical, logical}). */
  hlc?: { physical: number; logical: number };
  schemaVersion?: number;
  /** "who did this" — null until the permissions system ships. */
  actorId?: string | null;
  payload: EventPayload;
  status: "pending" | "synced" | "failed";
  error?: string;
  attempts: number;
}

// ─── Dexie Database ─────────────────────────────────────────

// ─── Snapshot-cache tables ──────────────────────────────────
//
// A durable, live-queryable snapshot cache of the per-event entities, for
// station reads during a connectivity blip. The runner/punch/readout tables
// are built as server snapshot + this station's own pending outbox writes
// replayed in order (see `projection.ts`); the reference tables (classes,
// courses, controls) are hydrated from tRPC snapshots verbatim. Every row
// carries `competitionId` because one IndexedDB is shared across all events.

/**
 * Cached runner row: the cloud snapshot (authoritative status/times) with the
 * station's own un-synced writes overlaid.
 */
export interface ProjRunner {
  /** Stable key: `card:<n>` for carded runners, else `id:<x>`. */
  id: string;
  competitionId: string;
  /** Cloud-allocated short id; null for offline-created until re-hydration. */
  seq: number | null;
  cardNo: number | null;
  name: string;
  startNo: number;
  /** Class seq. */
  classId: number | null;
  clubName: string;
  eventorClubId: number | null;
  /** Absolute deciseconds since midnight. */
  startTime: number;
  finishTime: number;
  /** RunnerStatus numeric (0=unknown, 1=ok, 3=mp, 4=dnf, …). */
  status: number;
}

/** Cached punch (grow-only set). `key` = `${competitionId}:${dedupeKey}`. */
export interface ProjPunch {
  key: string;
  competitionId: string;
  cardNo: number;
  controlCode: number;
  time: number;
  origin: string;
}

/** Cached card readout (append-only, deduped by (cardNo, timestamp ± window)). */
export interface ProjReadout {
  id: string;
  competitionId: string;
  cardNo: number;
  timestamp: number;
  payload: JournalCardReadPayload;
}

/**
 * Snapshot-hydrated reference entity (class / course / control). `value` holds
 * the tRPC snapshot object verbatim; `competitionId` + `seq` are the index keys.
 */
export interface ProjReference {
  competitionId: string;
  seq: number;
  value: unknown;
}

/** Per-peer sync watermark. `id` = `${competitionId}:${peerId}`. */
export interface SyncState {
  id: string;
  competitionId: string;
  peerId: string;
  /** Highest journal HLC folded so far, as a decimal string (BigInt-safe). */
  lastSeenHlc: string;
  lastSyncAt: number;
}

class OxygenOfflineDB extends Dexie {
  events!: Table<OxygenEvent, string>;
  // Snapshot cache (station blip durability)
  projRunners!: Table<ProjRunner, string>;
  projClasses!: Table<ProjReference, [string, number]>;
  projCourses!: Table<ProjReference, [string, number]>;
  projControls!: Table<ProjReference, [string, number]>;
  projReadouts!: Table<ProjReadout, string>;
  projPunches!: Table<ProjPunch, string>;
  syncState!: Table<SyncState, string>;

  constructor() {
    super("oxygen-offline");
    this.version(1).stores({
      events: "id, competitionId, status, timestamp, type",
    });
    // v2: offline-first fields (hlc / schemaVersion / actorId). No index
    // change; backfill hlc on already-queued pending entries from their
    // wall-clock timestamp (matches the server's legacy HLC synthesis).
    this.version(2)
      .stores({ events: "id, competitionId, status, timestamp, type" })
      .upgrade((tx) =>
        tx
          .table<OxygenEvent>("events")
          .toCollection()
          .modify((e) => {
            if (e.hlc == null) {
              e.hlc = { physical: e.timestamp, logical: 0 };
              e.schemaVersion = 1;
              e.actorId = null;
            }
          }),
      );
    // v3: snapshot-cache tables. Additive — the existing
    // `events` outbox is unchanged; nothing reads these until the read cutover.
    this.version(3).stores({
      events: "id, competitionId, status, timestamp, type",
      projRunners:
        "id, competitionId, cardNo, [competitionId+cardNo], classId, status",
      projClasses: "[competitionId+seq], competitionId",
      projCourses: "[competitionId+seq], competitionId",
      projControls: "[competitionId+seq], competitionId",
      projReadouts: "id, competitionId, cardNo",
      projPunches: "key, competitionId, cardNo",
      syncState: "id, competitionId",
    });
  }
}

export const offlineDb = new OxygenOfflineDB();
