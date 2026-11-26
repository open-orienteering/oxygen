/**
 * Draw engine — orchestrates the multi-class draw by combining
 * the corridor optimizer with per-class draw algorithms.
 *
 * The engine speaks **per-event integer seqs** publicly (matching the
 * `@oxygen/shared` `ClassDrawConfig.classId` shape and what the web
 * panel passes in), and resolves seq → UUID at the DB boundary.
 *
 * It is split in two so preview and execute produce the same draw
 * (review RES-15): `loadDrawInputs` reads the database (on the singleton or
 * on the execute transaction), and `computeDraw` is a pure function of those
 * inputs and a seed. The result carries a `previewToken` fingerprint that
 * `draw.execute` compares to refuse a stale preview.
 */

import { createHash } from "node:crypto";
import type { Prisma, PrismaClient } from "../generated/prisma/client.js";
import type {
  ClassDrawConfig,
  DrawOptions,
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
import {
  optimizeDraw,
  DEFAULT_FIRST_CONTROL_GAP,
  type ClassCourseInfo,
} from "./optimizer.js";
import { classRng } from "./rng.js";
import { valueToRunnerStatus } from "../statusConvert.js";
import { toAbsolute } from "../timeConvert.js";

type Db = PrismaClient | Prisma.TransactionClient;

export const DEFAULT_DRAW_OPTIONS: DrawOptions = { mode: "all", force: false };

/** A runner the draw places, with what the journal needs to name it. */
export interface DrawInputRunner extends DrawRunner {
  seq: number;
  cardNo: number | null;
  /** Current start, absolute deciseconds (0 = none). */
  startTime: number;
}

export interface ClassData {
  classSeq: number;
  classUuid: string;
  className: string;
  courseSeq: number; // 0 if class has no course
  courseUuid: string | null;
  courseName: string;
  /** Up to 5 first-control codes, used for course-overlap detection. */
  initialControls: number[];
  /** The runners this draw places, in stable (seq) order. */
  runners: DrawInputRunner[];
  /** Runners who have started or finished and keep their start (RES-03). */
  skippedStarted: number;
  /** Absolute start times of the class's runners that the draw keeps. */
  keptStarts: number[];
}

export interface DrawInputs {
  classes: ClassData[];
  warnings: string[];
  /** Highest start number among runners the draw does not renumber. */
  maxKeptStartNo: number;
}

const withdrawnEnums = WITHDRAWN_STATUSES.map(valueToRunnerStatus);

/**
 * Statuses that mean the runner has run (a result). The other non-Unknown
 * statuses (DNS, No timing, Not competing, Out of competition) are often set
 * before the start, so on their own they do not keep a runner out of the
 * draw; a finish time, read card or punch still does.
 */
export const RESULT_STATUSES = ["ok", "missing_punch", "dnf", "dq", "over_max_time"] as const;
const resultStatuses = new Set<string>(RESULT_STATUSES);

/**
 * Whether a runner has started or finished, so a redraw must keep their start
 * (RES-03): a finish time, a result status (`RESULT_STATUSES`), a read card,
 * or any stored punch for their card.
 */
function hasStarted(
  r: {
    finishTime: number;
    status: string;
    cardNo: number | null;
    card: { readoutId: string | null; readCount: number } | null;
  },
  readCards: Set<number>,
  punchedCards: Set<number>,
): boolean {
  if (r.finishTime !== 0) return true;
  if (resultStatuses.has(r.status)) return true;
  if (r.card && (r.card.readoutId !== null || r.card.readCount > 0)) return true;
  if (r.cardNo !== null && (readCards.has(r.cardNo) || punchedCards.has(r.cardNo))) return true;
  return false;
}

/** Read everything the draw needs for the selected classes. */
export async function loadDrawInputs(
  db: Db,
  eventId: bigint,
  zeroTime: number,
  classConfigs: ClassDrawConfig[],
  options: DrawOptions = DEFAULT_DRAW_OPTIONS,
): Promise<DrawInputs> {
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
    // Stable input order, so the same seed gives the same draw.
    orderBy: { seq: "asc" },
    select: {
      id: true,
      seq: true,
      name: true,
      clubName: true,
      eventorClubId: true,
      cardNo: true,
      startNo: true,
      startTime: true,
      finishTime: true,
      status: true,
      rank: true,
      classId: true,
      card: { select: { readoutId: true, readCount: true } },
    },
  });

  const cardNos = dbRunners.flatMap((r) => (r.cardNo !== null ? [r.cardNo] : []));
  const [readouts, punches] = cardNos.length
    ? await Promise.all([
        db.cardReadout.findMany({
          where: { eventId, cardNo: { in: cardNos } },
          select: { cardNo: true },
          distinct: ["cardNo"],
        }),
        db.punch.findMany({
          where: { eventId, cardNo: { in: cardNos }, removed: false },
          select: { cardNo: true },
          distinct: ["cardNo"],
        }),
      ])
    : [[], []];
  const readCards = new Set(readouts.map((r) => r.cardNo));
  const punchedCards = new Set(punches.map((p) => p.cardNo));

  const drawnIds = new Set<string>();
  const runnersByClassUuid = new Map<string, DrawInputRunner[]>();
  const skippedByClassUuid = new Map<string, number>();
  const keptByClassUuid = new Map<string, number[]>();
  for (const r of dbRunners) {
    if (!r.classId) continue;
    const started = hasStarted(r, readCards, punchedCards);
    const keep =
      (started && !options.force) ||
      (options.mode === "onlyMissing" && r.startTime !== 0);
    if (keep) {
      if (started && !options.force) {
        skippedByClassUuid.set(r.classId, (skippedByClassUuid.get(r.classId) ?? 0) + 1);
      }
      if (r.startTime !== 0) {
        const kept = keptByClassUuid.get(r.classId) ?? [];
        kept.push(toAbsolute(r.startTime, zeroTime));
        keptByClassUuid.set(r.classId, kept);
      }
      continue;
    }
    drawnIds.add(r.id);
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
      seq: r.seq,
      cardNo: r.cardNo,
      name: r.name,
      clubId: clubKey,
      clubName: r.clubName,
      startNo: r.startNo,
      startTime: toAbsolute(r.startTime, zeroTime),
      rank: r.rank,
    });
    runnersByClassUuid.set(r.classId, list);
  }

  // Start numbers continue after every number the draw does not rewrite
  // (other classes, and kept runners in the drawn ones), so a redraw of one
  // class never duplicates another class's numbers (RES-17).
  const numbered = await db.runner.findMany({
    where: { eventId, removed: false, startNo: { gt: 0 } },
    select: { id: true, startNo: true },
  });
  let maxKeptStartNo = 0;
  for (const r of numbered) {
    if (!drawnIds.has(r.id) && r.startNo > maxKeptStartNo) maxKeptStartNo = r.startNo;
  }

  const classes: ClassData[] = [];
  for (const config of classConfigs) {
    const cls = classBySeq.get(config.classId);
    if (!cls) {
      warnings.push(`Class ${config.classId} not found`);
      continue;
    }
    const runners = runnersByClassUuid.get(cls.id) ?? [];
    const skippedStarted = skippedByClassUuid.get(cls.id) ?? 0;
    if (runners.length === 0 && skippedStarted === 0 && options.mode === "all") {
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
      skippedStarted,
      keptStarts: (keptByClassUuid.get(cls.id) ?? []).sort((a, b) => a - b),
    });
  }

  return { classes, warnings, maxKeptStartNo };
}

