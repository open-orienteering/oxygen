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

/**
 * Increment when stored automatic cut/gap semantics change; events below
 * it get their editor courses rebuilt on the next geometry read.
 * 1: OCAD-parse cuts. 2: knolls and rocks only. 3: written by the course
 * layer, size-aware cuts, features from the pinned document on `vector`.
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

/** A control is "positioned" once it has been placed anywhere but the map origin. */
function isPositioned(c: GeometrySeqControl): boolean {
  return c.xMm !== 0 || c.yMm !== 0;
}

/**
 * The artifact's document context: the ISOM stack at factor 1, so the
 * layer draws the legacy 2.5 mm circle and 0.35 mm line its consumers draw
 * (user decision 2026-10-24, course-layer.md). The map's own scale enters
 * only through the cut features' symbol radii.
 */
let artifactContext: course.CourseDocumentContext | undefined;
function legacySizeContext(): course.CourseDocumentContext {
  artifactContext ??= {
    colours: symbolLibrary.paletteStack("iof2024", "ISOM2017-2").map((c) => ({ ...c, paletteIds: [c.id.slice(c.id.indexOf(":") + 1)] })),
    libraryId: "ISOM2017-2",
    documentFactor: 1,
  };
  return artifactContext;
}

const KIND = { Start: "start", Control: "control", Finish: "finish" } as const;

/**
 * The stored GeoJSON of an editor course: the course layer over the
 * sequence, projected (course-layer.md §4). Unpositioned controls are
 * omitted; `ordered` courses get straight legs between the remaining
 * consecutive controls, free-order courses points only. `cutFeatures`
 * null = no automatic cuts.
 */
export function editorCourseGeometry(
  courseId: string,
  seq: GeometrySeqControl[],
  orderMode: "ordered" | "free_order" = "ordered",
  cutFeatures: readonly course.CutFeature[] | null = null,
): course.CourseGeoJson {
  const sites = new Map<string, course.CourseSite>();
  for (const c of seq) sites.set(c.id, { id: c.id, code: c.code, kind: KIND[c.type], x: c.xMm, y: c.yMm });
  const layer = course.courseLayer({
    structure: { version: 1, id: courseId, orderMode, items: seq.map((c) => ({ siteId: c.id, role: KIND[c.type] })) },
    sites: [...sites.values()],
    objects: [],
    appearance: {},
    viewOptions: {},
    document: legacySizeContext(),
    ...(cutFeatures ? { cutFeatures } : {}),
  });
  return course.courseLayerGeoJson(layer, courseId);
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

const TYPE_OF_ROLE = { start: "Start", control: "Control", finish: "Finish" } as const;
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
        orderMode: true,
        structure: true,
      },
    });
    if (!course || course.removed) continue;

    const stored = course.structure ? courseStructureSchema.safeParse(course.structure) : null;
    if (stored?.success) {
      const items = structureControlItems(stored.data);
      const rows = await db.control.findMany({
        where: { eventId, id: { in: [...new Set(items.map((i) => i.siteId))] } },
        select: { id: true, codes: true, name: true, seq: true, status: true, kind: true, xpos: true, ypos: true },
      });
      const byId = new Map(rows.map((r) => [r.id, r]));
      const seq: GeometrySeqControl[] = [];
      for (const item of items) {
        const c = byId.get(item.siteId);
        if (!c) continue;
        seq.push({
          id: c.id,
          code: displayCode(c),
          type: item.role ? TYPE_OF_ROLE[item.role] : siteType(c),
          xMm: c.xpos,
          yMm: c.ypos,
        });
      }
      out.set(courseUuid, { seq, orderMode: course.orderMode });
      continue;
    }

    const ccs = await db.courseControl.findMany({
      where: { courseId: courseUuid },
      orderBy: { position: "asc" },
      select: {
        control: {
          select: { id: true, codes: true, name: true, seq: true, status: true, xpos: true, ypos: true },
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
          id: start.id,
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
        id: c.id,
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
          id: finish.id,
          code: displayCode(finish),
          type: "Finish",
          xMm: finish.xpos,
          yMm: finish.ypos,
        });
      }
    }

    out.set(courseUuid, { seq, orderMode: course.orderMode });
  }
  return out;
}

/** A course's structure as a reader sees it (docs/course-layer.md §6). */
export interface EffectiveStructure {
  structure: course.CourseStructure;
  /** False: `courses.structure` is NULL and this is the linear one the sequence describes. */
  stored: boolean;
}

