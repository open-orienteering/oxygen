/**
 * Course export endpoints (IOF 3.0 CourseData XML and Purple Pen `.ppen`).
 *
 * `GET /api/export/course-data?name=<nameId>&format=iofxml|ppen` returns
 * every course of the event as an attachment. Default format is `iofxml`
 * (for Condes / Purple Pen / OCAD via the interchange format). `ppen`
 * writes native CourseScribe XML that Purple Pen opens directly.
 *
 * Document layout lives in `iof-course-export.ts` / `ppen-course-export.ts`
 * (pure); this module maps DB rows onto them. Each course's sequence and
 * leg lengths are `loadCourseSequences` / `editorCourseLayer` in
 * `course-geometry.ts` — the reader `rebuildCourseLengths` writes
 * `legs` / `length_m` from — so the exported `LegLength`s run along the
 * legs' bends and through their crossing points and equal the stored ones
 * (docs/course-controls-and-matching.md "Course length").
 *
 * The structure (slice F, row F9; docs/iof-coursedata-export.md): a root
 * with variants is not exported, its variants are, each with the root's
 * name as the family, and a class on the root is assigned to each of
 * them; a leg's crossing point is a `CrossingPoint` row before its end
 * row, a marked route a `TapedRoute` instruction on its end row; a map
 * exchange site carries the exchange marker; map-issue points are not
 * exported.
 */

import type { FastifyInstance } from "fastify";
import { prisma } from "./db.js";
import { assertRestAccess } from "./restGuard.js";
import { loadEventCrs } from "./event-crs.js";
import { mapMmToWgs84 } from "./map-projection.js";
import {
  buildCourseDataXml,
  type CourseDataExport,
  type ExportControlSite,
  type ExportCourse,
  type ExportCourseControl,
} from "./iof-course-export.js";
import { buildPpenXml } from "./ppen-course-export.js";
import { courseSequenceOf } from "./course-structure.js";
import { courseLengthM, editorCourseLayer, legDistancesMm, loadCourseSequences } from "./course-geometry.js";
import type { PrismaClient, Prisma } from "./generated/prisma/client.js";

type Db = PrismaClient | Prisma.TransactionClient;

/** First punch code, falling back to name then seq — the display code. */
function displayCode(c: { codes: string; name: string; seq: number }): string {
  const first = c.codes.split(";")[0]?.trim();
  return first || c.name || String(c.seq);
}

/** A site's exported `type`: its kind, else the legacy `status` 4 / 5. */
function siteType(c: { kind: string; status: string }): ExportControlSite["type"] {
  if (c.kind === "crossing_point") return "CrossingPoint";
  if (c.kind === "start" || c.status === "start") return "Start";
  if (c.kind === "finish" || c.status === "finish") return "Finish";
  return "Control";
}

export type CourseExportFormat = "iofxml" | "ppen";

export interface GatheredCourseExport extends CourseDataExport {
  mapFileName?: string;
}

/**
 * Load the event's controls, courses and class assignments into the
 * shared export shape used by both IOF and Purple Pen writers.
 */
