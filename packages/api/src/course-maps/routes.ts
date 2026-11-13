import type { FastifyInstance } from "fastify";
import { allVariationsRow, allVariationsSuffix, rowForClass, rowForVariant, sheetForMapRow } from "@oxygen/shared";
import { prisma } from "../db.js";
import type { Prisma } from "../generated/prisma/client.js";
import { assertRestAccess } from "../restGuard.js";
import { renderGate } from "../map-render-limits.js";
import { type PinnedPrintSource, pinnedPrintSource } from "./pdf-page.js";
import { PRINT_JOB_VERSION, type PrintGraphic, type PrintJob, type PrintJobGraphicMime, type PrintSheet } from "@oxygen/shared/print";
import { printGate, rasteriseSvgInWorker, renderCoursePagesInWorker, resetPrintWorkers } from "./print-worker-host.js";
import { parseRasterBox, sheetGraphicIds } from "./graphics.js";
import { classesByCourse, loadCourseObjects } from "../course-objects.js";

type Db = ReturnType<typeof prisma>;

type MapRow = Prisma.CourseMapGetPayload<{ include: typeof mapRowInclude }>;

function parseSeqs(raw: string | undefined): number[] | null {
  if (!raw) return null;
  const seqs = raw.split(",").map((value) => Number(value.trim()));
  if (seqs.some((value) => !Number.isInteger(value) || value <= 0)) {
    throw new Error("Map and course ids must be positive integers");
  }
  return [...new Set(seqs)];
}

/** A page's name for the file and the title: the sheet's, a variant's key or the all-variations keys after it (F8). */
function pageName(row: { name: string; variantKey?: string; allVariations?: { keys: string[] } }): string {
  if (row.allVariations) return `${row.name} ${allVariationsSuffix(row.allVariations.keys)}`;
  return row.variantKey ? `${row.name} ${row.variantKey}` : row.name;
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

/** `maps.pdf`'s selection query (docs/course-layout.md §7; course-print.md §4.6, §8.2). */
export interface PrintQuery {
  maps?: string;
  courses?: string;
  classes?: string;
  allControls?: string;
  setter?: string;
  /** `<root seq>:<key,…>`: those variants of one root (F8). */
  variants?: string;
  /** `<root seq>`: the root's all-variations page (F8; answer 4). */
  allVariations?: string;
  /** `runners`: each page once per runner it is for (F8; course-print.md §4.6). */
  copies?: string;
  /** With `copies=runners`: this many more of each page. */
  spare?: string;
}

/** A selected row and, for a class's print, the class it prints for (`copies=runners` counts that class only). */
type SelectedRow = MapRow & { printClassId?: string };

/** One page to compose: the row as it prints, the course its runners run (`copies`), its class, how many. */
export interface PrintPage {
  row: SelectedRow;
  /** The course a runner on this page runs: the variant's child, else the row's course. */
  runnerCourseId: string | null;
  copies: number;
}

/** Pages a single export composes at most (before copies). */
export const MAX_COMPOSED_PAGES = 200;
/** Pages a single export writes at most, copies included (F8). */
export const MAX_PRINTED_PAGES = 5000;
/** `spare=` at most. */
export const MAX_SPARE = 500;

function parseVariants(raw: string): { rootSeq: number; keys: string[] } {
  const m = /^(\d+):(.+)$/.exec(raw.trim());
  const keys = m ? [...new Set(m[2].split(",").map((k) => k.trim()).filter(Boolean))] : [];
  if (!m || Number(m[1]) <= 0 || keys.length === 0) throw new Error("variants must be <course>:<key,…>");
  return { rootSeq: Number(m[1]), keys };
}

function parseSpare(raw: string | undefined): number {
  if (raw === undefined) return 0;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > MAX_SPARE) throw new Error(`spare must be an integer 0–${MAX_SPARE}`);
  return n;
}

