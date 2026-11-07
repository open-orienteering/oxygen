/**
 * Description sheets as a PDF (docs/course-print.md §6.4; research 08
 * §4.6 "Control-description sheets"):
 *
 *   GET /api/maps/:nameId/descriptions.pdf
 *     ?classes=<seq,…> | courses=<seq,…>   (neither: every class with a course)
 *     &copies=count|fill|<n>               (default count)
 *     &cell=5|6|7                          (default 6)
 *     &gap=<mm>                            (default 5)
 *
 * Per class (or course) the map page's description block — rows and
 * header from `resolveMapLayout`, the function every sheet resolves
 * through — tiled on A4 portrait by `tileDescriptionSheets`
 * (`@oxygen/shared/print`). Printed on demand: no `course_maps` row (the
 * slice F split's decision), no base map needed, and no print worker —
 * there is no document to decode, so the pages are written in process.
 */

import type { FastifyInstance } from "fastify";
import { WITHDRAWN_STATUSES, defaultTemplateSettings, getPaperDimensions } from "@oxygen/shared";
import {
  type ColourMode,
  type DescriptionCopies,
  type DescriptionSheetBlock,
  DESCRIPTION_SHEET_CELLS,
  DESCRIPTION_SHEET_DEFAULT_GAP_MM,
  DescriptionTooTallError,
  PdfWriter,
  composeDescriptionPage,
  countDescriptionPages,
  tileDescriptionSheets,
  writeDescriptionPage,
} from "@oxygen/shared/print";
import type { Prisma, PrismaClient } from "../generated/prisma/client.js";
import { prisma } from "../db.js";
import { assertRestAccess } from "../restGuard.js";
import { bundledPdfFaces, loadBundledFonts } from "../render/fonts.js";
import { valueToRunnerStatus } from "../statusConvert.js";
import { getBaseMapInfoOrNull } from "./map-source.js";
import { type LayoutControlSource, type LayoutTemplateSource, layoutControlsFromCourseControls, layoutCourseEnds, resolveMapLayout } from "./resolve-layout.js";

type Db = PrismaClient | Prisma.TransactionClient;

/** The `maps.pdf` cap (docs/course-print.md §8.3). */
export const DESCRIPTIONS_MAX_PAGES = 200;
/** Most copies one `copies=<n>` asks for. */
export const DESCRIPTIONS_MAX_COPIES = 500;
/** Largest gap between blocks, mm. */
export const DESCRIPTIONS_MAX_GAP_MM = 30;

/** A request the route answers with 400 and this message. */
export class DescriptionsRequestError extends Error {}

export interface DescriptionsQuery {
  classes?: string;
  courses?: string;
  copies?: string;
  cell?: string;
  gap?: string;
}

export interface DescriptionsRequest {
  classSeqs: number[] | null;
  courseSeqs: number[] | null;
  copies: DescriptionCopies;
  cellSizeMm: number;
  gapMm: number;
}

function parseSeqs(raw: string | undefined, what: string): number[] | null {
  if (raw === undefined || raw === "") return null;
  const seqs = raw.split(",").map((v) => Number(v.trim()));
  if (seqs.some((v) => !Number.isInteger(v) || v <= 0)) throw new DescriptionsRequestError(`${what} ids must be positive integers`);
  return [...new Set(seqs)];
}

/** The query's options, validated; throws `DescriptionsRequestError`. */
export function parseDescriptionsQuery(q: DescriptionsQuery): DescriptionsRequest {
  const classSeqs = parseSeqs(q.classes, "Class");
  const courseSeqs = parseSeqs(q.courses, "Course");
  if (classSeqs && courseSeqs) throw new DescriptionsRequestError("Use one of classes or courses");
  let copies: DescriptionCopies = "count";
  if (q.copies !== undefined && q.copies !== "") {
    if (q.copies === "count" || q.copies === "fill") copies = q.copies;
    else {
      const n = Number(q.copies);
      if (!/^\d+$/.test(q.copies) || n < 1 || n > DESCRIPTIONS_MAX_COPIES) {
        throw new DescriptionsRequestError(`copies must be count, fill or a number from 1 to ${DESCRIPTIONS_MAX_COPIES}`);
      }
      copies = n;
    }
  }
  let cellSizeMm = 6;
  if (q.cell !== undefined && q.cell !== "") {
    cellSizeMm = Number(q.cell);
    if (!(DESCRIPTION_SHEET_CELLS as readonly number[]).includes(cellSizeMm)) throw new DescriptionsRequestError(`cell must be one of ${DESCRIPTION_SHEET_CELLS.join(", ")} (mm)`);
  }
  let gapMm = DESCRIPTION_SHEET_DEFAULT_GAP_MM;
  if (q.gap !== undefined && q.gap !== "") {
    gapMm = Number(q.gap);
    if (!Number.isFinite(gapMm) || gapMm < 0 || gapMm > DESCRIPTIONS_MAX_GAP_MM) throw new DescriptionsRequestError(`gap must be a number of millimetres from 0 to ${DESCRIPTIONS_MAX_GAP_MM}`);
  }
  return { classSeqs, courseSeqs, copies, cellSizeMm, gapMm };
}