/** Deciseconds as `M:SS` for warning text. */
function formatGap(ds: number): string {
  const totalSec = Math.round(ds / 10);
  return `${Math.floor(totalSec / 60)}:${String(totalSec % 60).padStart(2, "0")}`;
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
 * The draw itself: a pure function of the loaded inputs and the seed. The
 * same inputs and seed give the same result and the same `previewToken`.
 */
export function computeDraw(
  inputs: DrawInputs,
  classConfigs: ClassDrawConfig[],
  settings: DrawSettings,
  seed: number,
  options: DrawOptions = DEFAULT_DRAW_OPTIONS,
): DrawPreviewResultInternal {
  const classes = inputs.classes;
  const warnings = [...inputs.warnings];

  const configBySeq = new Map(classConfigs.map((c) => [c.classId, c]));
  // A mass start is one instant, so it has no interval as far as the
  // scheduler and the first-control spacing are concerned.
  const intervalOf = (config: ClassDrawConfig): number =>
    config.method === "simultaneous" ? 0 : config.interval;

  // Late entries go after the class's last kept start unless the organiser
  // pinned the block.
  const appendAfterKept = (cls: ClassData, config: ClassDrawConfig): number | undefined => {
    if (config.firstStart !== undefined) return config.firstStart;
    if (options.mode !== "onlyMissing" || cls.keptStarts.length === 0) return undefined;
    // A mass start's late entries join the field at the same instant.
    return cls.keptStarts[cls.keptStarts.length - 1] + intervalOf(config);
  };

  const courseInfos: ClassCourseInfo[] = classes.map((cls) => {
    const config = configBySeq.get(cls.classSeq)!;
    return {
      classId: cls.classSeq,
      runnerCount: cls.runners.length,
      courseId: cls.courseSeq,
      initialControls: cls.initialControls,
      interval: intervalOf(config),
      fixedFirstStart: appendAfterKept(cls, config),
      corridorHint: config.corridorHint,
      orderHint: config.orderHint,
      startOffset: config.startOffset,
    };
  });

  const gap = settings.detectCourseOverlap
    ? (settings.minFirstControlGap ?? DEFAULT_FIRST_CONTROL_GAP)
    : 0;
  if (gap > 0) {
    for (const cls of classes) {
      const interval = intervalOf(configBySeq.get(cls.classSeq)!);
      if (interval > 0 && interval < gap && cls.initialControls.length > 0) {
        warnings.push(
          `Class "${cls.className}" starts every ${formatGap(interval)}, which is closer than the ${formatGap(gap)} minimum at its first control`,
        );
      }
    }
  }

  const { assignments: corridorAssignments, conflicts } = optimizeDraw(courseInfos, settings);
  const assignmentMap = new Map(
    corridorAssignments.map((a) => [a.classId, a]),
  );
  const nameBySeq = new Map(classes.map((c) => [c.classSeq, c.className]));
  for (const c of conflicts) {
    warnings.push(
      `"${nameBySeq.get(c.classA)}" and "${nameBySeq.get(c.classB)}" send ${c.pairs} pair${
        c.pairs > 1 ? "s" : ""
      } of runners to control ${c.control} less than ${formatGap(gap)} apart`,
    );
  }

  const resultClasses: DrawPreviewClassInternal[] = [];
  let globalStartNo = inputs.maxKeptStartNo + 1;

  // Sort by computed first start so start numbers go in chronological order.
  const sorted = [...classes].sort((a, b) => {
    const ai = assignmentMap.get(a.classSeq)?.computedFirstStart ?? 0;
    const bi = assignmentMap.get(b.classSeq)?.computedFirstStart ?? 0;
    return ai - bi || a.classSeq - b.classSeq;
  });

  for (const cls of sorted) {
    const config = configBySeq.get(cls.classSeq)!;
    const assignment = assignmentMap.get(cls.classSeq);
    const firstStart = assignment?.computedFirstStart ?? settings.firstStart;
    const corridor = assignment?.corridor ?? 0;
    const rng = classRng(seed, cls.classSeq);

    let ordered: DrawRunner[];
    switch (config.method) {
      case "clubSeparation":
        ordered = clubSeparationDraw(cls.runners, rng);
        break;
      case "seeded":
        ordered = seededDraw(cls.runners, rng, { clubSeparation: true });
        break;
      case "simultaneous":
        ordered = simultaneousDraw(cls.runners, rng);
        break;
      case "random":
      default:
        ordered = randomDraw(cls.runners, rng);
        break;
    }

    const interval = intervalOf(config);
    const kept = new Set(cls.keptStarts);
    let clashes = 0;
    let replaced = 0;
    const entries: DrawPreviewEntryInternal[] = ordered.map((dr, idx) => {
      const r = dr as DrawInputRunner;
      const startTime = firstStart + idx * interval;
      if (interval > 0 && kept.has(startTime)) clashes++;
      if (r.startTime !== 0) replaced++;
      return {
        runnerId: r.id, // UUID
        runnerSeq: r.seq,
        cardNo: r.cardNo,
        name: r.name,
        clubName: r.clubName,
        startTime,
        startNo: globalStartNo + idx,
      };
    });
    if (clashes > 0) {
      warnings.push(
        `${clashes} drawn start${clashes > 1 ? "s" : ""} in "${cls.className}" fall on the same time as a runner who keeps their start`,
      );
    }

    resultClasses.push({
      classId: cls.classSeq,
      classUuid: cls.classUuid,
      className: cls.className,
      courseName: cls.courseName,
      corridor,
      computedFirstStart: firstStart,
      interval,
      entries,
      skippedStarted: cls.skippedStarted,
      replaced,
      // The class's own first start and interval change only when the draw
      // lays out the whole class: not when it places nobody, not when it
      // appends late entries to kept starts, and not when started runners
      // stay on the old grid.
      writesClass:
        entries.length > 0 &&
        !(options.mode === "onlyMissing" && cls.keptStarts.length > 0) &&
        cls.skippedStarted === 0,
    });
    globalStartNo += ordered.length;
  }

  const result = {
    classes: resultClasses,
    warnings,
    seed,
    skippedStarted: resultClasses.reduce((n, c) => n + c.skippedStarted, 0),
    replaced: resultClasses.reduce((n, c) => n + c.replaced, 0),
  };
  return { ...result, previewToken: drawToken(result, options) };
}

/**
 * Fingerprint of a draw: the seed, the options and every value `execute`
 * would write. Any change between preview and execute (a late entry, a class
 * move, a club change, another class renumbered) changes it.
 */
function drawToken(
  result: Omit<DrawPreviewResultInternal, "previewToken">,
  options: DrawOptions,
): string {
  const h = createHash("sha256");
  h.update(JSON.stringify([result.seed, options.mode, options.force]));
  for (const c of result.classes) {
    h.update(JSON.stringify([c.classUuid, c.computedFirstStart, c.interval, c.writesClass]));
    for (const e of c.entries) h.update(JSON.stringify([e.runnerId, e.startTime, e.startNo]));
  }
  return h.digest("hex");
}

/**
 * Load and compute in one go (no DB writes). The returned
 * `entries[].runnerId` is the runner's UUID — the router decides what shape
 * to expose to the UI.
 */
export async function generateDrawPreview(
  db: Db,
  eventId: bigint,
  zeroTime: number,
  classConfigs: ClassDrawConfig[],
  settings: DrawSettings,
  seed: number,
  options: DrawOptions = DEFAULT_DRAW_OPTIONS,
): Promise<DrawPreviewResultInternal> {
  const inputs = await loadDrawInputs(db, eventId, zeroTime, classConfigs, options);
  return computeDraw(inputs, classConfigs, settings, seed, options);
}

/** Internal preview entry — keeps the UUID alongside the public seq. */
export interface DrawPreviewEntryInternal extends Omit<DrawPreviewEntry, "runnerId"> {
  /** Runner UUID. */
  runnerId: string;
  runnerSeq: number;
  cardNo: number | null;
}
export interface DrawPreviewClassInternal extends Omit<DrawPreviewClass, "entries"> {
  classUuid: string;
  entries: DrawPreviewEntryInternal[];
  /** Whether execute writes the class's first start and interval. */
  writesClass: boolean;
}
export interface DrawPreviewResultInternal extends Omit<DrawPreviewResult, "classes"> {
  classes: DrawPreviewClassInternal[];
}
