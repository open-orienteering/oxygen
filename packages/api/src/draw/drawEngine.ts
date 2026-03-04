/**
 * Draw engine — orchestrates the multi-class draw by combining
 * the corridor optimizer with per-class draw algorithms.
 */

import type { PrismaClient } from "@prisma/client";
import type {
  ClassDrawConfig,
  DrawSettings,
  DrawPreviewResult,
  DrawPreviewClass,
  DrawPreviewEntry,
} from "@oxygen/shared";
import {
  randomDraw,
  clubSeparationDraw,
  seededDraw,
  simultaneousDraw,
  type DrawRunner,
} from "./algorithms.js";
import {
  optimizeStartTimes,
  type ClassCourseInfo,
} from "./optimizer.js";

interface ClassData {
  classId: number;
  className: string;
  courseId: number;
  courseName: string;
  initialControls: number[];
  runners: DrawRunner[];
}

/**
 * Load all data needed for the draw from the database.
 */
async function loadClassData(
  client: PrismaClient,
  classConfigs: ClassDrawConfig[],
): Promise<{ classes: ClassData[]; warnings: string[] }> {
  const warnings: string[] = [];
  const classIds = classConfigs.map((c) => c.classId);

  const dbClasses = await client.oClass.findMany({
    where: { Id: { in: classIds }, Removed: false },
  });
  const classMap = new Map(dbClasses.map((c) => [c.Id, c]));

  const dbCourses = await client.oCourse.findMany({
    where: { Removed: false },
  });
  const courseMap = new Map(dbCourses.map((c) => [c.Id, c]));

  const dbRunners = await client.oRunner.findMany({
    where: { Class: { in: classIds }, Removed: false },
    orderBy: { StartNo: "asc" },
  });

  const dbClubs = await client.oClub.findMany({
    where: { Removed: false },
    select: { Id: true, Name: true },
  });
  const clubMap = new Map(dbClubs.map((c) => [c.Id, c.Name]));

  const runnersByClass = new Map<number, DrawRunner[]>();
  for (const r of dbRunners) {
    const list = runnersByClass.get(r.Class) ?? [];
    list.push({
      id: r.Id,
      name: r.Name,
      clubId: r.Club,
      clubName: clubMap.get(r.Club) ?? "",
      startNo: r.StartNo,
      rank: r.Rank,
    });
    runnersByClass.set(r.Class, list);
  }

  const classes: ClassData[] = [];
  for (const config of classConfigs) {
    const cls = classMap.get(config.classId);
    if (!cls) {
      warnings.push(`Class ${config.classId} not found`);
      continue;
    }

    const runners = runnersByClass.get(config.classId) ?? [];
    if (runners.length === 0) {
      warnings.push(`Class "${cls.Name}" has no runners`);
    }

    const course = courseMap.get(cls.Course);
    const initialControls = course
      ? course.Controls.split(";")
          .map((s) => parseInt(s, 10))
          .filter((n) => !isNaN(n) && n > 0)
          .slice(0, 5)
      : [];

    // Warn about runners without club assignment
    const noClub = runners.filter((r) => r.clubId === 0);
    if (noClub.length > 0) {
      warnings.push(
        `${noClub.length} runner${noClub.length > 1 ? "s" : ""} in "${cls.Name}" ha${noClub.length > 1 ? "ve" : "s"} no club (club separation may be less effective)`,
      );
    }

    classes.push({
      classId: config.classId,
      className: cls.Name,
      courseId: cls.Course,
      courseName: course?.Name ?? "",
      initialControls,
      runners,
    });
  }

  return { classes, warnings };
}

/**
 * Execute the draw algorithm and return a preview (no DB writes).
 */
export async function generateDrawPreview(
  client: PrismaClient,
  classConfigs: ClassDrawConfig[],
  settings: DrawSettings,
): Promise<DrawPreviewResult> {
  const { classes, warnings } = await loadClassData(client, classConfigs);

  // Build optimizer input
  const configMap = new Map(classConfigs.map((c) => [c.classId, c]));
  const courseInfos: ClassCourseInfo[] = classes.map((cls) => {
    const config = configMap.get(cls.classId)!;
    return {
      classId: cls.classId,
      runnerCount: cls.runners.length,
      courseId: cls.courseId,
      initialControls: cls.initialControls,
      interval: config.interval,
      fixedFirstStart: config.firstStart,
      corridorHint: config.corridorHint,
      orderHint: config.orderHint,
    };
  });

  // Run optimizer to get corridor assignments and first-start times
  const corridorAssignments = optimizeStartTimes(courseInfos, settings);
  const assignmentMap = new Map(corridorAssignments.map((a) => [a.classId, a]));

  // For each class, run the draw algorithm and assign start times
  const resultClasses: DrawPreviewClass[] = [];
  let globalStartNo = 1;

  // Sort classes by computed first start for start number assignment
  const sortedClasses = [...classes].sort((a, b) => {
    const aStart = assignmentMap.get(a.classId)?.computedFirstStart ?? 0;
    const bStart = assignmentMap.get(b.classId)?.computedFirstStart ?? 0;
    return aStart - bStart;
  });

  for (const cls of sortedClasses) {
    const config = configMap.get(cls.classId)!;
    const assignment = assignmentMap.get(cls.classId);
    const firstStart = assignment?.computedFirstStart ?? settings.firstStart;
    const corridor = assignment?.corridor ?? 0;

    // Run the appropriate draw algorithm
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

    // Assign start times and start numbers
    const entries: DrawPreviewEntry[] = ordered.map((runner, index) => ({
      runnerId: runner.id,
      name: runner.name,
      clubName: runner.clubName,
      startTime:
        config.method === "simultaneous"
          ? firstStart
          : firstStart + index * config.interval,
      startNo: globalStartNo + index,
    }));

    resultClasses.push({
      classId: cls.classId,
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
