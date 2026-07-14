/**
 * Journal wire format + pure conflict-decision helpers.
 *
 * The journal is the append-only log of race-critical mutations that ships
 * between server nodes (venue ↔ cloud) and drains from station outboxes. Each
 * row is a *journal entry*. The same JSON shape is used over the wire, in
 * Dexie, and (encoded) in Postgres. See `docs/offline-architecture.md`.
 *
 * This module is pure and shared by every tier. It defines the entry types,
 * the ordering primitives (HLC stamps + tie-breaks), and the dedupe keys that
 * make the append-only streams (`punch.recorded`, `card.read`) multi-master.
 * The earliest-/latest-wins helpers back the server-side apply guards.
 *
 * Backwards compatibility: `hlc`, `schemaVersion` and `actorId` are optional on
 * the wire so that an older client that predates them keeps working
 * byte-for-byte — `resolveHlc` synthesises an HLC from the wall-clock
 * `timestamp` when none is present.
 */

import { type Hlc, compareHlc } from "./hlc.js";

// ─── Entry types ─────────────────────────────────────────────

/**
 * Every mutation is one of these. Only a subset is emitted today; the rest are
 * reserved for later phases (adjustments, reference data, deletes). The
 * cloud/projection only need cases for the ones actually produced.
 */
export type JournalEntryType =
  | "card.read"
  | "punch.recorded"
  | "start.recorded"
  | "start.adjusted"
  | "finish.recorded"
  | "finish.adjusted"
  | "result.applied"
  | "runner.registered"
  | "runner.updated"
  | "runner.deleted";

// ─── Payloads ────────────────────────────────────────────────

export interface CardReadPayload {
  cardNo: number;
  punches: Array<{
    controlCode: number;
    time: number;
    subSecond?: number;
    unit?: number;
  }>;
  checkTime?: number;
  startTime?: number;
  finishTime?: number;
  cardType?: string;
  batteryVoltage?: number;
  punchesFresh?: boolean;
  ownerData?: Record<string, string | undefined>;
  metadata?: Record<string, string | number | undefined>;
}

export interface PunchRecordedPayload {
  cardNo: number;
  controlCode: number;
  time: number;
  origin?: string;
}

/**
 * Race-state payloads carry `cardNo` as the primary key into the runner (see
 * the one-card-per-event invariant): a card can be matched the instant it is
 * punched, before the cloud has assigned a `seq`. `runnerId` (a `seq`) is a
 * fallback for cardless / manual operations, where `cardNo` is `null`.
 */
export interface StartRecordedPayload {
  cardNo: number | null;
  runnerId?: number;
  startTime: number;
}

export interface FinishRecordedPayload {
  cardNo: number | null;
  runnerId?: number;
  finishTime: number;
}

/**
 * Explicit server-side finish set/correction (`race.recordFinish`). Unlike the
 * station-emitted `finish.recorded` (first-write-wins), adjustments are
 * deliberate operator actions and follow LWW. `status` is carried when the
 * operator set one alongside the time.
 */
export interface FinishAdjustedPayload {
  cardNo: number | null;
  runnerId?: number;
  finishTime: number;
  status?: number;
}

export interface ResultAppliedPayload {
  cardNo: number | null;
  runnerId?: number;
  status: number;
  finishTime: number;
  startTime: number;
}

export interface RunnerRegisteredPayload {
  /** Client-minted UUID/temp id for the new runner row. */
  tempId: string;
  name: string;
  /** Class `seq` reference. */
  classId: number;
  clubName?: string;
  eventorClubId?: number;
  cardNo: number | null;
  startTime?: number;
}

/**
 * A runner edit (`runner.update`, and the bulk / link / card-return variants).
 * `fields` is the **portable** patch — absolute deciseconds, class `seq`, and
 * numeric statuses, exactly as the tRPC input carries them — so a peer replays
 * it through the same `runner.update` logic without any seq↔UUID guesswork.
 * `cardNo` is the runner's card at emit time (pre-edit) so `(eventId, cardNo)`
 * resolution finds the same row on the peer; `runnerId` (`seq`) is the fallback.
 */
export interface RunnerUpdatedPayload {
  cardNo: number | null;
  runnerId: number;
  fields: Record<string, unknown>;
}

/** A soft-delete (`runner.delete`). Resolved by card, then by `seq`. */
export interface RunnerDeletedPayload {
  cardNo: number | null;
  runnerId: number;
}

export interface JournalPayloads {
  "card.read": CardReadPayload;
  "punch.recorded": PunchRecordedPayload;
  "start.recorded": StartRecordedPayload;
  "start.adjusted": StartRecordedPayload;
  "finish.recorded": FinishRecordedPayload;
  "finish.adjusted": FinishAdjustedPayload;
  "result.applied": ResultAppliedPayload;
  "runner.registered": RunnerRegisteredPayload;
  "runner.updated": RunnerUpdatedPayload;
  "runner.deleted": RunnerDeletedPayload;
}

