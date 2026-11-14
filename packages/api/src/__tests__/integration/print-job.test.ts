/**
 * The print job (docs/course-print.md §8.5, G15): `GET …/print-job`
 * answers what `maps.pdf` composes, and a host composing it through the
 * shared `renderPrintJob` — the document from `/api/map-documents/:hash`,
 * the graphics from `print.png` — writes `maps.pdf`'s exact bytes (equal
 * writer options: `deterministic` on both sides; slice G answer 3). Same
 * selection, order, caps and auth as `maps.pdf`.
 */

import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import sharp from "sharp";
import { PDFDocument } from "pdf-lib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SYSTEM_GROUP_IDS, defaultMapAppearance } from "@oxygen/shared";
import { type PrintJob, printFontsFromFaces, renderPrintJob, svgRasterBox } from "@oxygen/shared/print";
import { buildPrintJob, registerCourseMapRoutes, MAX_COMPOSED_PAGES } from "../../course-maps/routes.js";
import { rasteriseSvgGraphic } from "../../course-maps/pdf-page.js";
import { renderCoursePagesInWorker } from "../../course-maps/print-worker-host.js";
import { registerMapDocumentRoutes, resetDocumentAccessCache } from "../../map-store/routes.js";
import { applyEventMap } from "../../event-map.js";
import { clearEventDocumentCaches } from "../../map-store/event-document.js";
import { writeCourseObject } from "../../course-objects.js";
import { bundledPdfFaces } from "../../render/fonts.js";
import { grantSystemGroup } from "../../permissions.js";
import type { AuthUser } from "../../auth.js";
import { makeCaller } from "../helpers/caller.js";
import { createTestEvent, disconnect, type TestEventContext } from "../helpers/test-db.js";

const fixture = resolve(__dirname, "../../../../../e2e/test.ocd");
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 10"><rect width="20" height="10" fill="#c00"/><circle cx="10" cy="5" r="3" fill="#fff"/></svg>');
const suffix = randomBytes(4).toString("hex");

let vec: TestEventContext;
let unpinned: TestEventContext;
let server: FastifyInstance;
let pngId: number;
let svgId: number;
let objectSvgId: number;
let clubId: number;
let otherEventGraphicId: number;
let courseSeq: number;
let h21Seq: number;
let a4TemplateId: string;
let sheetSeqs: number[];

/** `maps.pdf` and every route a host reads, `deterministic` like the host below (equal writer options, §8.5). */
function makeServer(): FastifyInstance {
  const s = Fastify({ logger: false });
  registerCourseMapRoutes(s, { renderCoursePages: (o) => renderCoursePagesInWorker({ ...o, deterministic: true }) });
  registerMapDocumentRoutes(s);
  return s;
}

const get = (url: string, headers: Record<string, string> = {}) => server.inject({ method: "GET", url, headers });
const jobUrl = (nameId: string, query = "") => `/api/maps/${nameId}/print-job${query}`;
const pdfUrl = (nameId: string, query = "") => `/api/maps/${nameId}/maps.pdf${query}`;

/** A host as G16's worker will be: everything over HTTP, the bundled faces in their order. */
async function composeOverHttp(nameId: string, job: PrintJob) {
  const fonts = printFontsFromFaces(await bundledPdfFaces());
  const fetched: string[] = [];
  return {
    fetched,
    out: await renderPrintJob(job, {
      fonts,
      deterministic: true,
      document: async (hash) => {
        const res = await get(`/api/map-documents/${hash}?event=${nameId}`, { "accept-encoding": "identity" });
        expect(res.statusCode).toBe(200);
        return new Uint8Array(res.rawPayload);
      },
      graphic: async (id, box) => {
        const url = `/api/maps/${nameId}/graphics/${id}/print.png${box ? `?w=${box[0]}&h=${box[1]}` : ""}`;
        fetched.push(url);
        const res = await get(url);
        if (res.statusCode !== 200) throw new Error(`print.png ${res.statusCode}`);
        return new Uint8Array(res.rawPayload);
      },
    }),
  };
}

