/**
 * Class standings: the one place result lists and finish receipts get a
 * runner's adjusted running time and place from (RES-11, CRS-039).
 *
 * For every runner in scope it picks the runner's card the way the readout
 * does (`pickRunnerCard`), merges free punches in card order, runs the
 * matcher for the NoTiming-leg deduction, and ranks each class with the
 * shared `computeClassPlacements` (ties share a place, no-timing classes are
 * unplaced). Classless runners are never placed. Cancelled entries are left
 * out: they are not participants (docs/bugfixes/cancellation-handling.md).
 */

import type { Prisma, PrismaClient, RunnerStatus as PgRunnerStatus } from "./generated/prisma/client.js";
import {
  parsePunches,
  matchPunchesToCourse,
  mergePunchesInCardOrder,
  computeClassPlacements,
  runningTimeDs,
  RunnerStatus,
  type ParsedPunch,
  type RunnerStatusValue,
} from "@oxygen/shared";
import { toAbsolute } from "./timeConvert.js";
import { runnerStatusToValue } from "./statusConvert.js";
import { pickRunnerCard } from "./cardLink.js";
import { resolveCourseExpectedPositions } from "./routers/course.js";

type Db = PrismaClient | Prisma.TransactionClient;

/** Statuses whose running time is shown although the runner is unplaced. */
const TIMED_UNPLACED = new Set<number>([
  RunnerStatus.NoTiming,
  RunnerStatus.OverMaxTime,
  RunnerStatus.OutOfCompetition,
]);

/** Readout values that stand in for a runner's stored row (receipt before the result is saved). */
export interface StandingOverride {
  runnerId: string;
  status: number;
  /** Absolute deciseconds, 0 = none. */
  startTime: number;
  finishTime: number;
  runningTimeAdjustment: number;
}

export interface StandingRow {
  runner: {
    id: string;
    seq: number;
    name: string;
    clubName: string;
    eventorClubId: bigint | string | null;
    startNo: number;
    cardNo: number | null;
    startTime: number;
    classId: string | null;
  };
  classSeq: number;
  className: string;
  classSortIndex: number;
  noTiming: boolean;
  status: RunnerStatusValue;
  /** Absolute deciseconds, 0 = none. */
  startAbs: number;
  finishAbs: number;
  runningTimeAdjustment: number;
  /** Adjusted running time; 0 for statuses that show no time (MP, DNF, DQ, ...). */
  runningTime: number;
  /** 0 = unplaced. */
  place: number;
  timeBehind: number;
}