// ─── Wire envelope ───────────────────────────────────────────

/**
 * A single journal entry on the wire / in Dexie.
 *
 * `competitionId` is the orienteering-event slug (resolved server-side from the
 * `x-competition-id` header). `timestamp` is the client wall clock in ms. The
 * fields below it are the offline-first additions, all optional for legacy
 * clients.
 */
export interface JournalEntry<T extends JournalEntryType = JournalEntryType> {
  id: string;
  type: T;
  competitionId: string;
  stationId: string;
  timestamp: number;
  /** Decoded HLC `{physical, logical}` (kept as an object so it survives JSON). */
  hlc?: Hlc;
  schemaVersion?: number;
  actorId?: string | null;
  payload: JournalPayloads[T];
}

/** Discriminated union over all entry types — narrows `payload` on `switch (entry.type)`. */
export type AnyJournalEntry = {
  [T in JournalEntryType]: JournalEntry<T>;
}[JournalEntryType];

/** A bare entry shape sufficient for ordering decisions. */
interface Orderable {
  id: string;
  stationId: string;
  timestamp: number;
  hlc?: Hlc;
}

// ─── Ordering ────────────────────────────────────────────────

/**
 * The HLC for an entry, synthesised from the wall clock when a legacy client
 * omitted it. Logical 0 means "no tie-break info" — fine for legacy entries,
 * which are ordered by wall clock then station/id.
 */
export function resolveHlc(e: Orderable): Hlc {
  return e.hlc ?? { physical: e.timestamp, logical: 0 };
}

/** The full tie-break key for an entry: HLC, then stationId, then id. */
export interface Stamp {
  hlc: Hlc;
  stationId: string;
  id: string;
}

export function entryStamp(e: Orderable): Stamp {
  return { hlc: resolveHlc(e), stationId: e.stationId, id: e.id };
}

/** Total order on stamps: HLC, then stationId, then id (all deterministic). */
export function compareStamps(a: Stamp, b: Stamp): -1 | 0 | 1 {
  const h = compareHlc(a.hlc, b.hlc);
  if (h !== 0) return h;
  if (a.stationId !== b.stationId) return a.stationId < b.stationId ? -1 : 1;
  if (a.id !== b.id) return a.id < b.id ? -1 : 1;
  return 0;
}

/** Total order on entries — the canonical journal sort key. */
export function compareEntries(a: Orderable, b: Orderable): -1 | 0 | 1 {
  return compareStamps(entryStamp(a), entryStamp(b));
}

// ─── Conflict decisions ──────────────────────────────────────
//
// Both helpers are commutative: applying a set of stamped writes in ANY order
// yields the same winner, because the decision is a function of the full
// tie-break key, not of arrival order. This is what gives the projection its
// CRDT convergence (a map of LWW-Registers + first-write-wins registers).

/**
 * First-write-wins (e.g. `finish.recorded`): the *earliest* stamp wins.
 * Returns true if `incoming` should replace the current winner.
 */
export function earliestWins(current: Stamp | null, incoming: Stamp): boolean {
  return current === null || compareStamps(incoming, current) < 0;
}

/**
 * Last-write-wins (e.g. `result.applied`, `*.adjusted`, profile fields): the
 * *latest* stamp wins. Returns true if `incoming` should replace the winner.
 */
export function latestWins(current: Stamp | null, incoming: Stamp): boolean {
  return current === null || compareStamps(incoming, current) > 0;
}

// ─── Dedupe keys (grow-only sets) ────────────────────────────

/** Punches dedupe by `(cardNo, controlCode, time)`. */
export function punchDedupeKey(p: {
  cardNo: number;
  controlCode: number;
  time: number;
}): string {
  return `${p.cardNo}:${p.controlCode}:${p.time}`;
}

/** Window (ms) within which two reads of the same card are the same readout. */
export const CARD_READ_DEDUPE_WINDOW_MS = 60_000;

/**
 * Two `card.read` entries for the same card within
 * {@link CARD_READ_DEDUPE_WINDOW_MS} are the same logical readout.
 */
export function cardReadIsDuplicate(
  existing: ReadonlyArray<{ cardNo: number; timestamp: number }>,
  cardNo: number,
  timestamp: number,
): boolean {
  return existing.some(
    (r) =>
      r.cardNo === cardNo &&
      Math.abs(r.timestamp - timestamp) <= CARD_READ_DEDUPE_WINDOW_MS,
  );
}
