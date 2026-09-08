/**
 * Course export endpoints (IOF 3.0 CourseData XML and Purple Pen `.ppen`).
 *
 * `GET /api/export/course-data?name=<nameId>&format=iofxml|ppen` returns
 * every course of the event as an attachment. Default format is `iofxml`
 * (for Condes / Purple Pen / OCAD via the interchange format). `ppen`
 * writes native CourseScribe XML that Purple Pen opens directly.
 *
 * Document layout lives in `iof-course-export.ts` / `ppen-course-export.ts`
 * (pure); this module maps DB rows onto them. Sequence construction
 * mirrors `rebuildCourseGeometry` in `course-geometry.ts`:
 * `course_controls` holds regular controls only, the start is the event
 * start control matched by `startName` (unless `firstAsStart`) and the
 * finish is `finishControlId` or the event's first finish control
 * (unless `lastAsFinish`).
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
import type { PrismaClient, Prisma } from "./generated/prisma/client.js";

type Db = PrismaClient | Prisma.TransactionClient;

/** First punch code, falling back to name then seq — the display code. */
function displayCode(c: { codes: string; name: string; seq: number }): string {
  const first = c.codes.split(";")[0]?.trim();
  return first || c.name || String(c.seq);
}

/** Per-leg terrain meters from the stored `legs` string ("1200;900;"). */
function parseLegs(legs: string): number[] {
  return legs
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => Number(s))
    .filter((n) => Number.isFinite(n));
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
  const mapScale = crs?.scale ?? 15000;

  const mapFile = await db.mapFile.findFirst({
    where: { eventId: event.id },
    orderBy: { uploadedAt: "desc" },
    select: { fileName: true },
  });

  const controls = await db.control.findMany({
    where: { eventId: event.id, removed: false },
    orderBy: { seq: "asc" },
    select: {
      id: true, seq: true, name: true, codes: true, status: true,
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
      type:
        c.status === "start" ? "Start" : c.status === "finish" ? "Finish" : "Control",
      xMm: c.xpos,
      yMm: c.ypos,
      lat,
      lng,
    });
  }

  const starts = controls.filter((c) => c.status === "start");
  const finishes = controls.filter((c) => c.status === "finish");
  const placedSiteById = new Map<string, ExportControlSite>();
  for (const site of sites) {
    if (
      (site.xMm !== 0 || site.yMm !== 0) &&
      !placedSiteById.has(site.id)
    ) {
      // buildCourseDataXml also resolves duplicate public ids first-wins.
      placedSiteById.set(site.id, site);
    }
  }

  const courseRows = await db.course.findMany({
    where: { eventId: event.id, removed: false },
    orderBy: { seq: "asc" },
    select: {
      id: true, name: true, lengthM: true, climbM: true, legs: true,
      geometrySource: true,
      firstAsStart: true, lastAsFinish: true, startName: true,
      finishControlId: true,
      courseControls: {
        orderBy: { position: "asc" },
        select: { controlId: true },
      },
    },
  });

  const courses: ExportCourse[] = [];
  for (const course of courseRows) {
    const seq: ExportCourseControl[] = [];

    if (!course.firstAsStart) {
      const start =
        (course.startName
          ? starts.find((s) => s.name === course.startName)
          : undefined) ?? starts[0];
      if (start) {
        seq.push({ controlId: displayCode(start), type: "Start" });
      }
    }

    for (const cc of course.courseControls) {
      const id = idByUuid.get(cc.controlId);
      if (!id) continue;
      const row = rowByUuid.get(cc.controlId)!;
      seq.push({
        controlId: id,
        type:
          row.status === "start" ? "Start"
            : row.status === "finish" ? "Finish"
              : "Control",
      });
    }

    if (!course.lastAsFinish) {
      const finish =
        (course.finishControlId
          ? finishes.find((f) => f.id === course.finishControlId)
          : undefined) ?? finishes[0];
      if (finish) {
        seq.push({ controlId: displayCode(finish), type: "Finish" });
      }
    }

    // Mark the first row as the start and the last as the finish when the
    // course carries them itself — IOF encodes the role in `@_type`.
    if (course.firstAsStart && seq.length > 0) seq[0].type = "Start";
    if (course.lastAsFinish && seq.length > 0) seq[seq.length - 1].type = "Finish";

    // `legs` is one entry per leg of the *positioned* sequence, so it only
    // lines up when nothing was dropped. Attach it when the count matches.
    const legs = parseLegs(course.legs);
    if (legs.length === seq.length - 1) {
      for (let i = 1; i < seq.length; i++) seq[i].legLengthM = legs[i - 1];
    }

    // Derive every exported leg from the current control coordinates and
    // current OCAD scale. This makes export resilient to stale `legs` rows
    // written by older imports. Unplaced controls are skipped exactly as
    // buildCourseDataXml skips them.
    let previous: ExportControlSite | null = null;
    let computedLengthM = 0;
    for (const cc of seq) {
      const site = placedSiteById.get(cc.controlId);
      if (!site) continue;
      if (previous && mapScale > 0) {
        const dx = site.xMm - previous.xMm;
        const dy = site.yMm - previous.yMm;
        const legLengthM =
          Math.round((Math.sqrt(dx * dx + dy * dy) * mapScale) / 1000);
        cc.legLengthM = legLengthM;
        computedLengthM += legLengthM;
      }
      previous = site;
    }

    // Imported OCD/XML courses may carry an intentional published length
    // (detours around forbidden terrain, marked routes, extra distance).
    // Preserve that until the course is edited. Editor-owned courses are
    // geometry-derived and are recomputed defensively at export time too.
    const lengthM =
      course.geometrySource === "editor" && computedLengthM > 0
        ? computedLengthM
        : course.lengthM > 0
          ? course.lengthM
          : computedLengthM;

    courses.push({
      name: course.name,
      lengthM,
      climbM: course.climbM,
      controls: seq,
    });
  }

  const courseNameByUuid = new Map(courseRows.map((c) => [c.id, c.name]));
  const classRows = await db.class.findMany({
    where: { eventId: event.id, courseId: { not: null } },
    orderBy: { seq: "asc" },
    select: { name: true, courseId: true },
  });
  const classAssignments = classRows
    .map((cls) => ({
      className: cls.name,
      courseName: courseNameByUuid.get(cls.courseId!) ?? "",
    }))
    .filter((a) => a.className !== "" && a.courseName !== "");

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
