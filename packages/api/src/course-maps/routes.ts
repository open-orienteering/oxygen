import type { FastifyInstance } from "fastify";
import { courseMapObjectSchema } from "@oxygen/shared";
import { z } from "zod";
import { prisma } from "../db.js";
import { assertRestAccess } from "../restGuard.js";
import { renderGate } from "../map-render-limits.js";
import {
  type PrintGraphic,
  pinnedPrintSource,
  rowForClass,
  sheetForMapRow,
} from "./pdf-page.js";
import { printGate, renderCoursePagesInWorker, resetPrintWorkers } from "./print-worker-host.js";
import { classesByCourse, loadCourseObjects } from "../course-objects.js";

type Db = ReturnType<typeof prisma>;

type MapRow = Awaited<ReturnType<typeof findMapRows>>[number];

const mapObjectsSchema = z.array(courseMapObjectSchema);

function parseSeqs(raw: string | undefined): number[] | null {
  if (!raw) return null;
  const seqs = raw.split(",").map((value) => Number(value.trim()));
  if (seqs.some((value) => !Number.isInteger(value) || value <= 0)) {
    throw new Error("Map and course ids must be positive integers");
  }
  return [...new Set(seqs)];
}

function safeFilename(value: string): string {
  const cleaned = value
    .normalize("NFKD")
    .replace(/[^\w.-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return cleaned || "maps";
}

const mapRowInclude = {
  template: true,
  course: {
    include: {
      classes: { select: { name: true } },
      courseControls: {
        orderBy: { position: "asc" },
        include: { control: true },
      },
    },
  },
} as const;

async function findMapRows(
  db: Db,
  eventId: bigint,
  query: { maps?: string; courses?: string; classes?: string; allControls?: string; setter?: string },
) {
  const mapSeqs = parseSeqs(query.maps);
  const courseSeqs = parseSeqs(query.courses);
  const classSeqs = parseSeqs(query.classes);
  const includeAllControls = query.allControls === "1";
  // Every setter sheet of the event (docs/course-layout.md §7–§8, F10).
  const setter = query.setter === "1";
  if ([mapSeqs, courseSeqs, classSeqs, setter || null].filter(Boolean).length > 1) {
    throw new Error("Use one of maps, courses, classes or setter");
  }
  if (classSeqs) return findClassRows(db, eventId, classSeqs);
  const rows = await db.courseMap.findMany({
    where: {
      eventId,
      ...(mapSeqs ? { seq: { in: mapSeqs } } : {}),
      // A course's own sheets; class sheets print through `classes` or `maps`,
      // setter sheets through `setter` or `maps` (docs/course-layout.md §7).
      ...(courseSeqs ? { course: { seq: { in: courseSeqs } }, classId: null, kind: "course" } : {}),
      ...(setter
        ? { kind: "setter" }
        : !mapSeqs && !courseSeqs && !includeAllControls
          ? { classId: null, kind: { in: ["course", "all_controls"] } }
          : includeAllControls && !mapSeqs && !courseSeqs
            ? { kind: "all_controls" }
            : {}),
    },
    include: mapRowInclude,
    orderBy: [
      { course: { seq: "asc" } },
      { sortOrder: "asc" },
      { seq: "asc" },
    ],
    take: 201,
  });
  if (rows.length > 200) {
    throw new Error("A single export is limited to 200 map pages");
  }
  if (
    mapSeqs &&
    new Set(rows.map((row) => row.seq)).size !== mapSeqs.length
  ) {
    throw new Error("One or more requested maps were not found");
  }
  const requested = mapSeqs?.length ?? courseSeqs?.length;
  if (requested && rows.length === 0) throw new Error("No requested maps found");
  if (setter && rows.length === 0) throw new Error("No setter maps found: generate them in Layout mode (Setter maps)");
  return rows;
}

/**
 * `?classes=` (docs/course-layout.md §7): per class, in the order asked,
 * its class sheets, else its course's own sheets as the class prints them
 * (`rowForClass`: the class's template and scale, the header naming the
 * class).
 */
async function findClassRows(db: Db, eventId: bigint, classSeqs: number[]) {
  const classes = await db.class.findMany({
    where: { eventId, seq: { in: classSeqs }, removed: false },
    include: { sheetTemplate: true },
  });
  if (classes.length !== classSeqs.length) throw new Error("One or more requested classes were not found");
  const bySeq = new Map(classes.map((c) => [c.seq, c]));
  const out = [];
  for (const seq of classSeqs) {
    const cls = bySeq.get(seq)!;
    if (!cls.courseId) continue;
    const own = await db.courseMap.findMany({
      where: { eventId, classId: cls.id },
      include: mapRowInclude,
      orderBy: [{ sortOrder: "asc" }, { seq: "asc" }],
    });
    const rows = own.length
      ? own
      : await db.courseMap.findMany({
          where: { eventId, courseId: cls.courseId, classId: null, kind: "course" },
          include: mapRowInclude,
          orderBy: [{ sortOrder: "asc" }, { seq: "asc" }],
        });
    const print = { name: cls.name, printScale: cls.printScale, sheetTemplate: cls.sheetTemplate };
    out.push(...rows.map((row) => rowForClass(row, print, own.length > 0)));
  }
  if (out.length > 200) throw new Error("A single export is limited to 200 map pages");
  if (out.length === 0) throw new Error("No requested maps found");
  return out;
}

/**
 * Every graphic referenced by the maps being exported (event or club
 * scope), by id. Loaded once per request; unknown ids are simply absent.
 */
async function loadGraphics(
  db: Db,
  eventId: bigint,
  rows: MapRow[],
): Promise<Map<number, PrintGraphic>> {
  const ids = new Set<bigint>();
  for (const row of rows) {
    for (const source of [row.objects, row.template?.objects]) {
      const objects = mapObjectsSchema.safeParse(source ?? []);
      if (!objects.success) continue;
      for (const object of objects.data) {
        if (object.kind === "image") ids.add(BigInt(object.graphicId));
      }
    }
  }
  if (ids.size === 0) return new Map();
  const graphics = await db.graphic.findMany({
    where: {
      id: { in: [...ids] },
      OR: [{ eventId }, { eventId: null }],
    },
    select: { id: true, mime: true, data: true },
  });
  return new Map(
    graphics.map((graphic) => [
      Number(graphic.id),
      { mime: graphic.mime, data: new Uint8Array(graphic.data) },
    ]),
  );
}

export function registerCourseMapRoutes(
  server: FastifyInstance,
  options: {
    /** The composer's page writer (tests inject a failing one). */
    renderCoursePages?: typeof renderCoursePagesInWorker;
  } = {},
): void {
  const renderVectorPages = options.renderCoursePages ?? renderCoursePagesInWorker;
  // The print workers go with the server (docs/course-print.md §8.2). The
  // pool is process-global: one server registers in production; a test's
  // throw-away server resets it and the next print starts a fresh worker.
  server.addHook("onClose", async () => {
    await resetPrintWorkers();
  });
  server.get<{
    Params: { nameId: string };
    Querystring: {
      maps?: string;
      courses?: string;
      classes?: string;
      allControls?: string;
      setter?: string;
    };
  }>("/api/maps/:nameId/maps.pdf", async (req, reply) => {
    const { nameId } = req.params;
    if (!(await assertRestAccess(req, reply, { nameId, cap: "courses.view" }))) {
      return;
    }
    try {
      const db = prisma();
      const event = await db.event.findUnique({ where: { nameId } });
      if (!event || event.removed) {
        return reply.code(404).send({ error: "Event not found" });
      }
      const rows = await findMapRows(db, event.id, req.query);
      if (rows.length === 0) {
        return reply.code(404).send({ error: "No maps found" });
      }
      const allControls = await db.control.findMany({
        where: { eventId: event.id, removed: false },
        select: {
          id: true,
          seq: true,
          codes: true,
          name: true,
          status: true,
          kind: true,
          xpos: true,
          ypos: true,
          description: true,
        },
      });
      const graphics = await loadGraphics(db, event.id, rows);
      // docs/course-print.md §7.1: one page is "<event> · <map>".
      const info = {
        title: rows.length === 1 ? `${event.name} · ${rows[0].name}` : `${event.name} maps`,
        author: event.organizerName || undefined,
      };
      // Every event prints through the composer (docs/course-print.md
      // §8.1). No pin is a 400 "No base map uploaded"; a document whose
      // colour stack is not aligned (`CourseStackError`) is a 400 with the
      // reason, like any other composer error. There is no other path.
      const pinned = await pinnedPrintSource(db, event.id);
      const [courseObjects, byCourse] = await Promise.all([loadCourseObjects(db, event.id), classesByCourse(db, event.id)]);
      const sheets = rows.map((row) =>
        sheetForMapRow(row, {
          event: { name: event.name, date: event.date },
          allControls,
          mapInfo: pinned.info,
          courseObjects,
          classesByCourse: byCourse,
          autoCuts: event.autoOverprintCuts,
        }),
      );
      // A worker slot, then a permit of the render gate, with no queue
      // cap: a 503 would arrive as a broken download (course-print.md
      // §8.2). Composing runs in the print worker, off the event loop.
      const out = await printGate(() => renderGate().run(() =>
        renderVectorPages({
          document: { hash: pinned.hash, bytes: pinned.bytes },
          rotationCorrectionDeg: pinned.rotationCorrectionDeg,
          sheets,
          graphics,
          mode: "cmyk",
          info,
          onPage: (page) => {
            for (const warning of page.warnings) req.log.warn({ nameId }, `maps.pdf: ${warning}`);
          },
        }),
      ));
      const body = Buffer.from(out.bytes);
      const filename =
        rows.length === 1
          ? `${safeFilename(event.nameId)}_${safeFilename(rows[0].name)}.pdf`
          : `${safeFilename(event.nameId)}_maps.pdf`;
      return reply
        .header("Content-Type", "application/pdf")
        .header("Content-Disposition", `attachment; filename="${filename}"`)
        .header("Cache-Control", "no-store")
        .send(body);
    } catch (error) {
      req.log.error(error);
      return reply.code(400).send({
        error: error instanceof Error ? error.message : "Could not render maps",
      });
    }
  });

  server.get<{
    Params: { nameId: string; id: string };
  }>("/api/maps/:nameId/graphics/:id", async (req, reply) => {
    const { nameId } = req.params;
    const event = await assertRestAccess(req, reply, { nameId, cap: "courses.view" });
    if (!event) return;
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return reply.code(400).send({ error: "Invalid graphic id" });
    }
    const db = prisma();
    const graphic = await db.graphic.findFirst({
      where: {
        id: BigInt(id),
        OR: [{ eventId: event.id }, { eventId: null }],
      },
      select: { mime: true, data: true, updatedAt: true },
    });
    if (!graphic) {
      return reply.code(404).send({ error: "Graphic not found" });
    }
    return reply
      .header("Content-Type", graphic.mime)
      .header("Cache-Control", "private, max-age=3600")
      .send(Buffer.from(graphic.data));
  });
}
