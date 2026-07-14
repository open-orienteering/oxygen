/**
 * Station reads from the snapshot cache.
 *
 * Pure selectors compute the same shapes the tRPC procedures return, but from
 * the Dexie snapshot-cache arrays. The adapter hooks branch on the feature flag:
 * both the tRPC query and the Dexie live-query are always called (rules of
 * hooks), and the flag selects which result is returned — tRPC is disabled when
 * the flag is on, so it does not fetch. With the flag off, behaviour is exactly
 * as before.
 */

import { useLiveQuery } from "dexie-react-hooks";
import { offlineDb, type ProjRunner } from "./db";
import { useOfflineProjectionEnabled } from "../feature-flags";
import { trpc } from "../trpc";
import type { ClassInfo, CourseInfo } from "@oxygen/shared";

// ─── Result shapes (match the tRPC outputs they substitute) ──

export interface LookupRunner {
  id: number;
  name: string;
  cardNo: number;
  clubId: number;
  clubName: string;
  classId: number;
  className: string;
  startNo: number;
  startTime: number;
  finishTime: number;
  status: number;
  courseId: number;
  courseName: string;
  courseControlCount: number;
  freeStart: boolean;
  classFreeStart: boolean;
  noTiming: boolean;
}

export type LookupByCardResult =
  | { found: false; cardNo: number }
  | {
      found: true;
      cardNo: number;
      runner: LookupRunner;
      course: { id: number; name: string; length: number; controlCount: number } | null;
    };

export interface RecentActivityItem {
  id: number;
  runnerId: number;
  name: string;
  className: string;
  clubName: string;
  finishTime: number;
  startTime: number;
  runningTime: number;
  status: number;
  updatedAt: string;
}

// ─── Pure selectors over projection arrays ───────────────────

export function selectLookupByCard(
  cardNo: number,
  runners: ProjRunner[],
  classes: ClassInfo[],
  courses: CourseInfo[],
): LookupByCardResult {
  const r = runners.find((x) => x.cardNo === cardNo);
  if (!r) return { found: false, cardNo };
  const cls = r.classId != null ? classes.find((c) => c.id === r.classId) : undefined;
  const courseSeq = cls?.courseId ?? 0;
  const course = courseSeq ? courses.find((c) => c.id === courseSeq) : undefined;
  const ccCount = course?.controlCount ?? 0;
  return {
    found: true,
    cardNo,
    runner: {
      id: r.seq ?? 0,
      name: r.name,
      cardNo: r.cardNo ?? 0,
      clubId: r.eventorClubId ?? 0,
      clubName: r.clubName,
      classId: cls?.id ?? 0,
      className: cls?.name ?? "",
      startNo: r.startNo,
      startTime: r.startTime,
      finishTime: r.finishTime,
      status: r.status,
      courseId: course?.id ?? 0,
      courseName: course?.name ?? "",
      courseControlCount: ccCount,
      freeStart: cls?.freeStart ?? false,
      classFreeStart: cls?.freeStart ?? false,
      noTiming: cls?.noTiming ?? false,
    },
    course: course
      ? { id: course.id, name: course.name, length: course.length, controlCount: ccCount }
      : null,
  };
}

export function selectRecentActivity(
  runners: ProjRunner[],
  classes: ClassInfo[],
  limit: number,
): RecentActivityItem[] {
  const classNameBySeq = new Map(classes.map((c) => [c.id, c.name]));
  return runners
    .filter((r) => r.finishTime > 0)
    // The cloud orders by updatedAt; the projection has no updatedAt, so the
    // closest faithful order for a "recent finishers" feed is finishTime desc.
    .sort((a, b) => b.finishTime - a.finishTime)
    .slice(0, limit)
    .map((r) => ({
      id: r.seq ?? 0,
      runnerId: r.seq ?? 0,
      name: r.name,
      className: r.classId != null ? classNameBySeq.get(r.classId) ?? "" : "",
      clubName: r.clubName,
      finishTime: r.finishTime,
      startTime: r.startTime,
      runningTime:
        r.startTime > 0 && r.finishTime > 0 ? Math.max(0, r.finishTime - r.startTime) : 0,
      status: r.status,
      updatedAt: "",
    }));
}

// ─── Dexie readers ───────────────────────────────────────────

function readProjection(competitionId: string) {
  return Promise.all([
    offlineDb.projRunners.where("competitionId").equals(competitionId).toArray(),
    offlineDb.projClasses.where("competitionId").equals(competitionId).toArray(),
    offlineDb.projCourses.where("competitionId").equals(competitionId).toArray(),
  ]).then(([runners, classes, courses]) => ({
    runners,
    classes: classes.map((c) => c.value as ClassInfo),
    courses: courses.map((c) => c.value as CourseInfo),
  }));
}

// ─── Flag-branched adapter hooks ─────────────────────────────

interface ReadResult<T> {
  data: T | undefined;
  isLoading: boolean;
  isFetching: boolean;
}

export function useLookupByCard(
  competitionId: string,
  cardNo: number,
  enabled: boolean,
): ReadResult<LookupByCardResult> {
  const flag = useOfflineProjectionEnabled();
  const remote = trpc.race.lookupByCard.useQuery(
    { cardNo },
    { enabled: enabled && !flag && cardNo > 0 },
  );
  const local = useLiveQuery(async () => {
    if (!flag || !enabled || cardNo <= 0) return undefined;
    const { runners, classes, courses } = await readProjection(competitionId);
    return selectLookupByCard(cardNo, runners, classes, courses);
  }, [flag, enabled, competitionId, cardNo]);

  if (flag) {
    return {
      data: local,
      isLoading: enabled && cardNo > 0 && local === undefined,
      isFetching: false,
    };
  }
  return { data: remote.data, isLoading: remote.isLoading, isFetching: remote.isFetching };
}

export function useRecentActivity(
  competitionId: string,
  limit: number,
): ReadResult<RecentActivityItem[]> {
  const flag = useOfflineProjectionEnabled();
  const remote = trpc.race.recentActivity.useQuery({ limit }, { enabled: !flag });
  const local = useLiveQuery(async () => {
    if (!flag) return undefined;
    const { runners, classes } = await readProjection(competitionId);
    return selectRecentActivity(runners, classes, limit);
  }, [flag, competitionId, limit]);

  if (flag) {
    return { data: local, isLoading: local === undefined, isFetching: false };
  }
  return { data: remote.data, isLoading: remote.isLoading, isFetching: remote.isFetching };
}