export async function gatherEventCourseExport(
  db: Db,
  event: { id: bigint; name: string },
): Promise<GatheredCourseExport> {
  const crs = await loadEventCrs(db, event.id);
  const mapScale = crs?.mapScale ?? 15000;

  const mapFile = await db.mapFile.findFirst({
    where: { eventId: event.id },
    orderBy: { uploadedAt: "desc" },
    select: { fileName: true },
  });

  const controls = await db.control.findMany({
    // A map-issue point is a setter's note (course-layer.md §10.3): no IOF type, not exported.
    where: { eventId: event.id, removed: false, kind: { not: "map_issue" } },
    orderBy: { seq: "asc" },
    select: {
      id: true, seq: true, name: true, codes: true, status: true, kind: true,
      xpos: true, ypos: true, lat: true, lng: true,
    },
  });

  const sites: ExportControlSite[] = [];
  /** Control UUID → exported id, for the course sequences. */
  const idByUuid = new Map<string, string>();
  const rowByUuid = new Map(controls.map((c) => [c.id, c]));
  for (const c of controls) {
    const id = displayCode(c);
    idByUuid.set(c.id, id);
    let { lat, lng } = c;
    if ((lat == null || lng == null) && crs && (c.xpos !== 0 || c.ypos !== 0)) {
      const wgs = mapMmToWgs84(c.xpos, c.ypos, crs);
      if (wgs) {
        lat = wgs.lat;
        lng = wgs.lng;
      }
    }
    sites.push({
      id,
      type: siteType(c),
      xMm: c.xpos,
      yMm: c.ypos,
      lat,
      lng,
      ...(c.kind === "map_exchange" ? { mapExchange: true } : {}),
    });
  }

  const starts = controls.filter((c) => c.status === "start");
  const finishes = controls.filter((c) => c.status === "finish");

  const courseRows = await db.course.findMany({
    where: { eventId: event.id, removed: false },
    orderBy: { seq: "asc" },
    select: {
      id: true, name: true, lengthM: true, climbM: true,
      lengthSource: true, orderMode: true,
      firstAsStart: true, lastAsFinish: true, startName: true,
      finishControlId: true, structure: true,
      parentCourseId: true, variantKey: true,
      courseControls: {
        orderBy: { position: "asc" },
        select: { controlId: true },
      },
    },
  });

  // A root with live variants is exported as its variants, in the root's
  // place and key order, each with the root's name as its family
  // (course-layer.md §12); a root without any is an ordinary course.
  type CourseRow = (typeof courseRows)[number];
  const variantsOf = new Map<string, CourseRow[]>();
  for (const row of courseRows) {
    if (!row.parentCourseId) continue;
    variantsOf.set(row.parentCourseId, [...(variantsOf.get(row.parentCourseId) ?? []), row]);
  }
  for (const list of variantsOf.values()) list.sort((a, b) => (a.variantKey ?? "").localeCompare(b.variantKey ?? ""));
  const exported: Array<{ row: CourseRow; family?: string }> = [];
  for (const row of courseRows) {
    if (row.parentCourseId) continue;
    const variants = variantsOf.get(row.id) ?? [];
    if (variants.length === 0) exported.push({ row });
    else for (const v of variants) exported.push({ row: v, family: row.name });
  }

  const sequences = await loadCourseSequences(db, event.id, exported.map((e) => e.row.id));

  const courses: ExportCourse[] = [];
  for (const { row: course, family } of exported) {
    const loaded = sequences.get(course.id);
    const entries = loaded?.seq ?? [];
    const orderMode = loaded?.orderMode ?? course.orderMode;
    const ordered = orderMode !== "free_order";

    // The leg lengths `rebuildCourseLengths` stores: the layer's legs,
    // centre to centre through the bends and the crossing point, between
    // consecutive positioned entries (course-layer.md §4.1, §10.1, §10.3).
    const distancesMm = legDistancesMm(editorCourseLayer(course.id, entries, orderMode));
    const legM = (i: number) => (i >= 0 && i < distancesMm.length && mapScale > 0 ? Math.round((distancesMm[i] * mapScale) / 1000) : undefined);

    const seq: ExportCourseControl[] = [];
    let positioned = -1;
    for (const e of entries) {
      const isPositioned = e.xMm !== 0 || e.yMm !== 0;
      if (isPositioned) positioned++;
      const id = idByUuid.get(e.id);
      if (!id) continue;
      const legLengthM = isPositioned ? legM(positioned - 1) : undefined;
      // The crossing point the leg runs through: an unnumbered row before
      // the leg's end row, the instruction on it, no length of its own (the
      // end row carries the whole leg).
      const viaId = ordered && e.via ? idByUuid.get(e.via.id) : undefined;
      if (viaId) {
        seq.push({
          controlId: viaId,
          type: "CrossingPoint",
          specialInstruction: e.leg?.crossing?.section ? "MandatoryOutOfBoundsAreaPassage" : "MandatoryCrossingPoint",
        });
      }
      const cc: ExportCourseControl = { controlId: id, type: e.type };
      if (legLengthM !== undefined) cc.legLengthM = legLengthM;
      // A marked route (707) along the leg: a taped route as long as the leg.
      if (ordered && e.leg?.style === "marked_route" && legLengthM) {
        cc.specialInstruction = "TapedRoute";
        cc.tapedRouteLengthM = legLengthM;
      }
      if (e.leg?.bends?.length) cc.bends = e.leg.bends;
      seq.push(cc);
    }

    // Mark the first row as the start and the last as the finish when the
    // course carries them itself — IOF encodes the role in `@_type`.
    const { firstAsStart, lastAsFinish } = courseSequenceOf(
      course,
      course.courseControls.map((cc) => cc.controlId),
      { site: (id) => rowByUuid.get(id), starts, finishes },
    );
    if (firstAsStart && seq.length > 0) seq[0].type = "Start";
    if (lastAsFinish && seq.length > 0) seq[seq.length - 1].type = "Finish";

    // Imported OCD/XML courses may carry an intentional published length
    // (detours around forbidden terrain, marked routes, extra distance).
    // Preserve that until the course is edited. Edited courses
    // (`length_source = 'derived'`) take the derived length — the stored
    // `length_m` formula, rounded once over the legs' millimetres
    // (course-controls-and-matching.md "Course length").
    const computedLengthM = ordered && distancesMm.length > 0 ? courseLengthM(distancesMm, mapScale) : 0;
    const lengthM =
      course.lengthSource === "derived" && computedLengthM > 0
        ? computedLengthM
        : course.lengthM > 0
          ? course.lengthM
          : computedLengthM;

    courses.push({
      name: course.name,
      ...(family ? { family } : {}),
      lengthM,
      climbM: course.climbM,
      orderMode,
      controls: seq,
    });
  }

  // A class on a root runs each of its variants (the class's pool, §12.4).
  const exportedNamesOf = new Map<string, string[]>();
  for (const row of courseRows) {
    if (row.parentCourseId) continue;
    const variants = variantsOf.get(row.id);
    exportedNamesOf.set(row.id, variants?.length ? variants.map((v) => v.name) : [row.name]);
  }
  for (const row of courseRows) if (row.parentCourseId) exportedNamesOf.set(row.id, [row.name]);
  const classRows = await db.class.findMany({
    where: { eventId: event.id, courseId: { not: null } },
    orderBy: { seq: "asc" },
    select: { name: true, courseId: true },
  });
  const classAssignments = classRows.flatMap((cls) =>
    cls.name === ""
      ? []
      : (exportedNamesOf.get(cls.courseId!) ?? []).map((courseName) => ({ className: cls.name, courseName })),
  );

  return {
    eventName: event.name,
    mapScale,
    controls: sites,
    courses,
    classAssignments,
    mapFileName: mapFile?.fileName,
  };
}

