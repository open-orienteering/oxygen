/**
 * Derived course lengths (docs/course-layer.md §4.1).
 *
 * When a course's control sequence changes, a control is moved on the
 * map, or the event map is replaced, the derived fields `legs` and
 * (optionally) `length_m` are regenerated from the course layer over the
 * course's sequence, and `length_source` is set to `derived`
 * (docs/course-controls-and-matching.md "Course length"). The GeoJSON
 * artifact this module wrote into `courses.geometry` until v0.6.0 went
 * with the column (E5).
 *
 * Coordinates are paper mm (the unit of `controls.xpos/ypos`). Terrain
 * meters = mm × mapScale / 1000.
 */

import { displayCode } from "./control-id.js";
import { course, symbolLibrary } from "@oxygen/shared";
import type { PrismaClient, Prisma } from "./generated/prisma/client.js";
import { loadEventCrs } from "./event-crs.js";
import { courseSequenceOf } from "./course-structure.js";

/** One entry of a course's rendered sequence (start + controls + finish). */
export interface GeometrySeqControl {
  /** The control row's id (the course layer's site id). */
  id: string;
  /** Display code for feature properties (first punch code, or name/seq fallback). */
  code: string;
  type: "Start" | "Control" | "Finish";
  xMm: number;
  yMm: number;
  /** The stored leg into this entry (bends, style; course-layer.md §10.1). */
  leg?: course.CourseLegProps;
  /** The crossing point the leg into this entry runs through (§10.3), when its site is live. */
  via?: { id: string; xMm: number; yMm: number };
}

/**
 * The document context the lengths are derived in: the ISOM stack at
 * factor 1 (user decision 2026-10-24, course-layer.md). Leg lengths are
 * centre to centre, so neither the sizes nor the map's scale change them.
 */
let artifactContext: course.CourseDocumentContext | undefined;
export function legacySizeContext(): course.CourseDocumentContext {
  artifactContext ??= {
    colours: symbolLibrary.paletteStack("iof2024", "ISOM2017-2").map((c) => ({ ...c, paletteIds: [c.id.slice(c.id.indexOf(":") + 1)] })),
    libraryId: "ISOM2017-2",
    documentFactor: 1,
    mapScale: 15000,
  };
  return artifactContext;
}

const KIND = { Start: "start", Control: "control", Finish: "finish" } as const;

/**
 * The course layer of an editor course over its sequence (course-layer.md
 * §4.1): one item per entry (`role` = the entry's type) over the rows as
 * sites, without automatic cuts (they do not change a leg's length). A
 * leg runs through its stored bends (§10.1) and its crossing point
 * (§10.3); its style, gaps and corridor never change its length.
 * Unpositioned controls are skipped by the layer.
 */
export function editorCourseLayer(
  courseId: string,
  seq: GeometrySeqControl[],
  orderMode: "ordered" | "free_order" = "ordered",
): course.CourseLayer {
  const sites = new Map<string, course.CourseSite>();
  for (const c of seq) sites.set(c.id, { id: c.id, code: c.code, kind: KIND[c.type], x: c.xMm, y: c.yMm });
  for (const c of seq) if (c.via && !sites.has(c.via.id)) sites.set(c.via.id, { id: c.via.id, code: "", kind: "crossing_point", x: c.via.xMm, y: c.via.yMm });
  const legOf = (c: GeometrySeqControl): course.CourseLegProps | undefined => {
    const leg: course.CourseLegProps = {};
    if (c.leg?.bends?.length) leg.bends = c.leg.bends;
    if (c.via) leg.crossing = { controlId: c.via.id };
    return Object.keys(leg).length ? leg : undefined;
  };
  return course.courseLayer({
    structure: { version: 1, id: courseId, orderMode, items: seq.map((c) => { const leg = legOf(c); return { siteId: c.id, role: KIND[c.type], ...(leg ? { leg } : {}) }; }) },
    sites: [...sites.values()],
    objects: [],
    appearance: {},
    viewOptions: {},
    document: legacySizeContext(),
  });
}

/** Whether the layer's first course draws anything: at least one positioned item. */
export function hasPositionedItems(layer: Pick<course.CourseLayer, "derivation">): boolean {
  return (layer.derivation.courses[0]?.sequence.length ?? 0) > 0;
}

