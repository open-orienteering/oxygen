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
 * The GeoJSON is the course layer's projection (`course.courseLayer` →
 * `course.courseLayerGeoJson`, docs/course-layer.md §4): the compatibility
 * artifact for consumers not yet drawing from the layer, computed at the
 * legacy sizes they draw (2.5 mm circles, 0.35 mm lines).
 *
 * Coordinates are paper mm (the unit of `controls.xpos/ypos` and of all
 * course-geometry GeoJSON). Terrain meters = mm × mapScale / 1000.
 */

import { course, symbolLibrary } from "@oxygen/shared";
import type { PrismaClient, Prisma } from "./generated/prisma/client.js";
import { Prisma as PrismaNs } from "./generated/prisma/client.js";
import { loadEventCrs } from "./event-crs.js";
import { loadEventCutFeatures } from "./event-map-objects.js";
import { courseSequenceOf } from "./course-structure.js";

/**
 * The stored automatic cut/gap semantics `courses.geometry` is written
 * with, stamped on `events.overprint_cuts_version` by the writes that
 * rebuild every editor course (map upload, rotation, the toggle) until
 * E5 drops both. 1: OCAD-parse cuts. 2: knolls and rocks only. 3: written
 * by the course layer, size-aware cuts, features from the pinned
 * document. Nothing reads it since E6 (the lazy read-migration went with
 * `course.geometry`); v0.5.0 still migrates an event below it on rollback.
 */
export const OVERPRINT_CUTS_VERSION = 3;

/** One entry of a course's rendered sequence (start + controls + finish). */
export interface GeometrySeqControl {
  /** The control row's id (the course layer's site id). */
  id: string;
  /** Display code for feature properties (first punch code, or name/seq fallback). */
  code: string;
  type: "Start" | "Control" | "Finish";
  xMm: number;
  yMm: number;
}

/**
 * The artifact's document context: the ISOM stack at factor 1, so the
 * layer draws the legacy 2.5 mm circle and 0.35 mm line its consumers draw
 * (user decision 2026-10-24, course-layer.md). The map's own scale enters
 * only through the cut features' symbol radii.
 */
let artifactContext: course.CourseDocumentContext | undefined;
export function legacySizeContext(): course.CourseDocumentContext {
  artifactContext ??= {
    colours: symbolLibrary.paletteStack("iof2024", "ISOM2017-2").map((c) => ({ ...c, paletteIds: [c.id.slice(c.id.indexOf(":") + 1)] })),
    libraryId: "ISOM2017-2",
    documentFactor: 1,
  };
  return artifactContext;
}

const KIND = { Start: "start", Control: "control", Finish: "finish" } as const;

/**
 * The course layer of an editor course over its sequence (course-layer.md
 * §4.1): one item per entry (`role` = the entry's type) over the rows as
 * sites, at the legacy sizes. Unpositioned controls are skipped by the
 * layer; `cutFeatures` null = no automatic cuts.
 */
export function editorCourseLayer(
  courseId: string,
  seq: GeometrySeqControl[],
  orderMode: "ordered" | "free_order" = "ordered",
  cutFeatures: readonly course.CutFeature[] | null = null,
): course.CourseLayer {
  const sites = new Map<string, course.CourseSite>();
  for (const c of seq) sites.set(c.id, { id: c.id, code: c.code, kind: KIND[c.type], x: c.xMm, y: c.yMm });
  return course.courseLayer({
    structure: { version: 1, id: courseId, orderMode, items: seq.map((c) => ({ siteId: c.id, role: KIND[c.type] })) },
    sites: [...sites.values()],
    objects: [],
    appearance: {},
    viewOptions: {},
    document: legacySizeContext(),
    ...(cutFeatures ? { cutFeatures } : {}),
  });
}

/**
 * The stored GeoJSON of an editor course: its layer, projected
 * (course-layer.md §4). Unpositioned controls are omitted; `ordered`
 * courses get straight legs between the remaining consecutive controls,
 * free-order courses points only. Written until E5 drops the column.
 */
export function editorCourseGeometry(
  courseId: string,
  seq: GeometrySeqControl[],
  orderMode: "ordered" | "free_order" = "ordered",
  cutFeatures: readonly course.CutFeature[] | null = null,
): course.CourseGeoJson {
  return course.courseLayerGeoJson(editorCourseLayer(courseId, seq, orderMode, cutFeatures), courseId);
}

/**
 * Leg lengths (paper mm) of the layer's first course: its derived legs,
 * centre to centre between consecutive positioned items (none for free
 * order). The `legs` / `lengthM` source since E6 (course-layer.md §4.1).
 */