/** No `undefined` value, non-finite number, Map, Set, Date or typed array anywhere (§8.5 "JSON-safe"). */
function jsonUnsafe(value: unknown, path = "$"): string[] {
  if (value === undefined) return [path];
  if (typeof value === "number") return Number.isFinite(value) ? [] : [path];
  if (value === null || typeof value !== "object") return [];
  if (value instanceof Map || value instanceof Set || value instanceof Date || ArrayBuffer.isView(value)) return [path];
  if (Array.isArray(value)) return value.flatMap((v, i) => jsonUnsafe(v, `${path}[${i}]`));
  return Object.entries(value).flatMap(([k, v]) => jsonUnsafe(v, `${path}.${k}`));
}

beforeAll(async () => {
  vec = await createTestEvent("print_job");
  unpinned = await createTestEvent("print_job_unpinned");
  const bytes = Buffer.concat([readFileSync(fixture), Buffer.from(`print-job-${suffix}`)]);
  const applied = await applyEventMap(vec.db, vec.eventId, "test.ocd", bytes);
  expect(applied.documentHash).toMatch(/^[0-9a-f]{64}$/);
  clearEventDocumentCaches();

  const db = vec.db;
  const PNG = await sharp({ create: { width: 4, height: 2, channels: 4, background: "#00a000" } }).png().toBuffer();
  const graphic = async (eventId: bigint | null, name: string, mime: string, data: Buffer) =>
    Number((await db.graphic.create({ data: { eventId, name, mime, data, sizeBytes: data.length } })).id);
  pngId = await graphic(vec.eventId, "logo.png", "image/png", PNG);
  svgId = await graphic(vec.eventId, "logo.svg", "image/svg+xml", SVG);
  objectSvgId = await graphic(vec.eventId, "object.svg", "image/svg+xml", SVG);
  clubId = await graphic(null, `club-${suffix}.png`, "image/png", PNG);
  otherEventGraphicId = await graphic(unpinned.eventId, "theirs.png", "image/png", PNG);

  const mk = (codes: string, xpos: number, ypos: number, extra: Record<string, unknown> = {}) => db.control.create({ data: { eventId: vec.eventId, codes, xpos, ypos, ...extra } });
  const c31 = await mk("31", -80, 0, { description: { d: "2.004" } });
  const c32 = await mk("32", -60, 15);
  await mk("", -95, -10, { status: "start" });
  const template = await db.mapTemplate.create({
    data: {
      eventId: vec.eventId,
      name: "A4",
      printScale: 7500,
      settings: { printMarginMm: 3, mapFrame: { x: 8, y: 8, width: 194, height: 281 }, description: { visible: true, x: 150, y: 12, cellSizeMm: 6 }, appearance: defaultMapAppearance },
      objects: [
        { id: "title", anchor: "page", kind: "text", x: 12, y: 284, text: "{event} · {course}", fontSizeMm: 5, color: "#000000" },
        { id: "logo", anchor: "page", kind: "image", graphicId: pngId, x: 12, y: 260, width: 20, height: 10 },
        { id: "svg", anchor: "page", kind: "image", graphicId: svgId, x: 40, y: 260, width: 20, height: 10 },
        { id: "club", anchor: "page", kind: "image", graphicId: clubId, x: 70, y: 260, width: 8, height: 4 },
        // Another event's graphic is not this event's: absent from the job, IMAGE_MISSING on both paths.
        { id: "theirs", anchor: "page", kind: "image", graphicId: otherEventGraphicId, x: 90, y: 260, width: 8, height: 4 },
      ],
    },
  });
  a4TemplateId = template.id;
  const a5 = await db.mapTemplate.create({
    data: { eventId: vec.eventId, name: "A5", paper: "A5", printScale: 10000, settings: { printMarginMm: 3, mapFrame: { x: 5, y: 5, width: 138, height: 200 }, description: { visible: false, x: 0, y: 0, cellSizeMm: 5 }, appearance: defaultMapAppearance } },
  });
  const blue = await db.course.create({
    data: { eventId: vec.eventId, name: "Blå", lengthM: 2300, climbM: 45, courseControls: { create: [{ position: 1, controlId: c31.id }, { position: 2, controlId: c32.id }] } },
  });
  courseSeq = blue.seq;
  const maps = [
    await db.courseMap.create({ data: { eventId: vec.eventId, name: "Blå A4", kind: "course", courseId: blue.id, templateId: template.id, windowCenter: { x: -70, y: 5 } } }),
    await db.courseMap.create({ data: { eventId: vec.eventId, name: "Blå A5", kind: "course", courseId: blue.id, templateId: a5.id, windowCenter: { x: -70, y: 5 }, sortOrder: 1 } }),
    await db.courseMap.create({ data: { eventId: vec.eventId, name: "Alla", kind: "all_controls", templateId: template.id, windowCenter: { x: -70, y: 5 } } }),
  ];
  sheetSeqs = maps.map((m) => m.seq);
  // A map-anchored image course object with a crop: its SVG box is the placed size × scaleRatio over the crop (§6.3).
  await writeCourseObject(db, vec.eventId, {
    body: { kind: "image", geometry: [{ x: -90, y: -5 }, { x: -78, y: 1 }], props: { graphicId: objectSvgId, crop: { x: 0.25, y: 0, width: 0.5, height: 1 } } },
    scope: { courses: [blue.id], classes: [] },
  });

  const caller = makeCaller(vec.event);
  const h21 = (await caller.class.create({ name: "H21", courseId: blue.seq })).id;
  h21Seq = h21;
  for (let i = 0; i < 2; i++) await caller.runner.create({ name: `Runner ${i}`, classId: h21 });

  server = makeServer();
  await server.ready();
}, 120_000);