export async function loadClassStandings(
  db: Db,
  event: { id: bigint; zeroTime: number },
  opts: { classId?: string; override?: StandingOverride } = {},
): Promise<StandingRow[]> {
  const zeroTime = event.zeroTime;
  const runners = await db.runner.findMany({
    where: {
      eventId: event.id,
      removed: false,
      status: { not: "cancel" as PgRunnerStatus },
      ...(opts.classId ? { classId: opts.classId } : {}),
    },
    include: {
      class: {
        select: { name: true, seq: true, courseId: true, noTiming: true, sortIndex: true },
      },
    },
    // Stable: the same input gives the same list on every refresh.
    orderBy: [{ startNo: "asc" }, { name: "asc" }, { id: "asc" }],
  });

  const cardNos = [
    ...new Set(runners.map((r) => r.cardNo).filter((c): c is number => c != null && c > 0)),
  ];
  const [cards, freePunches] = cardNos.length
    ? await Promise.all([
        db.card.findMany({
          where: { eventId: event.id, cardNo: { in: cardNos }, removed: false },
          select: { id: true, cardNo: true, removed: true, updatedAt: true, punchesRaw: true },
        }),
        // Backup-memory rows count only through their pushed mirror (RES-08).
        db.punch.findMany({
          where: {
            eventId: event.id,
            cardNo: { in: cardNos },
            removed: false,
            source: { not: "backup_memory" },
          },
          select: { cardNo: true, controlCode: true, time: true },
          orderBy: { time: "asc" },
        }),
      ])
    : [[], []];
  const cardById = new Map(cards.map((c) => [c.id, c]));
  const cardsByNo = new Map<number, typeof cards>();
  for (const c of cards) {
    const list = cardsByNo.get(c.cardNo) ?? [];
    list.push(c);
    cardsByNo.set(c.cardNo, list);
  }
  const freeByNo = new Map<number, typeof freePunches>();
  for (const p of freePunches) {
    const list = freeByNo.get(p.cardNo) ?? [];
    list.push(p);
    freeByNo.set(p.cardNo, list);
  }

  const courseIds = new Set<string>();
  for (const r of runners) {
    const cid = r.courseId ?? r.class?.courseId ?? null;
    if (cid) courseIds.add(cid);
  }
  const orderModeByCourse = new Map<string, "ordered" | "free_order">();
  const expectedByCourse = new Map<string, Awaited<ReturnType<typeof resolveCourseExpectedPositions>>>();
  if (courseIds.size > 0) {
    const rows = await db.course.findMany({
      where: { id: { in: [...courseIds] } },
      select: { id: true, orderMode: true },
    });
    for (const row of rows) orderModeByCourse.set(row.id, row.orderMode);
    for (const cid of courseIds) {
      expectedByCourse.set(cid, await resolveCourseExpectedPositions(db, cid));
    }
  }

  const override = opts.override;
  const base = runners.map((r) => {
    if (override && override.runnerId === r.id) {
      return {
        r,
        status: override.status as RunnerStatusValue,
        startAbs: override.startTime,
        finishAbs: override.finishTime,
        adj: override.runningTimeAdjustment,
      };
    }
    const startAbs = toAbsolute(r.startTime, zeroTime);
    const finishAbs = toAbsolute(r.finishTime, zeroTime);
    let adj = 0;
    const courseId = r.courseId ?? r.class?.courseId ?? null;
    const expected = courseId ? expectedByCourse.get(courseId) : undefined;
    if (courseId && expected && expected.length > 0 && r.cardNo != null && r.cardNo > 0) {
      const card = pickRunnerCard(
        r,
        r.cardId ? cardById.get(r.cardId) : null,
        cardsByNo.get(r.cardNo) ?? [],
      );
      const cardPunches = parsePunches(card?.punchesRaw ?? "").map((p) => ({
        ...p,
        time: p.time !== 0 ? toAbsolute(p.time, zeroTime) : 0,
      }));
      const free: ParsedPunch[] = (freeByNo.get(r.cardNo) ?? []).map((p) => ({
        type: p.controlCode,
        time: p.time !== 0 ? toAbsolute(p.time, zeroTime) : 0,
        source: "free" as const,
      }));
      if (cardPunches.length > 0 || free.length > 0) {
        adj = matchPunchesToCourse(mergePunchesInCardOrder(cardPunches, free), expected, startAbs, {
          orderMode: orderModeByCourse.get(courseId) ?? "ordered",
        }).runningTimeAdjustment;
      }
    }
    return { r, status: runnerStatusToValue(r.status), startAbs, finishAbs, adj };
  });

  // Rank per class with the shared helper (keyed by array index).
  const placement = new Map<number, { place: number; runningTime: number; timeBehind: number }>();
  const indicesByClass = new Map<string, number[]>();
  base.forEach((b, i) => {
    if (!b.r.classId) return;
    const list = indicesByClass.get(b.r.classId) ?? [];
    list.push(i);
    indicesByClass.set(b.r.classId, list);
  });
  for (const indices of indicesByClass.values()) {
    const noTiming = base[indices[0]].r.class?.noTiming === true;
    const placed = computeClassPlacements(
      indices.map((i) => ({
        id: i,
        status: base[i].status,
        startTime: base[i].startAbs,
        finishTime: base[i].finishAbs,
        runningTimeAdjustment: base[i].adj,
      })),
      noTiming,
    );
    for (const [i, p] of placed) placement.set(i, p);
  }

  return base.map((b, i): StandingRow => {
    const p = placement.get(i);
    // Classless runners have no placement row: their time still shows.
    const shown = b.status === RunnerStatus.OK || TIMED_UNPLACED.has(b.status);
    const unranked =
      b.startAbs > 0 && b.finishAbs > 0
        ? Math.max(0, runningTimeDs(b.startAbs, b.finishAbs) - b.adj)
        : 0;
    const runningTime = shown ? (p?.runningTime ?? unranked) : 0;
    return {
      runner: {
        id: b.r.id,
        seq: b.r.seq,
        name: b.r.name,
        clubName: b.r.clubName,
        eventorClubId: b.r.eventorClubId,
        startNo: b.r.startNo,
        cardNo: b.r.cardNo,
        startTime: b.r.startTime,
        classId: b.r.classId,
      },
      classSeq: b.r.class?.seq ?? 0,
      className: b.r.class?.name ?? "",
      classSortIndex: b.r.class?.sortIndex ?? Number.MAX_SAFE_INTEGER,
      noTiming: b.r.class?.noTiming === true,
      status: b.status,
      startAbs: b.startAbs,
      finishAbs: b.finishAbs,
      runningTimeAdjustment: b.adj,
      runningTime,
      place: p?.place ?? 0,
      timeBehind: p && p.place > 0 ? p.timeBehind : 0,
    };
  });
}

/**
 * Result-list order: class (sort index, then name, classless last), then
 * placed runners by place, then unplaced runners with a time by time, then
 * the rest by status; name and seq break ties so the order never flips.
 */
export function compareStandings(a: StandingRow, b: StandingRow): number {
  const ac = a.runner.classId ? 0 : 1;
  const bc = b.runner.classId ? 0 : 1;
  if (ac !== bc) return ac - bc;
  if (a.classSortIndex !== b.classSortIndex) return a.classSortIndex - b.classSortIndex;
  if (a.className !== b.className) return a.className < b.className ? -1 : 1;
  const group = (s: StandingRow) => (s.place > 0 ? 0 : s.runningTime > 0 ? 1 : 2);
  const ga = group(a);
  const gb = group(b);
  if (ga !== gb) return ga - gb;
  if (ga === 0 && a.place !== b.place) return a.place - b.place;
  if (ga !== 2 && a.runningTime !== b.runningTime) return a.runningTime - b.runningTime;
  if (ga === 2 && a.status !== b.status) return a.status - b.status;
  if (a.runner.name !== b.runner.name) return a.runner.name < b.runner.name ? -1 : 1;
  return a.runner.seq - b.runner.seq;
}