export function legDistancesMm(layer: Pick<course.CourseLayer, "derivation">): number[] {
  const legs = layer.derivation.courses[0]?.legs ?? [];
  return legs.map((leg) => {
    const a = leg.points[0];
    const b = leg.points[leg.points.length - 1];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    return Math.sqrt(dx * dx + dy * dy);
  });
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

/** A course's rendered sequence and order mode, as `rebuildCourseGeometry` builds it. */
export interface CourseSequence {
  seq: GeometrySeqControl[];
  orderMode: "ordered" | "free_order";
}

/** A site's drawn role from its row: `kind`, else the legacy `status` 4 / 5. */
function siteType(c: { kind: string; status: string }): GeometrySeqControl["type"] {
  if (c.kind === "start" || c.status === "start") return "Start";
  if (c.kind === "finish" || c.status === "finish") return "Finish";
  return "Control";
}

const { courseStructureSchema, structureControlItems } = course;


/**
 * The rendered sequence of each given (non-removed) course.
 *
 * A course with a stored `structure` (docs/course-layer.md §6) is read from
 * it: its control items in order (a variation group by its first
 * alternative), each drawn by its `role`, else its site's kind. Otherwise
 * the sequence mirrors the importers: `course_controls` holds only regular
 * controls; the start is the event's start control matched by `startName`
 * (unless `firstAsStart`), the finish is `finishControlId` or the event's
 * first finish control (unless `lastAsFinish`). `course.update` writes the
 * structure this second path describes, so both read the same sequence.
 */
export async function loadCourseSequences(
  db: Db,
  eventId: bigint,
  courseUuids: string[],
): Promise<Map<string, CourseSequence>> {
  const out = new Map<string, CourseSequence>();
  if (courseUuids.length === 0) return out;

  // Event-level start/finish controls, shared across all courses.
  const startFinish = await db.control.findMany({
    where: { eventId, removed: false, status: { in: ["start", "finish"] } },
    orderBy: { seq: "asc" },
    select: { id: true, name: true, codes: true, seq: true, status: true, kind: true, xpos: true, ypos: true },
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
        orderMode: true,
        structure: true,
      },
    });
    if (!course || course.removed) continue;

    // The explicit start / finish and the sequence between them: the one
    // sequence rule (course-structure.ts `courseSequenceOf`) over the
    // stored structure, else the columns. Sites are drawn by their kind.
    type Row = { id: string; codes: string; name: string; seq: number; status: string; kind: string; xpos: number; ypos: number };
    const select = { id: true, codes: true, name: true, seq: true, status: true, kind: true, xpos: true, ypos: true } as const;
    const stored = course.structure ? courseStructureSchema.safeParse(course.structure) : null;
    let byId: Map<string, Row>;
    let ccIds: string[] = [];
    if (stored?.success) {
      const items = structureControlItems(stored.data);
      // A soft-deleted site drops out (an explicit start then falls back
      // to the default, as `startName` does).
      const rows = await db.control.findMany({
        where: { eventId, removed: false, id: { in: [...new Set(items.map((i) => i.siteId))] } },
        select,
      });
      byId = new Map(rows.map((r) => [r.id, r]));
    } else {
      const ccs = await db.courseControl.findMany({
        where: { courseId: courseUuid },
        orderBy: { position: "asc" },
        select: { control: { select } },
      });
      byId = new Map(ccs.map((cc) => [cc.control.id, cc.control]));
      ccIds = ccs.map((cc) => cc.control.id);
    }
    const parts = courseSequenceOf(course, ccIds, { site: (id) => byId.get(id), starts, finishes });
    const middle = parts.middle.flatMap((id) => byId.get(id) ?? []);

    const seq: GeometrySeqControl[] = [];

    const { start, finish } = parts;
    if (start) {
      seq.push({ id: start.id, code: displayCode(start), type: "Start", xMm: start.xpos, yMm: start.ypos });
    }

    for (const c of middle) {
      seq.push({
        id: c.id,
        code: displayCode(c),
        type: siteType(c),
        xMm: c.xpos,
        yMm: c.ypos,
      });
    }

    if (finish) {
      seq.push({ id: finish.id, code: displayCode(finish), type: "Finish", xMm: finish.xpos, yMm: finish.ypos });
    }

    out.set(courseUuid, { seq, orderMode: course.orderMode });
  }
  return out;
}

/**
 * Regenerate geometry (+ legs string and, optionally, length) for the given
 * courses. Call inside the mutating transaction, BEFORE emitting the
 * course.upserted journal entries so the shipped payloads carry the new
 * geometry. Sequences per `loadCourseSequences`.
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
  const mapScale = crs?.mapScale ?? null;

  // Features for automatic overprint cuts around compact knoll / rock
  // point features: the pinned document's. Null when there is no pin —
  // and skipped when the event has auto overprint cuts turned off.
  const eventRow = await db.event.findUnique({
    where: { id: eventId },
    select: { autoOverprintCuts: true },
  });
  const cutFeatures =
    eventRow?.autoOverprintCuts === false
      ? null
      : await loadEventCutFeatures(db, eventId);

  const sequences = await loadCourseSequences(db, eventId, courseUuids);
  for (const [courseUuid, { seq, orderMode }] of sequences) {
    // One layer per course: the column's projection and the lengths.
    const layer = editorCourseLayer(courseUuid, seq, orderMode, cutFeatures);
    const geometry = course.courseLayerGeoJson(layer, courseUuid);

    const data: Record<string, unknown> = {
      geometry:
        geometry.features.length > 0
          ? (geometry as unknown as Prisma.InputJsonValue)
          : PrismaNs.DbNull,
      geometrySource: geometry.features.length > 0 ? "editor" : "",
      // The length provenance the export and the Eventor sync read
      // (course-controls-and-matching.md "Course length"): an edited
      // course's length is derived from its controls.
      lengthSource: geometry.features.length > 0 ? "derived" : null,
    };
    // Free-order courses have no meaningful legs — leave lengthM / legs
    // alone (the organiser sets length manually). Ordered courses keep
    // the auto-derived legs string + optional length refresh.
    if (orderMode !== "free_order" && mapScale) {
      const distances = legDistancesMm(layer);
      if (distances.length > 0) {
        // Same format the importers write: per-leg terrain meters, ';'-joined
        // with a trailing separator.
        data.legs =
          distances.map((d) => Math.round((d * mapScale) / 1000)).join(";") +
          ";";
        if (updateLength) data.lengthM = courseLengthM(distances, mapScale);
      }
    }

    await db.course.update({ where: { id: courseUuid }, data });
  }
}