afterAll(async () => {
  await server?.close();
  await vec?.db.graphic.deleteMany({ where: { id: BigInt(clubId) } });
  await vec?.cleanup();
  await unpinned?.cleanup();
  await disconnect();
});

describe("GET /api/maps/:nameId/print-job (§8.5)", () => {
  it("answers the job: version, document, sheets in print order, graphics by id, cmyk, info, filename; JSON-safe, no-store", async () => {
    const res = await get(jobUrl(vec.nameId));
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("application/json");
    expect(res.headers["cache-control"]).toBe("no-store");
    const job = res.json() as PrintJob;
    const pin = await vec.db.mapFile.findFirstOrThrow({ where: { eventId: vec.eventId } });
    expect(job.version).toBe(2);
    expect(job.document).toEqual({ hash: pin.documentHash, rotationCorrectionDeg: pin.rotationCorrection ?? 0, patch: null });
    expect(job.mode).toBe("cmyk");
    expect(job.sheets.map((s) => s.label)).toEqual(["Blå", "Blå", "Alla"]);
    expect(job.sheets.map((s) => s.paper)).toEqual([{ widthMm: 210, heightMm: 297 }, { widthMm: 148, heightMm: 210 }, { widthMm: 210, heightMm: 297 }]);
    // Ascending id; the course object's graphic too; another event's graphic absent.
    expect(job.graphics).toEqual([
      { id: pngId, mime: "image/png" },
      { id: svgId, mime: "image/svg+xml" },
      { id: objectSvgId, mime: "image/svg+xml" },
      { id: clubId, mime: "image/png" },
    ]);
    const event = await vec.db.event.findUniqueOrThrow({ where: { id: vec.eventId } });
    expect(job.info.title).toBe(`${event.name} maps`);
    expect(job.filename).toBe(`${vec.nameId}_maps.pdf`);
    // The builder's object itself — what maps.pdf composes without a JSON round trip — holds nothing JSON would change.
    const built = await buildPrintJob(vec.db, event, {}, { graphicBytes: false });
    expect(jsonUnsafe(built.job)).toEqual([]);
    expect(JSON.parse(JSON.stringify(built.job))).toEqual(built.job);
    expect(JSON.parse(res.body)).toEqual(built.job);
  });

  it("composed over HTTP, the job writes maps.pdf's exact bytes — PNG as stored, SVG at the composer's box", async () => {
    const pdf = await get(pdfUrl(vec.nameId));
    expect(pdf.statusCode).toBe(200);
    const job = (await get(jobUrl(vec.nameId))).json() as PrintJob;
    const { out, fetched } = await composeOverHttp(vec.nameId, job);
    expect(out.pageCount).toBe(3);
    expect(Buffer.from(out.bytes).equals(pdf.rawPayload)).toBe(true);
    // Only the other event's graphic is missing; the course object's SVG is drawn (it printed as IMAGE_MISSING before G15).
    const missing = out.warnings.filter((w) => w.includes("IMAGE_MISSING"));
    expect(missing.length).toBeGreaterThan(0);
    expect(missing.every((w) => w.includes(`graphic ${otherEventGraphicId}`))).toBe(true);
    expect(out.warnings.filter((w) => w.includes("SVG_RASTER"))).toEqual([]);
    const [w, h] = svgRasterBox(20, 10);
    expect(fetched).toContain(`/api/maps/${vec.nameId}/graphics/${svgId}/print.png?w=${w}&h=${h}`);
    expect(fetched).toContain(`/api/maps/${vec.nameId}/graphics/${pngId}/print.png`);
    expect(fetched.some((u) => u.startsWith(`/api/maps/${vec.nameId}/graphics/${objectSvgId}/print.png?w=`))).toBe(true);
  }, 120_000);

  it("the same selection, order and copies as maps.pdf, byte for byte, for one sheet and for copies=runners&spare", async () => {
    for (const query of [`?maps=${sheetSeqs[1]}`, `?courses=${courseSeq}&copies=runners&spare=1`, "?allControls=1", `?classes=${h21Seq}`]) {
      const pdf = await get(pdfUrl(vec.nameId, query));
      expect(pdf.statusCode, query).toBe(200);
      const job = (await get(jobUrl(vec.nameId, query))).json() as PrintJob;
      expect(pdf.headers["content-disposition"]).toBe(`attachment; filename="${job.filename}"`);
      const { out } = await composeOverHttp(vec.nameId, job);
      expect(Buffer.from(out.bytes).equals(pdf.rawPayload), query).toBe(true);
      expect(out.pageCount).toBe((await PDFDocument.load(pdf.rawPayload)).getPageCount());
    }
    const one = (await get(jobUrl(vec.nameId, `?maps=${sheetSeqs[1]}`))).json() as PrintJob;
    expect(one.filename).toBe(`${vec.nameId}_Bla_A5.pdf`);
    expect(one.graphics).toEqual([{ id: objectSvgId, mime: "image/svg+xml" }]);
    // Two runners + one spare on each of the course's two sheets.
    const stack = (await get(jobUrl(vec.nameId, `?courses=${courseSeq}&copies=runners&spare=1`))).json() as PrintJob;
    expect(stack.sheets.map((s) => s.copies)).toEqual([3, 3]);
  }, 180_000);

  it("the caps and every selection 400 are maps.pdf's, word for word", async () => {
    const capCourse = await vec.db.course.create({ data: { eventId: vec.eventId, name: "Cap" } });
    const extra = await vec.db.courseMap.createManyAndReturn({
      data: Array.from({ length: MAX_COMPOSED_PAGES }, (_, i) => ({ eventId: vec.eventId, name: `Cap ${i}`, kind: "course", courseId: capCourse.id, windowCenter: { x: 0, y: 0 } })),
      select: { id: true, seq: true },
    });
    try {
      for (const query of [`?maps=${extra.map((m) => m.seq).join(",")},${sheetSeqs[0]}`, "?spare=1", "?courses=1&copies=runners&spare=501", "?maps=99999", "?maps=1&courses=1", "?copies=all"]) {
        const job = await get(jobUrl(vec.nameId, query));
        const pdf = await get(pdfUrl(vec.nameId, query));
        expect(job.statusCode, query).toBe(400);
        expect(pdf.statusCode, query).toBe(400);
        expect(job.json(), query).toEqual(pdf.json());
      }
      expect((await get(jobUrl(vec.nameId, `?maps=${extra.map((m) => m.seq).join(",")},${sheetSeqs[0]}`))).json()).toEqual({ error: `A single export is limited to ${MAX_COMPOSED_PAGES} map pages` });
      expect((await get(jobUrl(vec.nameId, "?courses=1&copies=runners&spare=501"))).json()).toEqual({ error: "spare must be an integer 0–500" });
    } finally {
      await vec.db.courseMap.deleteMany({ where: { id: { in: extra.map((m) => m.id) } } });
      await vec.db.course.delete({ where: { id: capCourse.id } });
    }
  }, 60_000);

  it("no pin is a 400 'No base map uploaded'; an unknown event a 404", async () => {
    const mapRow = await unpinned.db.courseMap.create({ data: { eventId: unpinned.eventId, name: "x", kind: "all_controls", windowCenter: { x: 0, y: 0 } } });
    expect(mapRow.seq).toBeGreaterThan(0);
    const res = await get(jobUrl(unpinned.nameId));
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "No base map uploaded" });
    expect((await get(jobUrl(`missing-${suffix}`))).statusCode).toBe(404);
  });
});