/**
 * The structure of each given (non-removed) course: the stored one, else the
 * linear structure of `loadCourseSequences`' sequence (each item with its
 * drawn role). `orderMode` is the course's column and `labelOffsets` come
 * from `course_controls` in both cases — the column holds neither (one
 * source each). Site ids are control UUIDs.
 */
export async function loadCourseStructures(
  db: Db,
  eventId: bigint,
  courseUuids: string[],
): Promise<Map<string, EffectiveStructure>> {
  const out = new Map<string, EffectiveStructure>();
  if (courseUuids.length === 0) return out;
  const sequences = await loadCourseSequences(db, eventId, courseUuids);
  const rows = await db.course.findMany({
    where: { id: { in: [...sequences.keys()] } },
    select: { id: true, structure: true },
  });
  const ccs = await db.courseControl.findMany({
    where: { courseId: { in: [...sequences.keys()] } },
    orderBy: { position: "asc" },
    select: { courseId: true, controlId: true, labelDx: true, labelDy: true },
  });
  for (const row of rows) {
    const sequence = sequences.get(row.id);
    if (!sequence) continue;
    const labelOffsets: Record<string, { dx: number; dy: number }> = {};
    for (const cc of ccs) {
      if (cc.courseId !== row.id || cc.labelDx == null || cc.labelDy == null) continue;
      labelOffsets[cc.controlId] ??= { dx: cc.labelDx, dy: cc.labelDy };
    }
    const parsed = row.structure ? courseStructureSchema.safeParse(row.structure) : null;
    if (parsed?.success) {
      const { labelOffsets: _ignored, ...rest } = parsed.data;
      const structure = { ...rest, id: row.id, orderMode: sequence.orderMode } as course.CourseStructure;
      if (Object.keys(labelOffsets).length > 0) structure.labelOffsets = labelOffsets;
      out.set(row.id, { structure, stored: true });
    } else {
      out.set(row.id, {
        structure: course.linearStructure(
          row.id,
          sequence.seq.map((c) => ({ siteId: c.id, role: KIND[c.type] })),
          { orderMode: sequence.orderMode, labelOffsets },
        ),
        stored: false,
      });
    }
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
  const mapScale = crs?.scale ?? null;

  // Features for automatic overprint cuts around compact knoll / rock
  // point features: the pinned document on `vector` events, else the OCAD
  // parse. Null when there is no map — and skipped when the event has auto
  // overprint cuts turned off.
  const eventRow = await db.event.findUnique({
    where: { id: eventId },
    select: { autoOverprintCuts: true },
  });
  const cutFeatures =
    eventRow?.autoOverprintCuts === false
      ? null
      : ((await loadEventCutFeatures(db, eventId, mapScale))?.features ?? null);

  const sequences = await loadCourseSequences(db, eventId, courseUuids);
  for (const [courseUuid, { seq, orderMode }] of sequences) {
    const geometry = editorCourseGeometry(courseUuid, seq, orderMode, cutFeatures);

    const data: Record<string, unknown> = {
      geometry:
        geometry.features.length > 0
          ? (geometry as unknown as Prisma.InputJsonValue)
          : PrismaNs.DbNull,
      geometrySource: geometry.features.length > 0 ? "editor" : "",
    };
    // Free-order courses have no meaningful legs — leave lengthM / legs
    // alone (the organiser sets length manually). Ordered courses keep
    // the auto-derived legs string + optional length refresh.
    if (orderMode !== "free_order" && mapScale) {
      const distances = legDistancesMm(seq);
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

/**
 * Lazily migrate editor-authored geometry after an overprint-cut algorithm
 * change. Imported OCD/XML geometry is deliberately untouched.
 */
export async function ensureOverprintCutsCurrent(
  db: Db,
  eventId: bigint,
): Promise<void> {
  const event = await db.event.findUnique({
    where: { id: eventId },
    select: { overprintCutsVersion: true },
  });
  if (!event || event.overprintCutsVersion >= OVERPRINT_CUTS_VERSION) return;

  const courses = await db.course.findMany({
    where: { eventId, removed: false, geometrySource: "editor" },
    select: { id: true },
  });
  await rebuildCourseGeometry(
    db,
    eventId,
    courses.map((course) => course.id),
    { updateLength: false },
  );
  await db.event.update({
    where: { id: eventId },
    data: { overprintCutsVersion: OVERPRINT_CUTS_VERSION },
  });
}
