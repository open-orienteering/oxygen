/**
 * Snapshot cache + own-writes overlay.
 *
 * The Dexie cache for a competition is built as **server snapshot + this
 * station's own pending outbox writes replayed in order**:
 *  - the base is the cloud's authoritative tRPC snapshots (`runner.list`,
 *    `competition.dashboard`, `control.list`) — status/times verbatim;
 *  - the overlay replays the still-pending outbox emits sequentially, so an
 *    un-synced local write survives a connectivity blip and a page reload
 *    (pending entries are re-applied on every rebuild until they sync).
 *
 * This is request queuing into a single writer, not replication: a station's
 * writes never conflict with themselves, so the replay is a plain sequential
 * fold with **no conflict resolution**. The server stays authoritative — once
 * a pending write syncs (or is rejected), the next snapshot rebuild reflects
 * the server's decision. Only the append-only streams (punches, card reads)
 * keep their dedupe keys, because duplicate emits are possible and harmless.
 */

import {
  offlineDb,
  type ProjRunner,
  type ProjPunch,
  type ProjReadout,
  type ProjReference,
  type OxygenEvent,
} from "./db";
import {
  type RunnerInfo,
  type ClassInfo,
  type CourseInfo,
  punchDedupeKey,
  cardReadIsDuplicate,
} from "@oxygen/shared";

const STATUS_UNKNOWN = 0; // RunnerStatus.Unknown
const STATUS_OK = 1; // RunnerStatus.OK

function runnerKey(cardNo: number | null, fallbackId: string): string {
  return cardNo != null ? `card:${cardNo}` : `id:${fallbackId}`;
}

function snapshotRunner(competitionId: string, info: RunnerInfo): ProjRunner {
  const cardNo = info.cardNo > 0 ? info.cardNo : null;
  return {
    id: runnerKey(cardNo, `seq:${info.id}`),
    competitionId,
    seq: info.id,
    cardNo,
    name: info.name,
    startNo: info.startNo,
    classId: info.classId ?? null,
    clubName: info.clubName ?? "",
    eventorClubId: info.clubId > 0 ? info.clubId : null,
    startTime: info.startTime,
    finishTime: info.finishTime,
    status: info.status,
  };
}

export interface RunnerProjection {
  runners: ProjRunner[];
  punches: ProjPunch[];
  readouts: ProjReadout[];
}

/**
 * Pure: snapshot runners + this station's pending outbox → cached rows.
 * The overlay is a sequential replay of own writes — no merge logic.
 */
