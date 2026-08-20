/**
 * Editor course-geometry builder.
 *
 * When a course's control sequence changes, or a control is moved on the
 * map, the stored GeoJSON overlay (`courses.geometry`) and derived fields
 * (`length_m`, `legs`) must be regenerated. Imported geometry ('ocd' /
 * 'xml' sources) is import-time only, so any edit switches the course to
 * `geometrySource: "editor"` with straight-line legs — the same shape the
 * IOF XML importer produces.
 *
 * Coordinates are paper mm (the unit of `controls.xpos/ypos` and of all
 * course-geometry GeoJSON). Terrain meters = mm × mapScale / 1000.
 */

import type {
  GeoJSONFeature,
  GeoJSONFeatureCollection,
} from "./iof-course-parser.js";
import type { PrismaClient, Prisma } from "./generated/prisma/client.js";
import { Prisma as PrismaNs } from "./generated/prisma/client.js";
import { loadEventCrs } from "./event-crs.js";
import { loadEventMapObjects } from "./event-map-objects.js";
import { decorateOverprintCuts } from "./overprint-cuts.js";

/** One entry of a course's rendered sequence (start + controls + finish). */
export interface GeometrySeqControl {
  /** Display code for feature properties (first punch code, or name/seq fallback). */
  code: string;
  type: "Start" | "Control" | "Finish";
  xMm: number;
  yMm: number;
}

/** A control is "positioned" once it has been placed anywhere but the map origin. */
function isPositioned(c: GeometrySeqControl): boolean {
  return c.xMm !== 0 || c.yMm !== 0;
}

/**
 * Build the straight-leg GeoJSON FeatureCollection for an ordered course
 * sequence. Unpositioned controls are omitted; legs connect the remaining
 * consecutive controls so a single unplaced control does not break the
 * route line.
 */
export function buildEditorGeometry(
  seq: GeometrySeqControl[],
): GeoJSONFeatureCollection {
  const positioned = seq.filter(isPositioned);
  const features: GeoJSONFeature[] = [];

  for (const c of positioned) {
    features.push({
      type: "Feature",
      geometry: { type: "Point", coordinates: [c.xMm, c.yMm] },
      properties: {
        symbolType: c.type.toLowerCase(),
        code: c.code,
        id: c.code,
      },
    });
  }

  for (let i = 0; i < positioned.length - 1; i++) {
    const a = positioned[i];
    const b = positioned[i + 1];
    features.push({
      type: "Feature",
      geometry: {
        type: "LineString",
        coordinates: [
          [a.xMm, a.yMm],
          [b.xMm, b.yMm],
        ],
      },
      properties: { symbolType: "leg", from: a.code, to: b.code },
    });
  }

  return { type: "FeatureCollection", features };
}

/** Euclidean distances (paper mm) between consecutive positioned controls. */
export function legDistancesMm(seq: GeometrySeqControl[]): number[] {
  const positioned = seq.filter(isPositioned);
  const out: number[] = [];
  for (let i = 0; i < positioned.length - 1; i++) {
    const dx = positioned[i + 1].xMm - positioned[i].xMm;
    const dy = positioned[i + 1].yMm - positioned[i].yMm;
    out.push(Math.sqrt(dx * dx + dy * dy));
  }
  return out;
}

/** Total course length in terrain meters, rounded (mm × scale / 1000). */
export function courseLengthM(
  distancesMm: number[],
  mapScale: number,
): number {
  const totalMm = distancesMm.reduce((sum, d) => sum + d, 0);
  // mm on paper × scale = mm in terrain; ÷1000 → meters.
  return Math.round((totalMm * mapScale) / 1000);
}

type Db = PrismaClient | Prisma.TransactionClient;

/** First punch code, falling back to name then seq — the display code. */
function displayCode(c: { codes: string; name: string; seq: number }): string {
  const first = c.codes.split(";")[0]?.trim();
  return first || c.name || String(c.seq);
}

