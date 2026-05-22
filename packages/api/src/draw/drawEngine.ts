/**
 * Draw engine — orchestrates the multi-class draw by combining
 * the corridor optimizer with per-class draw algorithms.
 *
 * The engine speaks **per-event integer seqs** publicly (matching the
 * `@oxygen/shared` `ClassDrawConfig.classId` shape and what the web
 * panel passes in), and resolves seq → UUID at the DB boundary.
 */

import type { PrismaClient } from "@prisma/client";
import type {
  ClassDrawConfig,
  DrawSettings,
  DrawPreviewResult,
  DrawPreviewClass,
  DrawPreviewEntry,
} from "@oxygen/shared";
import { WITHDRAWN_STATUSES } from "@oxygen/shared";
import {
  randomDraw,
  clubSeparationDraw,
  seededDraw,
  simultaneousDraw,
  type DrawRunner,
} from "./algorithms.js";
import { optimizeStartTimes, type ClassCourseInfo } from "./optimizer.js";
import { valueToRunnerStatus } from "../statusConvert.js";

interface ClassData {
  classSeq: number;
  classUuid: string;
  className: string;
  courseSeq: number; // 0 if class has no course
  courseUuid: string | null;
  courseName: string;
  /** Up to 5 first-control codes, used for course-overlap detection. */
  initialControls: number[];
  /** UUID-keyed runner records, ready for the draw algorithm. */
  runners: DrawRunner[];
}

const withdrawnEnums = WITHDRAWN_STATUSES.map(valueToRunnerStatus);

async function loadClassData(
  db: PrismaClient,
  eventId: bigint,
  classConfigs: ClassDrawConfig[],
): Promise<{ classes: ClassData[]; warnings: string[] }> {
  const warnings: string[] = [];
  const classSeqs = classConfigs.map((c) => c.classId);

  const dbClasses = await db.class.findMany({
    where: { eventId, seq: { in: classSeqs }, removed: false },
    include: {
      course: {
        select: {
          id: true,
          seq: true,
          name: true,
          courseControls: {
            orderBy: { position: "asc" },
            take: 5,
            include: { control: { select: { codes: true } } },
          },
        },
      },
    },
  });
  const classBySeq = new Map(dbClasses.map((c) => [c.seq, c]));

  const dbRunners = await db.runner.findMany({
    where: {
      eventId,
      classId: { in: dbClasses.map((c) => c.id) },
      removed: false,
      status: { notIn: withdrawnEnums },
    },
    orderBy: { startNo: "asc" },
    select: {
      id: true,
      name: true,
      clubName: true,
      eventorClubId: true,
      startNo: true,
      rank: true,
      classId: true,
    },
  });

  const runnersByClassUuid = new Map<string, DrawRunner[]>();
  for (const r of dbRunners) {
    if (!r.classId) continue;
    const list = runnersByClassUuid.get(r.classId) ?? [];
    // Club key: prefer eventor_club_id; fall back to a stable hash of
    // the free-text name so clubless / non-Eventor entries still get
    // grouped together for the separation pass.
    const clubKey = r.eventorClubId
      ? Number(r.eventorClubId)
      : r.clubName
        ? -hashString(r.clubName.toLowerCase())
        : 0;
    list.push({
      id: r.id, // UUID
      name: r.name,
      clubId: clubKey,
      clubName: r.clubName,
      startNo: r.startNo,
      rank: r.rank,
    });
    runnersByClassUuid.set(r.classId, list);
  }

  const classes: ClassData[] = [];
  for (const config of classConfigs) {
    const cls = classBySeq.get(config.classId);
    if (!cls) {
      warnings.push(`Class ${config.classId} not found`);
      continue;
    }
    const runners = runnersByClassUuid.get(cls.id) ?? [];
    if (runners.length === 0) {
      warnings.push(`Class "${cls.name}" has no runners`);
    }
    const initialControls: number[] = [];
    if (cls.course) {
      for (const cc of cls.course.courseControls) {
        const code = parseInt((cc.control.codes ?? "").split(";")[0] ?? "0", 10);
        if (!isNaN(code) && code > 0) initialControls.push(code);
      }
    }
    const noClub = runners.filter((r) => r.clubId === 0);
    if (noClub.length > 0) {
      warnings.push(
        `${noClub.length} runner${noClub.length > 1 ? "s" : ""} in "${cls.name}" ha${
          noClub.length > 1 ? "ve" : "s"
        } no club (club separation may be less effective)`,
      );
    }
    classes.push({
      classSeq: cls.seq,
      classUuid: cls.id,
      className: cls.name,
      courseSeq: cls.course?.seq ?? 0,
      courseUuid: cls.course?.id ?? null,
      courseName: cls.course?.name ?? "",
      initialControls,
      runners,
    });
  }

  return { classes, warnings };
}