export function buildRunnerProjection(
  competitionId: string,
  snapshot: RunnerInfo[],
  pending: OxygenEvent[],
): RunnerProjection {
  const byKey = new Map<string, ProjRunner>();
  for (const info of snapshot) {
    const row = snapshotRunner(competitionId, info);
    byKey.set(row.id, row);
  }
  const punches = new Map<string, ProjPunch>();
  const readouts: ProjReadout[] = [];

  // Replay this station's own writes in emit order (timestamp, then id).
  const ordered = [...pending].sort((a, b) =>
    a.timestamp !== b.timestamp ? a.timestamp - b.timestamp : a.id < b.id ? -1 : 1,
  );

  const num = (v: unknown): number | undefined =>
    typeof v === "number" ? v : undefined;
  // Resolve the runner a race-state emit refers to: by card when present,
  // otherwise by the snapshot row's seq (cardless runners exist only in the
  // snapshot — an offline-created cardless runner has no seq to reference).
  const find = (cardNo: number | null, runnerSeq: number | undefined) =>
    cardNo != null
      ? byKey.get(`card:${cardNo}`)
      : runnerSeq != null && runnerSeq > 0
        ? byKey.get(`id:seq:${runnerSeq}`)
        : undefined;

  for (const ev of ordered) {
    const p = ev.payload as unknown as Record<string, unknown>;
    const card = typeof p.cardNo === "number" && p.cardNo > 0 ? p.cardNo : null;

    switch (ev.type) {
      case "runner.registered": {
        const key = runnerKey(card, String(p.tempId ?? ev.id));
        const existing = byKey.get(key);
        if (existing) {
          // Own re-registration of the same card: sequential replay — the
          // later write's fields stick.
          existing.name = typeof p.name === "string" ? p.name : existing.name;
          existing.classId = num(p.classId) ?? existing.classId;
          if (typeof p.clubName === "string") existing.clubName = p.clubName;
          const club = num(p.eventorClubId) ?? num(p.clubId);
          if (club !== undefined && club > 0) existing.eventorClubId = club;
          const st = num(p.startTime);
          if (st !== undefined) existing.startTime = st;
        } else {
          byKey.set(key, {
            id: key,
            competitionId,
            seq: null,
            cardNo: card,
            name: typeof p.name === "string" ? p.name : "",
            startNo: num(p.startNo) ?? 0,
            classId: num(p.classId) ?? null,
            clubName: typeof p.clubName === "string" ? p.clubName : "",
            eventorClubId:
              num(p.eventorClubId) ??
              (typeof p.clubId === "number" && p.clubId > 0 ? p.clubId : null),
            startTime: num(p.startTime) ?? 0,
            finishTime: 0,
            status: STATUS_UNKNOWN,
          });
        }
        break;
      }
      case "finish.recorded": {
        const r = find(card, num(p.runnerId));
        const ft = num(p.finishTime);
        if (r && ft !== undefined) {
          r.finishTime = ft;
          r.status = STATUS_OK;
        }
        break;
      }
      case "result.applied": {
        const r = find(card, num(p.runnerId));
        if (r) {
          const ft = num(p.finishTime);
          const st = num(p.startTime);
          const stat = num(p.status);
          if (ft !== undefined) r.finishTime = ft;
          if (st !== undefined) r.startTime = st;
          if (stat !== undefined) r.status = stat;
        }
        break;
      }
      case "start.recorded": {
        const r = find(card, num(p.runnerId));
        const st = num(p.startTime);
        if (r && st !== undefined) r.startTime = st;
        break;
      }
      case "punch.recorded": {
        const cn = num(p.cardNo);
        const cc = num(p.controlCode);
        const t = num(p.time);
        if (cn !== undefined && cc !== undefined && t !== undefined) {
          const key = `${competitionId}:${punchDedupeKey({ cardNo: cn, controlCode: cc, time: t })}`;
          if (!punches.has(key)) {
            punches.set(key, {
              key,
              competitionId,
              cardNo: cn,
              controlCode: cc,
              time: t,
              origin: typeof p.origin === "string" ? p.origin : "card",
            });
          }
        }
        break;
      }
      case "card.read": {
        const cn = num(p.cardNo);
        if (
          cn !== undefined &&
          !cardReadIsDuplicate(
            readouts.map((r) => ({ cardNo: r.cardNo, timestamp: r.timestamp })),
            cn,
            ev.timestamp,
          )
        ) {
          readouts.push({
            id: ev.id,
            competitionId,
            cardNo: cn,
            timestamp: ev.timestamp,
            payload: p as never,
          });
        }
        break;
      }
    }
  }

  return {
    runners: [...byKey.values()],
    punches: [...punches.values()],
    readouts,
  };
}

// ─── Dexie persistence ──────────────────────────────────────

/** Rebuild and persist the runner/punch/readout cache for a competition. */
export async function hydrateRunners(
  competitionId: string,
  snapshot: RunnerInfo[],
  pending: OxygenEvent[],
): Promise<void> {
  const { runners, punches, readouts } = buildRunnerProjection(
    competitionId,
    snapshot,
    pending,
  );
  await offlineDb.transaction(
    "rw",
    offlineDb.projRunners,
    offlineDb.projPunches,
    offlineDb.projReadouts,
    async () => {
      await offlineDb.projRunners.where("competitionId").equals(competitionId).delete();
      await offlineDb.projRunners.bulkPut(runners);
      await offlineDb.projPunches.where("competitionId").equals(competitionId).delete();
      await offlineDb.projPunches.bulkPut(punches);
      await offlineDb.projReadouts.where("competitionId").equals(competitionId).delete();
      await offlineDb.projReadouts.bulkPut(readouts);
    },
  );
}

/** Persist the reference cache (classes / courses / controls) from snapshots. */
export async function hydrateReference(
  competitionId: string,
  classes: ClassInfo[],
  courses: CourseInfo[],
  controls: Array<{ id: number }>,
): Promise<void> {
  const toRows = (items: ReadonlyArray<{ id: number }>): ProjReference[] =>
    items.map((value) => ({ competitionId, seq: value.id, value }));
  await offlineDb.transaction(
    "rw",
    offlineDb.projClasses,
    offlineDb.projCourses,
    offlineDb.projControls,
    async () => {
      await offlineDb.projClasses.where("competitionId").equals(competitionId).delete();
      await offlineDb.projClasses.bulkPut(toRows(classes));
      await offlineDb.projCourses.where("competitionId").equals(competitionId).delete();
      await offlineDb.projCourses.bulkPut(toRows(courses));
      await offlineDb.projControls.where("competitionId").equals(competitionId).delete();
      await offlineDb.projControls.bulkPut(toRows(controls));
    },
  );
}