describe("a course with variations: the job of every variant selection is maps.pdf's bytes (§4.6, §8.5)", () => {
  let rootSeq: number;

  beforeAll(async () => {
    const caller = makeCaller(vec.event);
    const site = async (data: Parameters<typeof caller.control.create>[0]) => (await caller.control.create(data)).id;
    const S = await site({ status: 4, xpos: -95, ypos: -12 });
    const F = await site({ status: 5, xpos: -50, ypos: -12 });
    const [a, b, c, d] = [await site({ codes: "41", xpos: -85, ypos: 2 }), await site({ codes: "42", xpos: -75, ypos: 17 }), await site({ codes: "43", xpos: -65, ypos: 17 }), await site({ codes: "44", xpos: -60, ypos: 2 })];
    rootSeq = (await caller.course.create({ name: "Long" })).id;
    // A butterfly: variants AB and BA, numbered alike (F15 labels on the all-variations page).
    await caller.course.setStructure({
      courseId: rootSeq,
      structure: {
        version: 1,
        id: "x",
        orderMode: "ordered",
        items: [
          { siteId: S }, { siteId: a },
          { kind: "variation", id: "b", loop: true, alternatives: [{ label: "A", items: [{ siteId: b }] }, { label: "B", items: [{ siteId: c }] }] },
          { siteId: d }, { siteId: F },
        ],
      },
    });
    const root = await vec.db.course.findFirstOrThrow({ where: { eventId: vec.eventId, seq: rootSeq } });
    await vec.db.courseMap.create({ data: { eventId: vec.eventId, name: "Long A4", kind: "course", courseId: root.id, templateId: a4TemplateId, windowCenter: { x: -70, y: 5 } } });
  }, 60_000);

  it("variants=, allVariations= and courses= of the root", async () => {
    for (const query of [`?courses=${rootSeq}`, `?variants=${rootSeq}:BA`, `?allVariations=${rootSeq}`]) {
      const pdf = await get(pdfUrl(vec.nameId, query));
      expect(pdf.statusCode, `${query} ${pdf.body.slice(0, 200)}`).toBe(200);
      const job = (await get(jobUrl(vec.nameId, query))).json() as PrintJob;
      const { out } = await composeOverHttp(vec.nameId, job);
      expect(Buffer.from(out.bytes).equals(pdf.rawPayload), query).toBe(true);
    }
    const all = (await get(jobUrl(vec.nameId, `?courses=${rootSeq}`))).json() as PrintJob;
    expect(all.sheets.map((s) => s.label)).toEqual(["Long AB", "Long BA"]);
    expect((await get(jobUrl(vec.nameId, `?allVariations=${rootSeq}`))).json().filename).toBe(`${vec.nameId}_Long_A4_AB_BA.pdf`);
  }, 180_000);
});