/** Rows and header only depend on the course; the template is a stand-in A4 (the block's geometry is the request's). */
const A4_TEMPLATE: LayoutTemplateSource = {
  paper: "A4",
  orientation: "portrait",
  paperWidthMm: null,
  paperHeightMm: null,
  printScale: 10000,
  settings: defaultTemplateSettings(getPaperDimensions("A4", "portrait")),
  objects: [],
};

const courseInclude = {
  courseControls: { orderBy: { position: "asc" }, include: { control: true } },
} as const;
type CourseRow = Prisma.CourseGetPayload<{ include: typeof courseInclude }>;

/**
 * The blocks a request prints, in the order it prints them: per class (in
 * the order asked; none asked = every class with a course, in class
 * order) or per course; a class without a course is skipped. `count` =
 * the class's runners (not removed, not withdrawn — `class.list`'s
 * count) + its vacancies; a course's = the sum over its classes.
 */
export async function selectDescriptionBlocks(db: Db, event: { id: bigint; name: string; date: Date }, req: DescriptionsRequest): Promise<DescriptionSheetBlock[]> {
  const eventId = event.id;
  const [classes, runners, mapInfo, allControls] = await Promise.all([
    db.class.findMany({ where: { eventId, removed: false }, orderBy: [{ sortIndex: "asc" }, { seq: "asc" }] }),
    db.runner.findMany({ where: { eventId, removed: false, status: { notIn: WITHDRAWN_STATUSES.map(valueToRunnerStatus) } }, select: { classId: true } }),
    getBaseMapInfoOrNull(db, eventId),
    db.control.findMany({ where: { eventId, removed: false } }),
  ]);
  const runnersIn = new Map<string, number>();
  for (const r of runners) if (r.classId) runnersIn.set(r.classId, (runnersIn.get(r.classId) ?? 0) + 1);
  const countOf = (c: (typeof classes)[number]) => (runnersIn.get(c.id) ?? 0) + c.vacantCount;

  const block = (course: CourseRow, label: string, classNames: string[], count: number): DescriptionSheetBlock => {
    const ends = layoutCourseEnds(
      { ...course, structure: course.structure ?? null },
      course.courseControls.map((cc) => cc.control.id),
      allControls as Array<LayoutControlSource & { name: string; kind: string }>,
    );
    const layout = resolveMapLayout({
      kind: "course",
      template: A4_TEMPLATE,
      course: {
        name: course.name,
        lengthM: course.lengthM,
        climbM: course.climbM,
        orderMode: course.orderMode,
        start: ends.start,
        finish: ends.finish,
        classes: classNames.map((name) => ({ name })),
        controls: layoutControlsFromCourseControls(course.courseControls),
        descriptionInstructions: course.descriptionInstructions,
      },
      mapScale: mapInfo?.scale ?? null,
      event: { name: event.name, date: event.date },
    });
    return { label, rows: layout.descriptionRows, header: layout.descriptionHeader, title: course.name, count };
  };

  if (req.courseSeqs) {
    const courses = await db.course.findMany({ where: { eventId, removed: false, seq: { in: req.courseSeqs } }, include: courseInclude });
    if (courses.length !== req.courseSeqs.length) throw new DescriptionsRequestError("One or more requested courses were not found");
    const bySeq = new Map(courses.map((c) => [c.seq, c]));
    return req.courseSeqs.map((seq) => {
      const course = bySeq.get(seq)!;
      const own = classes.filter((c) => c.courseId === course.id);
      return block(course, course.name, own.map((c) => c.name), own.reduce((n, c) => n + countOf(c), 0));
    });
  }

  let selected = classes;
  if (req.classSeqs) {
    const bySeq = new Map(classes.map((c) => [c.seq, c]));
    if (req.classSeqs.some((seq) => !bySeq.has(seq))) throw new DescriptionsRequestError("One or more requested classes were not found");
    selected = req.classSeqs.map((seq) => bySeq.get(seq)!);
  }
  selected = selected.filter((c) => c.courseId);
  if (selected.length === 0) return [];
  const courseIds = [...new Set(selected.map((c) => c.courseId!))];
  const courses = new Map(
    (await db.course.findMany({ where: { id: { in: courseIds }, removed: false }, include: courseInclude })).map((c) => [c.id, c]),
  );
  return selected.filter((c) => courses.has(c.courseId!)).map((c) => block(courses.get(c.courseId!)!, c.name, [c.name], countOf(c)));
}