/** Tiny non-cryptographic hash for free-text club-name keys. */
function hashString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h) || 1;
}

/**
 * Execute the draw algorithm and return a preview (no DB writes).
 * The returned `entries[].runnerId` is the runner's UUID — the router
 * decides what shape to expose to the UI.
 */
export async function generateDrawPreview(
  db: PrismaClient,
  eventId: bigint,
  classConfigs: ClassDrawConfig[],
  settings: DrawSettings,
): Promise<DrawPreviewResultInternal> {
  const { classes, warnings } = await loadClassData(db, eventId, classConfigs);

  const configBySeq = new Map(classConfigs.map((c) => [c.classId, c]));
  const courseInfos: ClassCourseInfo[] = classes.map((cls) => {
    const config = configBySeq.get(cls.classSeq)!;
    return {
      classId: cls.classSeq,
      runnerCount: cls.runners.length,
      courseId: cls.courseSeq,
      initialControls: cls.initialControls,
      interval: config.interval,
      fixedFirstStart: config.firstStart,
      corridorHint: config.corridorHint,
      orderHint: config.orderHint,
    };
  });

  const corridorAssignments = optimizeStartTimes(courseInfos, settings);
  const assignmentMap = new Map(
    corridorAssignments.map((a) => [a.classId, a]),
  );

  const resultClasses: DrawPreviewClassInternal[] = [];
  let globalStartNo = 1;

  // Sort by computed first start so start numbers go in chronological order.
  const sorted = [...classes].sort((a, b) => {
    const ai = assignmentMap.get(a.classSeq)?.computedFirstStart ?? 0;
    const bi = assignmentMap.get(b.classSeq)?.computedFirstStart ?? 0;
    return ai - bi;
  });

  for (const cls of sorted) {
    const config = configBySeq.get(cls.classSeq)!;
    const assignment = assignmentMap.get(cls.classSeq);
    const firstStart = assignment?.computedFirstStart ?? settings.firstStart;
    const corridor = assignment?.corridor ?? 0;

    let ordered: DrawRunner[];
    switch (config.method) {
      case "clubSeparation":
        ordered = clubSeparationDraw(cls.runners);
        break;
      case "seeded":
        ordered = seededDraw(cls.runners, { clubSeparation: true });
        break;
      case "simultaneous":
        ordered = simultaneousDraw(cls.runners);
        break;
      case "random":
      default:
        ordered = randomDraw(cls.runners);
        break;
    }

    const entries: DrawPreviewEntryInternal[] = ordered.map((r, idx) => ({
      runnerId: r.id, // UUID
      name: r.name,
      clubName: r.clubName,
      startTime:
        config.method === "simultaneous"
          ? firstStart
          : firstStart + idx * config.interval,
      startNo: globalStartNo + idx,
    }));

    resultClasses.push({
      classId: cls.classSeq,
      classUuid: cls.classUuid,
      className: cls.className,
      courseName: cls.courseName,
      corridor,
      computedFirstStart: firstStart,
      entries,
    });
    globalStartNo += ordered.length;
  }

  return { classes: resultClasses, warnings };
}

/** Internal preview entry — keeps the UUID alongside the public seq. */
export interface DrawPreviewEntryInternal extends Omit<DrawPreviewEntry, "runnerId"> {
  /** Runner UUID. */
  runnerId: string;
}
export interface DrawPreviewClassInternal extends Omit<DrawPreviewClass, "entries"> {
  classUuid: string;
  entries: DrawPreviewEntryInternal[];
}
export interface DrawPreviewResultInternal extends Omit<DrawPreviewResult, "classes"> {
  classes: DrawPreviewClassInternal[];
}