describe("GET /api/maps/:nameId/graphics/:id/print.png (§8.5)", () => {
  it("an SVG is resvg at exactly w × h — the bytes a print embeds; a PNG as stored, w and h ignored", async () => {
    const res = await get(`/api/maps/${vec.nameId}/graphics/${svgId}/print.png?w=473&h=236`);
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("image/png");
    expect(res.headers["cache-control"]).toBe("private, max-age=3600");
    expect(res.rawPayload.equals(Buffer.from(await rasteriseSvgGraphic(SVG, 473, 236)))).toBe(true);
    const meta = await sharp(res.rawPayload).metadata();
    expect([meta.width, meta.height]).toEqual([473, 236]);

    const stored = await vec.db.graphic.findUniqueOrThrow({ where: { id: BigInt(pngId) } });
    for (const q of ["", "?w=10&h=10", "?w=bad"]) {
      const png = await get(`/api/maps/${vec.nameId}/graphics/${pngId}/print.png${q}`);
      expect(png.statusCode, q).toBe(200);
      expect(png.headers["content-type"]).toBe("image/png");
      expect(png.rawPayload.equals(Buffer.from(stored.data))).toBe(true);
    }
  });

  it("an SVG needs w and h, integers 1–4096", async () => {
    for (const q of ["", "?w=10", "?w=0&h=10", "?w=4097&h=10", "?w=1.5&h=2", "?w=-3&h=2", "?w=ten&h=2"]) {
      const res = await get(`/api/maps/${vec.nameId}/graphics/${svgId}/print.png${q}`);
      expect(res.statusCode, q).toBe(400);
      expect(res.json().error).toBe("w and h must be integers 1–4096 for an SVG graphic");
    }
    expect((await get(`/api/maps/${vec.nameId}/graphics/${svgId}/print.png?w=4096&h=1`)).statusCode).toBe(200);
  });

  it("a club graphic is served; another event's and an unknown one are 404; a bad id 400", async () => {
    expect((await get(`/api/maps/${vec.nameId}/graphics/${clubId}/print.png`)).statusCode).toBe(200);
    expect((await get(`/api/maps/${vec.nameId}/graphics/${otherEventGraphicId}/print.png`)).statusCode).toBe(404);
    expect((await get(`/api/maps/${vec.nameId}/graphics/999999999/print.png`)).statusCode).toBe(404);
    expect((await get(`/api/maps/${vec.nameId}/graphics/0/print.png`)).statusCode).toBe(400);
  });
});