/** A root with live variants, by seq; throws for a course that is none. */
async function rootBySeq(db: Db, eventId: bigint, seq: number) {
  const root = await db.course.findFirst({
    where: { eventId, seq, removed: false },
    select: { id: true, parentCourseId: true, variants: { where: { removed: false }, select: { variantKey: true } } },
  });
  if (!root) throw new Error("Course not found");
  if (root.parentCourseId || root.variants.length === 0) throw new Error("The course has no variations");
  return root;
}

/**
 * The rows `maps.pdf` prints, then each root's sheet as its variants
 * (course-print.md §4.6, F8): a `kind = 'course'` row of a root with live
 * children prints once per variant — in key order, `rowForVariant` — or,
 * for `allVariations`, once as the all-variations page; `?courses=` of a
 * variant prints that key on its root's sheets. `copies=runners` sizes
 * each page by the runners it is for (+ `spare`). A root has no page of its
 * own: print is always one variant (08 §5.3).
 */
export async function selectPrintPages(db: Db, eventId: bigint, query: PrintQuery): Promise<PrintPage[]> {
  const mapSeqs = parseSeqs(query.maps);
  let courseSeqs = parseSeqs(query.courses);
  const classSeqs = parseSeqs(query.classes);
  const variants = query.variants ? parseVariants(query.variants) : null;
  const allVariationsSeqs = parseSeqs(query.allVariations);
  const setter = query.setter === "1";
  if ([mapSeqs, courseSeqs, classSeqs, setter || null, variants, allVariationsSeqs].filter(Boolean).length > 1) {
    throw new Error("Use one of maps, courses, classes, setter, variants or allVariations");
  }
  if (allVariationsSeqs && allVariationsSeqs.length > 1) throw new Error("allVariations takes one course");
  if (query.copies !== undefined && query.copies !== "runners") throw new Error("copies must be runners");
  const copies = query.copies === "runners";
  if (query.spare !== undefined && !copies) throw new Error("spare needs copies=runners");
  if (copies && !courseSeqs && !classSeqs && !variants) throw new Error("copies=runners needs courses, classes or variants");
  const spare = parseSpare(query.spare);

  // The variants each root prints (absent = every one); a variant asked for by its seq prints on its root's sheets.
  const keysOf = new Map<string, Set<string>>();
  let allVariationsRoot: string | null = null;
  if (courseSeqs) {
    const picked = await db.course.findMany({
      where: { eventId, seq: { in: courseSeqs }, removed: false },
      select: { id: true, seq: true, parentCourseId: true, variantKey: true, parent: { select: { seq: true } } },
    });
    const whole = new Set(picked.filter((c) => !c.parentCourseId).map((c) => c.id));
    for (const c of picked) {
      if (!c.parentCourseId || whole.has(c.parentCourseId)) continue;
      const keys = keysOf.get(c.parentCourseId) ?? new Set<string>();
      keys.add(c.variantKey ?? "");
      keysOf.set(c.parentCourseId, keys);
    }
    // None found keeps the seqs asked: the request's "not found" below.
    if (picked.length > 0) courseSeqs = [...new Set(picked.map((c) => c.parent?.seq ?? c.seq))];
  }
  if (variants) {
    const root = await rootBySeq(db, eventId, variants.rootSeq);
    const live = new Set(root.variants.map((c) => c.variantKey ?? ""));
    const unknown = variants.keys.filter((k) => !live.has(k));
    if (unknown.length > 0) throw new Error(`Unknown variant: ${unknown.join(", ")}`);
    keysOf.set(root.id, new Set(variants.keys));
    courseSeqs = [variants.rootSeq];
  }
  if (allVariationsSeqs) {
    allVariationsRoot = (await rootBySeq(db, eventId, allVariationsSeqs[0])).id;
    courseSeqs = allVariationsSeqs;
  }

  const rows: SelectedRow[] = classSeqs
    ? await findClassRows(db, eventId, classSeqs)
    : await findMapRows(db, eventId, { mapSeqs, courseSeqs, setter, allControls: query.allControls === "1" });

  // Each root's live variants, in key order (`course.variantList`'s order), with what a page reads.
  const rootIds = [...new Set(rows.filter((r) => r.kind === "course" && r.course).map((r) => r.course!.id))];
  const children = rootIds.length
    ? await db.course.findMany({
        where: { parentCourseId: { in: rootIds }, removed: false },
        include: mapRowInclude.course.include,
        orderBy: { variantKey: "asc" },
      })
    : [];
  const childrenOf = new Map<string, typeof children>();
  for (const c of children) childrenOf.set(c.parentCourseId!, [...(childrenOf.get(c.parentCourseId!) ?? []), c]);

  const pages: PrintPage[] = [];
  for (const row of rows) {
    const kids = row.kind === "course" && row.course ? childrenOf.get(row.course.id) ?? [] : [];
    if (kids.length === 0) {
      pages.push({ row, runnerCourseId: row.course?.id ?? null, copies: 1 });
      continue;
    }
    if (allVariationsRoot === row.course!.id) {
      pages.push({ row: allVariationsRow(row, kids.map((k) => k.variantKey ?? "")), runnerCourseId: null, copies: 1 });
      continue;
    }
    const keys = keysOf.get(row.course!.id);
    for (const kid of kids) {
      if (keys && !keys.has(kid.variantKey ?? "")) continue;
      pages.push({ row: rowForVariant(row, kid), runnerCourseId: kid.id, copies: 1 });
    }
  }
  if (pages.length > MAX_COMPOSED_PAGES) throw new Error(`A single export is limited to ${MAX_COMPOSED_PAGES} map pages`);
  if (pages.length === 0) throw new Error("No requested maps found");
  if (!copies) return pages;

  // copies=runners: a runner runs her own variant (`runner.course_id`, F6b), else her class's course.
  const [groups, classes] = await Promise.all([
    db.runner.groupBy({ by: ["courseId", "classId"], where: { eventId, removed: false }, _count: { _all: true } }),
    db.class.findMany({ where: { eventId, removed: false }, select: { id: true, courseId: true } }),
  ]);
  const classCourse = new Map(classes.map((c) => [c.id, c.courseId]));
  const runnersOf = (courseId: string | null, classId: string | undefined) =>
    groups
      .filter((g) => (g.courseId ?? (g.classId ? classCourse.get(g.classId) : null)) === courseId && (!classId || g.classId === classId))
      .reduce((n, g) => n + g._count._all, 0);
  const sized = pages.map((p) => ({ ...p, copies: p.runnerCourseId ? runnersOf(p.runnerCourseId, p.row.printClassId) + spare : spare }));
  const total = sized.reduce((n, p) => n + p.copies, 0);
  if (total === 0) throw new Error("No runners to print maps for (add spare=n for blank stacks)");
  if (total > MAX_PRINTED_PAGES) throw new Error(`A single export is limited to ${MAX_PRINTED_PAGES} pages, copies included`);
  return sized;
}

