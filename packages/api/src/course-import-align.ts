/**
 * Decide whether an imported course file's coordinates belong on the
 * event's map — and fix them when we can.
 *
 * Purple Pen stores control positions as paper millimetres anchored to
 * one specific map file. Import them against a different map and every
 * control lands off by the two files' georeference difference (kilometres,
 * in practice). Oxygen therefore:
 *
 *   1. treats a file/event map name match as already aligned;
 *   2. otherwise re-projects through WGS84 when the map the courses were
 *      set on is in the club library ("transformed");
 *   3. otherwise checks the positions against the event map's own extent
 *      and reports a "mismatch" so the UI can warn and offer to import
 *      the courses without positions.
 *
 * IOF XML and OCAD imports name no map file and are reported "unknown",
 * which leaves their behaviour untouched.
 */

import { loadEventCrs } from "./event-crs.js";
import { documentPaperFrame, eventPin } from "./map-store/event-document.js";
import { transferParsedCoordinates } from "./map-coordinate-transfer.js";
import type { MapCalibrationPoint } from "./event-map.js";
import type { ParsedCourseData } from "./iof-course-parser.js";
import type { PrismaClient, Prisma } from "./generated/prisma/client.js";

type Db = PrismaClient | Prisma.TransactionClient;

export type CourseImportAlignment =
  /** Nothing to check: no source map recorded, or the event has no map. */
  | "unknown"
  /** Same map file, or positions already fall on the event's map. */
  | "aligned"
  /** Re-projected from the source map into the event map's paper system. */
  | "transformed"
  /** Positions belong to another map and we cannot re-project them. */
  | "mismatch";

export interface AlignmentOutcome {
  status: CourseImportAlignment;
  /** Possibly re-projected copy of the input. */
  parsed: ParsedCourseData;
  /** Map file the courses were set on, when the format records it. */
  sourceMapName: string | null;
  /** "OCAD", "PDF", … — a PDF source can never be re-projected. */
  sourceMapKind: string | null;
  /** Club-library map the coordinates were re-projected from. */
  alignedFromMapName: string | null;
  /** The event's current map file name. */
  eventMapName: string | null;
}

/** Compare recorded map file names, tolerating case and a changed suffix. */
export function sameMapFile(a: string, b: string): boolean {
  const norm = (s: string) => s.trim().toLowerCase();
  const stem = (s: string) => norm(s).replace(/\.[^.]+$/, "");
  if (!a || !b) return false;
  return norm(a) === norm(b) || stem(a) === stem(b);
}

/**
 * True when the file's placed controls sit well outside the event map.
 *
 * Uses the centroid rather than every point so one stray control does
 * not condemn an otherwise-fine file, and pads the extent by 5% of the
 * map's larger side so controls just off the printed edge still pass.
 */
export function positionsOffMap(
  controls: Array<{ mapX: number; mapY: number }>,
  calibration: MapCalibrationPoint[],
): boolean {
  const placed = controls.filter((c) => c.mapX !== 0 || c.mapY !== 0);
  if (placed.length === 0 || calibration.length === 0) return false;

  const xs = calibration.map((p) => p.mapX);
  const ys = calibration.map((p) => p.mapY);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const margin = 0.05 * Math.max(maxX - minX, maxY - minY);

  const cx = placed.reduce((s, c) => s + c.mapX, 0) / placed.length;
  const cy = placed.reduce((s, c) => s + c.mapY, 0) / placed.length;

  return (
    cx < minX - margin ||
    cx > maxX + margin ||
    cy < minY - margin ||
    cy > maxY + margin
  );
}

function asCalibration(value: unknown): MapCalibrationPoint[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (p): p is MapCalibrationPoint =>
      !!p &&
      typeof p === "object" &&
      typeof (p as MapCalibrationPoint).mapX === "number" &&
      typeof (p as MapCalibrationPoint).mapY === "number",
  );
}

/** A club map series' latest version, as the alignment matches it. */
export interface ClubVersionCandidate {
  seriesName: string;
  label: string;
  sourceFileName: string;
  documentHash: string;
  rotationCorrection: number;
}

/**
 * The club library version a course file was set on: the first series
 * whose latest version's label, else its source file name, names the
 * recorded map file (`sameMapFile`). The label is what the library shows
 * as the map's file name (`club-map-library.ts`).
 */
export function matchClubVersion(
  sourceFileName: string,
  candidates: ClubVersionCandidate[],
): ClubVersionCandidate | null {
  return (
    candidates.find((c) => sameMapFile(sourceFileName, c.label)) ??
    candidates.find((c) => sameMapFile(sourceFileName, c.sourceFileName)) ??
    null
  );
}

async function clubVersionCandidates(db: Db): Promise<ClubVersionCandidate[]> {
  const series = await db.clubMap.findMany({
    select: {
      name: true,
      rotationCorrection: true,
      versions: {
        orderBy: { seq: "desc" },
        take: 1,
        select: { label: true, documentHash: true, source: { select: { fileName: true } } },
      },
    },
    orderBy: { createdAt: "asc" },
  });
  return series.flatMap((s) =>
    s.versions.map((v) => ({
      seriesName: s.name,
      label: v.label,
      sourceFileName: v.source.fileName,
      documentHash: v.documentHash,
      rotationCorrection: s.rotationCorrection,
    })),
  );
}

/**
 * Resolve the coordinate alignment of a parsed course file against the
 * event's map, re-projecting the coordinates when possible.
 */
export async function resolveImportAlignment(
  db: Db,
  eventId: bigint,
  parsed: ParsedCourseData,
): Promise<AlignmentOutcome> {
  const base: AlignmentOutcome = {
    status: "unknown",
    parsed,
    sourceMapName: parsed.sourceMap?.fileName ?? null,
    sourceMapKind: parsed.sourceMap?.kind ?? null,
    alignedFromMapName: null,
    eventMapName: null,
  };

  const source = parsed.sourceMap;
  if (!source) return base;

  const eventMap = await eventPin(db, eventId);
  if (!eventMap) return base;

  const outcome: AlignmentOutcome = {
    ...base,
    eventMapName: eventMap.fileName || null,
  };

  // The courses were set on the very map the event uses: paper mm
  // already share an origin.
  if (sameMapFile(source.fileName, eventMap.fileName)) {
    return { ...outcome, status: "aligned" };
  }

  // Try to re-project from the source map, if the club library has it:
  // through its latest version's document and the series' correction.
  const match = matchClubVersion(source.fileName, await clubVersionCandidates(db));
  if (match) {
    const fromCrs = await documentPaperFrame(db, match.documentHash, match.rotationCorrection);
    // loadEventCrs already includes the event map's persisted correction.
    const toCrs = await loadEventCrs(db, eventId);
    if (fromCrs && toCrs) {
      const moved = transferParsedCoordinates(parsed, fromCrs, toCrs);
      if (moved) {
        return {
          ...outcome,
          status: "transformed",
          parsed: moved,
          alignedFromMapName: match.seriesName || match.label || match.sourceFileName,
        };
      }
    }
  }

  // No source map available: judge the positions on their own merits.
  const calibration = asCalibration(eventMap.calibration);
  if (calibration.length === 0) return outcome;
  return {
    ...outcome,
    status: positionsOffMap(parsed.controls, calibration)
      ? "mismatch"
      : "aligned",
  };
}
