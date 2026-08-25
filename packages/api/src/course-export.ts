/**
 * Course export endpoint (IOF 3.0 CourseData XML).
 *
 * `GET /api/export/course-data?name=<nameId>` returns every course of the
 * event as an attachment. The intended use is round-tripping to Condes /
 * Purple Pen / OCAD for printing, and re-importing into another Oxygen
 * event.
 *
 * The document layout lives in `iof-course-export.ts` (pure); this module
 * only maps DB rows onto it. Sequence construction mirrors
 * `rebuildCourseGeometry` in `course-geometry.ts`: `course_controls` holds
 * regular controls only, the start is the event start control matched by
 * `startName` (unless `firstAsStart`) and the finish is `finishControlId`
 * or the event's first finish control (unless `lastAsFinish`).
 */

import type { FastifyInstance } from "fastify";
import { prisma } from "./db.js";
import { loadEventCrs } from "./event-crs.js";
import { mapMmToWgs84 } from "./map-projection.js";
import {
  buildCourseDataXml,
  type ExportControlSite,
  type ExportCourse,
  type ExportCourseControl,
} from "./iof-course-export.js";
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
  const crs = await loadEventCrs(db, event.id);
  const mapScale = crs?.scale ?? 15000;

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

  return buildCourseDataXml({
    eventName: event.name,
    mapScale,
    controls: sites,
    courses,
    classAssignments,
  });
}

/** `<nameId>-courses.xml`, safe for a Content-Disposition header. */
export function buildCourseExportFilename(nameId: string): string {
  return `${nameId.replace(/[^A-Za-z0-9_-]/g, "_")}-courses.xml`;
}

export function registerCourseExportRoute(server: FastifyInstance): void {
  server.get<{ Querystring: { name?: string } }>(
    "/api/export/course-data",
    async (req, reply) => {
      const name = (req.query.name ?? "").trim();
      if (!name) {
        return reply.code(400).send({ error: "Missing 'name' query parameter" });
      }
      if (!/^[A-Za-z0-9_-]+$/.test(name)) {
        return reply.code(400).send({ error: "Invalid event name" });
      }
      const event = await prisma().event.findUnique({ where: { nameId: name } });
      if (!event || event.removed) {
        return reply.code(404).send({ error: `Event "${name}" not found` });
      }
      const xml = await buildEventCourseDataXml(prisma(), {
        id: event.id,
        name: event.name,
      });
      return reply
        .header("Content-Type", "application/xml; charset=utf-8")
        .header(
          "Content-Disposition",
          `attachment; filename="${buildCourseExportFilename(event.nameId)}"`,
        )
        .header("Cache-Control", "no-store")
        .send(xml);
    },
  );
}