async function findMapRows(
  db: Db,
  eventId: bigint,
  q: { mapSeqs: number[] | null; courseSeqs: number[] | null; setter: boolean; allControls: boolean },
) {
  const { mapSeqs, courseSeqs, setter } = q;
  const includeAllControls = q.allControls;
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
          ? {
              classId: null,
              kind: { in: ["course", "all_controls"] },
              // A variant prints on its root's sheets (F8): a sheet a variant got of its own before F8 is not printed twice.
              NOT: { course: { is: { parentCourseId: { not: null } } } },
            }
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
    take: MAX_COMPOSED_PAGES + 1,
  });
  if (rows.length > MAX_COMPOSED_PAGES) {
    throw new Error(`A single export is limited to ${MAX_COMPOSED_PAGES} map pages`);
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
 * class). A class on a root then prints per variant (`selectPrintPages`).
 */
async function findClassRows(db: Db, eventId: bigint, classSeqs: number[]): Promise<SelectedRow[]> {
  const classes = await db.class.findMany({
    where: { eventId, seq: { in: classSeqs }, removed: false },
    include: { sheetTemplate: true },
  });
  if (classes.length !== classSeqs.length) throw new Error("One or more requested classes were not found");
  const bySeq = new Map(classes.map((c) => [c.seq, c]));
  const out: SelectedRow[] = [];
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
    out.push(...rows.map((row) => ({ ...rowForClass(row, print, own.length > 0), printClassId: cls.id })));
  }
  if (out.length > MAX_COMPOSED_PAGES) throw new Error(`A single export is limited to ${MAX_COMPOSED_PAGES} map pages`);
  if (out.length === 0) throw new Error("No requested maps found");
  return out;
}