/**
 * Regenerate geometry (+ legs string and, optionally, length) for the given
 * courses. Call inside the mutating transaction, BEFORE emitting the
 * course.upserted journal entries so the shipped payloads carry the new
 * geometry.
 *
 * Sequence construction mirrors the importers: `course_controls` holds only
 * regular controls; the start is the event's start control matched by
 * `startName` (unless `firstAsStart`), the finish is `finishControlId` or
 * the event's first finish control (unless `lastAsFinish`).
 */
export async function rebuildCourseGeometry(
  db: Db,
  eventId: bigint,
  courseUuids: string[],
  opts: { updateLength?: boolean } = {},
): Promise<void> {
  if (courseUuids.length === 0) return;
  const updateLength = opts.updateLength ?? true;

  const crs = await loadEventCrs(db, eventId);
  const mapScale = crs?.scale ?? null;

  // Base-map objects for automatic overprint cuts (circle slits over
  // black features / knolls, leg gaps over black features). Cached per
  // event, null when there is no map.
  const mapObjects = await loadEventMapObjects(db, eventId);

  // Event-level start/finish controls, shared across all rebuilt courses.
  const startFinish = await db.control.findMany({
    where: { eventId, removed: false, status: { in: ["start", "finish"] } },
    orderBy: { seq: "asc" },
    select: { id: true, name: true, codes: true, seq: true, status: true, xpos: true, ypos: true },
  });
  const starts = startFinish.filter((c) => c.status === "start");
  const finishes = startFinish.filter((c) => c.status === "finish");

  for (const courseUuid of courseUuids) {
    const course = await db.course.findUnique({
      where: { id: courseUuid },
      select: {
        id: true,
        removed: true,
        firstAsStart: true,
        lastAsFinish: true,
        startName: true,
        finishControlId: true,
      },
    });
    if (!course || course.removed) continue;

    const ccs = await db.courseControl.findMany({
      where: { courseId: courseUuid },
      orderBy: { position: "asc" },
      select: {
        control: {
          select: { codes: true, name: true, seq: true, status: true, xpos: true, ypos: true },
        },
      },
    });

    const seq: GeometrySeqControl[] = [];

    if (!course.firstAsStart) {
      const start =
        (course.startName
          ? starts.find((s) => s.name === course.startName)
          : undefined) ?? starts[0];
      if (start) {
        seq.push({
          code: displayCode(start),
          type: "Start",
          xMm: start.xpos,
          yMm: start.ypos,
        });
      }
    }

    for (const cc of ccs) {
      const c = cc.control;
      seq.push({
        code: displayCode(c),
        type:
          c.status === "start" ? "Start" : c.status === "finish" ? "Finish" : "Control",
        xMm: c.xpos,
        yMm: c.ypos,
      });
    }

    if (!course.lastAsFinish) {
      const finish =
        (course.finishControlId
          ? finishes.find((f) => f.id === course.finishControlId)
          : undefined) ?? finishes[0];
      if (finish) {
        seq.push({
          code: displayCode(finish),
          type: "Finish",
          xMm: finish.xpos,
          yMm: finish.ypos,
        });
      }
    }

    const geometry = buildEditorGeometry(seq);
    if (mapObjects && mapObjects.length > 0) {
      decorateOverprintCuts(geometry, mapObjects);
    }
    const distances = legDistancesMm(seq);

    const data: Record<string, unknown> = {
      geometry:
        geometry.features.length > 0
          ? (geometry as unknown as Prisma.InputJsonValue)
          : PrismaNs.DbNull,
      geometrySource: geometry.features.length > 0 ? "editor" : "",
    };
    if (mapScale && distances.length > 0) {
      // Same format the importers write: per-leg terrain meters, ';'-joined
      // with a trailing separator.
      data.legs =
        distances.map((d) => Math.round((d * mapScale) / 1000)).join(";") + ";";
      if (updateLength) data.lengthM = courseLengthM(distances, mapScale);
    }

    await db.course.update({ where: { id: courseUuid }, data });
  }
}
