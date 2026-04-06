import Dexie, { type Table } from "dexie";

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
  payload: EventPayload;
  status: "pending" | "synced" | "failed";
  error?: string;
  attempts: number;
}

// ─── Dexie Database ─────────────────────────────────────────

class OxygenOfflineDB extends Dexie {
  events!: Table<OxygenEvent, string>;

  constructor() {
    super("oxygen-offline");
    this.version(1).stores({
      events: "id, competitionId, status, timestamp, type",
    });
  }
}

export const offlineDb = new OxygenOfflineDB();