/**
 * The graphics by id that exist for the event (event or club scope);
 * unknown ids are simply absent. Without `withData` the bytes are not read
 * (`print-job` answers id and mime only) and `data` is empty.
 */
async function loadGraphics(db: Db, eventId: bigint, ids: number[], withData: boolean): Promise<Map<number, PrintGraphic>> {
  if (ids.length === 0) return new Map();
  const graphics = await db.graphic.findMany({
    where: {
      id: { in: ids.map((id) => BigInt(id)) },
      OR: [{ eventId }, { eventId: null }],
    },
    select: { id: true, mime: true, ...(withData ? { data: true } : {}) },
    orderBy: { id: "asc" },
  });
  return new Map(
    graphics.map((graphic) => [
      Number(graphic.id),
      { mime: graphic.mime, data: "data" in graphic && graphic.data ? new Uint8Array(graphic.data) : new Uint8Array(0) },
    ]),
  );
}

/** What `maps.pdf` composes and `print-job` answers (docs/course-print.md §8.5): the job, the graphics' bytes and the pinned source. */
export interface BuiltPrintJob {
  job: PrintJob;
  /** The job's graphics with their bytes (empty with `graphicBytes: false`). */
  graphics: Map<number, PrintGraphic>;
  source: PinnedPrintSource;
}

/**
 * The print job for `maps.pdf`'s query (docs/course-print.md §8.2 steps
 * 1–2, §8.5): the selected pages as sheets in print order with their
 * copies, the pinned document by hash, the graphics the sheets reference,
 * `info` and the download name. Both routes build through this, so one
 * selection, order and set of caps holds for both. Throws (a 400) for a
 * bad selection, a cap, or no pin.
 */