/**
 * Build the CourseData XML for one event.
 *
 * Exported separately from the route so integration tests (and any future
 * tRPC caller) can get the document without going through HTTP.
 */
export async function buildEventCourseDataXml(
  db: Db,
  event: { id: bigint; name: string },
): Promise<string> {
  const data = await gatherEventCourseExport(db, event);
  return buildCourseDataXml(data);
}

/** Build a Purple Pen `.ppen` document for one event. */
export async function buildEventPpenXml(
  db: Db,
  event: { id: bigint; name: string },
): Promise<string> {
  const data = await gatherEventCourseExport(db, event);
  return buildPpenXml(data);
}

/** `<nameId>-courses.xml` / `.ppen`, safe for a Content-Disposition header. */
export function buildCourseExportFilename(
  nameId: string,
  format: CourseExportFormat = "iofxml",
): string {
  const base = nameId.replace(/[^A-Za-z0-9_-]/g, "_");
  return format === "ppen" ? `${base}-courses.ppen` : `${base}-courses.xml`;
}

function parseFormat(raw: string | undefined): CourseExportFormat | null {
  if (raw == null || raw === "" || raw === "iofxml" || raw === "xml") {
    return "iofxml";
  }
  if (raw === "ppen") return "ppen";
  return null;
}

export function registerCourseExportRoute(server: FastifyInstance): void {
  server.get<{ Querystring: { name?: string; format?: string } }>(
    "/api/export/course-data",
    async (req, reply) => {
      const name = (req.query.name ?? "").trim();
      if (!name) {
        return reply.code(400).send({ error: "Missing 'name' query parameter" });
      }
      if (!/^[A-Za-z0-9_-]+$/.test(name)) {
        return reply.code(400).send({ error: "Invalid event name" });
      }
      const format = parseFormat(req.query.format);
      if (!format) {
        return reply.code(400).send({
          error: "Invalid 'format' query parameter (use iofxml or ppen)",
        });
      }
      if (!(await assertRestAccess(req, reply, { nameId: name, cap: "courses.view" }))) {
        return;
      }
      const event = await prisma().event.findUnique({ where: { nameId: name } });
      if (!event || event.removed) {
        return reply.code(404).send({ error: `Event "${name}" not found` });
      }
      const body =
        format === "ppen"
          ? await buildEventPpenXml(prisma(), {
              id: event.id,
              name: event.name,
            })
          : await buildEventCourseDataXml(prisma(), {
              id: event.id,
              name: event.name,
            });
      const contentType =
        format === "ppen"
          ? "application/xml; charset=utf-8"
          : "application/xml; charset=utf-8";
      return reply
        .header("Content-Type", contentType)
        .header(
          "Content-Disposition",
          `attachment; filename="${buildCourseExportFilename(event.nameId, format)}"`,
        )
        .header("Cache-Control", "no-store")
        .send(body);
    },
  );
}