describe("auth: courses.view on the event, as maps.pdf (§8.5)", () => {
  let previousAuthMode: string | undefined;
  let member: AuthUser;
  let stranger: AuthUser;

  beforeAll(async () => {
    const mkUser = (name: string, isAdmin = false) =>
      vec.db.user.create({ data: { email: `${name}@print-job-${suffix}.example`, displayName: name, isAdmin, active: true } });
    const admin = await mkUser("admin", true);
    member = await mkUser("member");
    stranger = await mkUser("stranger");
    await grantSystemGroup(vec.db, { eventId: vec.eventId, userId: member.id, groupId: SYSTEM_GROUP_IDS.courseSetter, grantedBy: admin.id });
    // A future date: a completed event grants courses.view to every signed-in user.
    await vec.db.event.update({ where: { id: vec.eventId }, data: { date: new Date("2099-06-01T00:00:00Z") } });
    previousAuthMode = process.env.AUTH_MODE;
    process.env.AUTH_MODE = "proxy";
    resetDocumentAccessCache();
  });

  afterAll(async () => {
    if (previousAuthMode === undefined) delete process.env.AUTH_MODE;
    else process.env.AUTH_MODE = previousAuthMode;
  });

  it("anonymous 401, signed in without the capability 403, a course setter 200 — on the job and on print.png", async () => {
    for (const url of [jobUrl(vec.nameId), `/api/maps/${vec.nameId}/graphics/${pngId}/print.png`, `/api/maps/${vec.nameId}/graphics/${svgId}/print.png?w=20&h=10`]) {
      expect((await get(url)).statusCode, url).toBe(401);
      expect((await get(url, { "x-forwarded-email": stranger.email })).statusCode, url).toBe(403);
      expect((await get(url, { "x-forwarded-email": member.email })).statusCode, url).toBe(200);
    }
  });
});