export async function buildPrintJob(
  db: Db,
  event: { id: bigint; nameId: string; name: string; date: Date; organizerName: string | null; autoOverprintCuts: boolean },
  query: PrintQuery,
  options: { graphicBytes?: boolean } = {},
): Promise<BuiltPrintJob> {
  const pages = await selectPrintPages(db, event.id, query);
  const rows = pages.map((p) => p.row);
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
  // Every event prints through the composer (docs/course-print.md §8.1).
  // No pin is a 400 "No base map uploaded"; a document whose colour stack
  // is not aligned (`CourseStackError`) surfaces when the job is composed.
  const source = await pinnedPrintSource(db, event.id);
  const [courseObjects, byCourse] = await Promise.all([loadCourseObjects(db, event.id), classesByCourse(db, event.id)]);
  const sheets: PrintSheet[] = pages.map(({ row, copies }) => ({
    ...sheetForMapRow(row, {
      event: { name: event.name, date: event.date },
      allControls,
      mapInfo: source.info,
      courseObjects,
      classesByCourse: byCourse,
      autoCuts: event.autoOverprintCuts,
    }),
    ...(copies !== 1 ? { copies } : {}),
  }));
  const graphics = await loadGraphics(db, event.id, sheetGraphicIds(sheets), options.graphicBytes ?? true);
  // docs/course-print.md §7.1: one page is "<event> · <map>".
  const info = {
    title: rows.length === 1 ? `${event.name} · ${pageName(rows[0])}` : `${event.name} maps`,
    ...(event.organizerName ? { author: event.organizerName } : {}),
  };
  const filename =
    rows.length === 1
      ? `${safeFilename(event.nameId)}_${safeFilename(pageName(rows[0]))}.pdf`
      : `${safeFilename(event.nameId)}_maps.pdf`;
  const job: PrintJob = {
    version: PRINT_JOB_VERSION,
    document: { hash: source.hash, rotationCorrectionDeg: source.rotationCorrectionDeg },
    sheets,
    graphics: [...graphics].map(([id, g]) => ({ id, mime: g.mime as PrintJobGraphicMime })),
    mode: "cmyk",
    info,
    filename,
  };
  return { job, graphics, source };
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
    Querystring: PrintQuery;
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
      const { job, graphics, source } = await buildPrintJob(db, event, req.query);
      // A worker slot, then a permit of the render gate, with no queue
      // cap: a 503 would arrive as a broken download (course-print.md
      // §8.2). Composing runs in the print worker, off the event loop.
      const out = await printGate(() => renderGate().run(() =>
        renderVectorPages({
          document: { hash: job.document.hash, bytes: source.bytes },
          rotationCorrectionDeg: job.document.rotationCorrectionDeg,
          sheets: job.sheets,
          graphics,
          mode: job.mode,
          info: job.info,
          onPage: (page) => {
            for (const warning of page.warnings) req.log.warn({ nameId }, `maps.pdf: ${warning}`);
          },
        }),
      ));
      const body = Buffer.from(out.bytes);
      const filename = job.filename;
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

  // The print job (docs/course-print.md §8.5, G15): what maps.pdf composes,
  // as JSON, for a host that composes it itself (the browser, slice G
  // answer 3). Same query, selection, order, caps and 400s as maps.pdf.
  server.get<{
    Params: { nameId: string };
    Querystring: PrintQuery;
  }>("/api/maps/:nameId/print-job", async (req, reply) => {
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
      const { job } = await buildPrintJob(db, event, req.query, { graphicBytes: false });
      return reply.header("Cache-Control", "no-store").send(job);
    } catch (error) {
      req.log.error(error);
      return reply.code(400).send({
        error: error instanceof Error ? error.message : "Could not build the print job",
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

  // A graphic as the PNG a print embeds (docs/course-print.md §8.5): an
  // SVG rasterised by resvg at w × h in a print worker, a PNG as stored.
  // The browser never rasterises SVG (slice G).
  server.get<{
    Params: { nameId: string; id: string };
    Querystring: { w?: string; h?: string };
  }>("/api/maps/:nameId/graphics/:id/print.png", async (req, reply) => {
    const { nameId } = req.params;
    const event = await assertRestAccess(req, reply, { nameId, cap: "courses.view" });
    if (!event) return;
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return reply.code(400).send({ error: "Invalid graphic id" });
    }
    const graphic = await prisma().graphic.findFirst({
      where: { id: BigInt(id), OR: [{ eventId: event.id }, { eventId: null }] },
      select: { mime: true, data: true },
    });
    if (!graphic) {
      return reply.code(404).send({ error: "Graphic not found" });
    }
    let png: Uint8Array;
    if (graphic.mime === "image/svg+xml") {
      const box = parseRasterBox(req.query.w, req.query.h);
      if (typeof box === "string") return reply.code(400).send({ error: box });
      try {
        png = await printGate(() => rasteriseSvgInWorker(new Uint8Array(graphic.data), box[0], box[1]));
      } catch (error) {
        req.log.error(error);
        return reply.code(400).send({ error: error instanceof Error ? error.message : "Could not rasterise the graphic" });
      }
    } else {
      png = new Uint8Array(graphic.data);
    }
    return reply
      .header("Content-Type", "image/png")
      .header("Cache-Control", "private, max-age=3600")
      .send(Buffer.from(png));
  });
}