/**
 * Leg lengths (paper mm) of the layer's first course: its derived legs,
 * centre to centre between consecutive positioned items through the
 * leg's bends (none for free order). The `legs` / `lengthM` source since
 * E6 (course-layer.md §4.1); a straight leg is the pre-E6 formula.
 */
export function legDistancesMm(layer: Pick<course.CourseLayer, "derivation">): number[] {
  return (layer.derivation.courses[0]?.legs ?? []).map((leg) => course.legLengthMm(leg.points));
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

// `displayCode` (control-id.ts): a start / finish by its name, else first code → name → seq (F32).

/** A course's rendered sequence and order mode, as `rebuildCourseLengths` reads it. */
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
    const viaById = new Map<string, { id: string; xpos: number; ypos: number }>();
    // The stored legs into a site, by "<previous site>><site>" over consecutive items (the
    // `carryLegs` convention: a leg is the two sites it joins), in visit order, so a pair
    // the course runs twice takes each visit's own leg (course-layer.md §4.1, §10.1).
    const legsByKey = new Map<string, Array<course.CourseLegProps | undefined>>();
    if (stored?.success) {
      const items = structureControlItems(stored.data);
      items.forEach((item, i) => {
        if (i === 0) return;
        const key = `${items[i - 1].siteId}>${item.siteId}`;
        legsByKey.set(key, [...(legsByKey.get(key) ?? []), item.leg]);
      });
      // A soft-deleted site drops out (an explicit start then falls back
      // to the default, as `startName` does).
      const rows = await db.control.findMany({
        where: { eventId, removed: false, id: { in: [...new Set(items.map((i) => i.siteId))] } },
        select,
      });
      byId = new Map(rows.map((r) => [r.id, r]));
      // The crossing points the legs run through (§10.3): a leg's length follows them.
      const viaIds = [...new Set(items.flatMap((i) => (i.leg?.crossing ? [i.leg.crossing.controlId] : [])))];
      if (viaIds.length > 0) {
        const vias = await db.control.findMany({ where: { eventId, removed: false, kind: "crossing_point", id: { in: viaIds } }, select: { id: true, xpos: true, ypos: true } });
        for (const v of vias) viaById.set(v.id, v);
      }
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

    const visits = new Map<string, number>();
    for (let i = 1; i < seq.length; i++) {
      const key = `${seq[i - 1].id}>${seq[i].id}`;
      const n = visits.get(key) ?? 0;
      visits.set(key, n + 1);
      const leg = legsByKey.get(key)?.[n];
      if (leg) seq[i].leg = leg;
      const via = viaById.get(leg?.crossing?.controlId ?? "");
      if (via && (via.xpos !== 0 || via.ypos !== 0)) seq[i].via = { id: via.id, xMm: via.xpos, yMm: via.ypos };
    }

    out.set(courseUuid, { seq, orderMode: course.orderMode });
  }
  return out;
}

/**
 * Regenerate the derived `legs` string, `length_source` and, optionally,
 * `length_m` for the given courses (docs/course-layer.md §4.1). Call
 * inside the mutating transaction, BEFORE emitting the course.upserted
 * journal entries so the shipped payloads carry the new values. Sequences
 * per `loadCourseSequences`.
 */
export async function rebuildCourseLengths(
  db: Db,
  eventId: bigint,
  courseUuids: string[],
  opts: { updateLength?: boolean } = {},
): Promise<void> {
  if (courseUuids.length === 0) return;
  const updateLength = opts.updateLength ?? true;

  const crs = await loadEventCrs(db, eventId);
  const mapScale = crs?.mapScale ?? null;

  const sequences = await loadCourseSequences(db, eventId, courseUuids);
  for (const [courseUuid, { seq, orderMode }] of sequences) {
    const layer = editorCourseLayer(courseUuid, seq, orderMode);

    const data: Prisma.CourseUpdateInput = {
      // The length provenance the export and the Eventor sync read
      // (course-controls-and-matching.md "Course length"): an edited
      // course's length is derived from its controls; one with no
      // positioned control has neither.
      lengthSource: hasPositionedItems(layer) ? "derived" : null,
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