export interface DescriptionsPdfOptions {
  blocks: DescriptionSheetBlock[];
  request: Pick<DescriptionsRequest, "copies" | "cellSizeMm" | "gapMm">;
  mode?: ColourMode;
  deterministic?: boolean;
  info?: { title?: string; author?: string };
}

/**
 * The document: every tiled page through one writer (pictogram forms and
 * font subsets shared). Throws `DescriptionTooTallError` and, past
 * `DESCRIPTIONS_MAX_PAGES`, a `DescriptionsRequestError` before any page is drawn.
 */
export async function buildDescriptionsPdf(opts: DescriptionsPdfOptions): Promise<{ bytes: Uint8Array; pageCount: number; warnings: string[] }> {
  const options = { cellSizeMm: opts.request.cellSizeMm, gapMm: opts.request.gapMm, copies: opts.request.copies };
  const pageCount = countDescriptionPages(opts.blocks, options);
  if (pageCount > DESCRIPTIONS_MAX_PAGES) throw new DescriptionsRequestError(`A single export is limited to ${DESCRIPTIONS_MAX_PAGES} pages (this one would have ${pageCount})`);
  const fonts = await loadBundledFonts();
  const writer = await PdfWriter.create({ faces: await bundledPdfFaces(), deterministic: opts.deterministic, info: opts.info });
  const warnings = [...writer.warnings];
  for (const page of tileDescriptionSheets(opts.blocks, options)) {
    const composed = composeDescriptionPage(page, fonts);
    for (const w of composed.warnings) warnings.push(`${page.label}: ${w.code}: ${w.message}`);
    writeDescriptionPage(writer, composed, { mode: opts.mode ?? "cmyk" });
  }
  return { bytes: await writer.save(), pageCount, warnings };
}

function safeFilename(value: string): string {
  const cleaned = value
    .normalize("NFKD")
    .replace(/[^\w.-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return cleaned || "event";
}

export function registerDescriptionsPdfRoute(server: FastifyInstance): void {
  server.get<{ Params: { nameId: string }; Querystring: DescriptionsQuery }>("/api/maps/:nameId/descriptions.pdf", async (req, reply) => {
    const { nameId } = req.params;
    if (!(await assertRestAccess(req, reply, { nameId, cap: "courses.view" }))) return;
    try {
      const request = parseDescriptionsQuery(req.query);
      const db = prisma();
      const event = await db.event.findUnique({ where: { nameId } });
      if (!event || event.removed) return reply.code(404).send({ error: "Event not found" });
      const blocks = await selectDescriptionBlocks(db, event, request);
      if (blocks.length === 0) return reply.code(404).send({ error: "No descriptions" });
      const out = await buildDescriptionsPdf({
        blocks,
        request,
        mode: "cmyk",
        info: { title: `${event.name} descriptions`, author: event.organizerName || undefined },
      });
      for (const warning of out.warnings) req.log.warn({ nameId }, `descriptions.pdf: ${warning}`);
      return reply
        .header("Content-Type", "application/pdf")
        .header("Content-Disposition", `attachment; filename="${safeFilename(event.nameId)}_descriptions.pdf"`)
        .header("Cache-Control", "no-store")
        .send(Buffer.from(out.bytes));
    } catch (error) {
      if (error instanceof DescriptionsRequestError || error instanceof DescriptionTooTallError) {
        return reply.code(400).send({ error: error.message });
      }
      req.log.error(error);
      return reply.code(500).send({ error: "Could not render description sheets" });
    }
  });
}
