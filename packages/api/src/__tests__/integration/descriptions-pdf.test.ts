/**
 * `GET /api/maps/:nameId/descriptions.pdf` (docs/course-print.md §6.4):
 * the selection (classes in the order asked, courses, every class with a
 * course), copies = runners + vacancies, the map page's header per class,
 * the 400s and 404s, and the document (pages, labels, `qpdf --check`).
 * The event has no base map: description sheets need none.
 */

import Fastify, { type FastifyInstance } from "fastify";
import { PDFArray, PDFDict, PDFDocument, PDFName } from "pdf-lib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseDescriptionsQuery, registerDescriptionsPdfRoute, selectDescriptionBlocks } from "../../course-maps/descriptions-pdf.js";
import { hasTool, qpdfCheck } from "../../render/pdf-golden.js";
import { createTestEvent, disconnect, type TestEventContext } from "../helpers/test-db.js";

const hasQpdf = await hasTool("qpdf");

let ctx: TestEventContext;
let empty: TestEventContext;
let server: FastifyInstance;
let seq: { h21: number; d21: number; open: number; blue: number; red: number };

beforeAll(async () => {
  ctx = await createTestEvent("descriptions_pdf");
  empty = await createTestEvent("descriptions_pdf_empty");
  const db = ctx.db;
  const eventId = ctx.eventId;
  const mk = (codes: string, xpos: number, ypos: number, extra: Record<string, unknown> = {}) => db.control.create({ data: { eventId, codes, xpos, ypos, ...extra } });
  const c31 = await mk("31", -80, 0, { description: { d: "2.004" } });
  const c32 = await mk("32", -60, 15);
  const c33 = await mk("33", -45, -5, { description: { d: "1.010", s: "1,5" } });
  await mk("", -95, -10, { status: "start" });
  const blue = await db.course.create({
    data: {
      eventId,
      name: "Blå",
      lengthM: 2300,
      climbM: 45,
      descriptionInstructions: { specials: [{ afterControlId: 32, kind: "13.1", lengthM: 150 }] },
      courseControls: { create: [{ position: 1, controlId: c31.id }, { position: 2, controlId: c32.id }, { position: 3, controlId: c33.id }] },
    },
  });
  const red = await db.course.create({ data: { eventId, name: "Röd", lengthM: 1200, courseControls: { create: [{ position: 1, controlId: c33.id }] } } });
  const h21 = await db.class.create({ data: { eventId, name: "H21", courseId: blue.id, vacantCount: 2, sortIndex: 2 } });
  const d21 = await db.class.create({ data: { eventId, name: "D21", courseId: blue.id, sortIndex: 1 } });
  const open = await db.class.create({ data: { eventId, name: "Öppen", sortIndex: 3 } });
  await db.class.create({ data: { eventId, name: "H35", courseId: red.id, sortIndex: 4 } });
  await db.runner.createMany({
    data: [
      { eventId, name: "A", classId: h21.id, cardNo: 1001 },
      { eventId, name: "B", classId: h21.id, cardNo: 1002 },
      { eventId, name: "C", classId: h21.id, cardNo: 1003 },
      // Neither counts: removed, and withdrawn (cancel).
      { eventId, name: "D", classId: h21.id, cardNo: 1004, removed: true },
      { eventId, name: "E", classId: h21.id, cardNo: 1005, status: "cancel" },
    ],
  });
  seq = { h21: h21.seq, d21: d21.seq, open: open.seq, blue: blue.seq, red: red.seq };

  server = Fastify({ logger: false });
  registerDescriptionsPdfRoute(server);
  await server.ready();
}, 60_000);

afterAll(async () => {
  await server?.close();
  await ctx?.cleanup();
  await empty?.cleanup();
  await disconnect();
});

const url = (nameId: string, query = "") => `/api/maps/${nameId}/descriptions.pdf${query}`;
const get = (query: string, nameId = ctx.nameId) => server.inject({ method: "GET", url: url(nameId, query) });
const event = () => ctx.db.event.findUniqueOrThrow({ where: { id: ctx.eventId } });

/** `/PageLabels` prefixes in page order. */
function labels(doc: PDFDocument): string[] {
  const nums = doc.catalog.lookup(PDFName.of("PageLabels"), PDFDict).lookup(PDFName.of("Nums"), PDFArray).asArray();
  const out: string[] = [];
  for (let i = 1; i < nums.length; i += 2) out.push((nums[i] as PDFDict).lookup(PDFName.of("P"))!.decodeText());
  return out;
}

describe("selectDescriptionBlocks", () => {
  it("classes in the order asked; count = runners (not removed, not withdrawn) + vacancies; the header names the class", async () => {
    const blocks = await selectDescriptionBlocks(ctx.db, await event(), parseDescriptionsQuery({ classes: `${seq.h21},${seq.d21}` }));
    expect(blocks.map((b) => [b.label, b.count])).toEqual([["H21", 5], ["D21", 0]]);
    expect(blocks[0].header).toMatchObject({ classNames: "H21", courseName: "Blå", lengthKm: "2.30 km", climbM: "45 m" });
    expect(blocks[0].header!.eventName).toBe((await event()).name);
    // The map page's rows: start, three controls, the special after 32, the finish.
    expect(blocks[0].rows.map((r) => r.kind)).toEqual(["start", "control", "control", "special", "control", "finish"]);
    expect(blocks[0].rows[1]).toMatchObject({ sequence: 1, code: "31", description: { d: "2.004" } });
  });

  it("courses: one block per course, its classes in the header, the count their sum", async () => {
    const blocks = await selectDescriptionBlocks(ctx.db, await event(), parseDescriptionsQuery({ courses: `${seq.red},${seq.blue}` }));
    expect(blocks.map((b) => [b.label, b.count, b.header?.classNames])).toEqual([["Röd", 0, "H35"], ["Blå", 5, "D21, H21"]]);
  });

  it("neither: every class with a course, in class order; a class without a course is skipped", async () => {
    const all = await selectDescriptionBlocks(ctx.db, await event(), parseDescriptionsQuery({}));
    expect(all.map((b) => b.label)).toEqual(["D21", "H21", "H35"]);
    expect(await selectDescriptionBlocks(ctx.db, await event(), parseDescriptionsQuery({ classes: String(seq.open) }))).toEqual([]);
  });
});

describe("GET /api/maps/:nameId/descriptions.pdf", () => {
  it("count: one page per class (H21 5 copies, D21 at least 1), labelled by class, A4 portrait", async () => {
    const res = await get(`?classes=${seq.h21},${seq.d21}`);
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("application/pdf");
    expect(res.headers["content-disposition"]).toBe(`attachment; filename="${ctx.nameId}_descriptions.pdf"`);
    expect(res.headers["cache-control"]).toBe("no-store");
    const doc = await PDFDocument.load(res.rawPayload);
    expect(doc.getPageCount()).toBe(2);
    expect(labels(doc)).toEqual(["H21", "D21"]);
    expect(doc.getPages().map((p) => [p.getWidth(), p.getHeight()].map((v) => Math.round((v * 25.4) / 72)))).toEqual([[210, 297], [210, 297]]);
    expect(doc.getTitle()).toBe(`${(await event()).name} descriptions`);
    if (hasQpdf) expect(await qpdfCheck(res.rawPayload)).toMatch(/No syntax or stream encoding errors/);
  }, 30_000);

  it("a number of copies past one sheet runs onto more pages of the same class (12 blocks per page at 6 mm)", async () => {
    const doc = await PDFDocument.load((await get(`?classes=${seq.h21}&copies=13`)).rawPayload);
    expect(labels(doc)).toEqual(["H21", "H21"]);
    const fill = await PDFDocument.load((await get(`?courses=${seq.blue}&copies=fill&cell=5`)).rawPayload);
    expect(labels(fill)).toEqual(["Blå"]);
  }, 30_000);

  it("400 for a bad query, an unknown class or course, too many pages", async () => {
    for (const q of [
      `?classes=${seq.h21}&courses=${seq.blue}`,
      "?classes=x",
      "?copies=0",
      "?copies=501",
      "?copies=some",
      "?cell=8",
      "?gap=-1",
      "?gap=31",
      "?classes=99999",
      "?courses=99999",
      // 6 + 6 + 8 blocks per page at 7 mm with a 30 mm gap: 84 + 84 + 63 pages.
      "?copies=500&cell=7&gap=30",
    ]) {
      const res = await get(q);
      expect(res.statusCode, q).toBe(400);
      expect(res.json().error, q).toEqual(expect.any(String));
    }
    expect((await get("?copies=500&cell=7&gap=30")).json().error).toMatch(/limited to 200 pages \(this one would have 231\)/);
  }, 30_000);

  it("404 No descriptions when nothing selected has a course; 404 for an unknown event", async () => {
    const courseless = await get(`?classes=${seq.open}`);
    expect(courseless.statusCode).toBe(404);
    expect(courseless.json()).toEqual({ error: "No descriptions" });
    const none = await get("", empty.nameId);
    expect(none.statusCode).toBe(404);
    expect(none.json()).toEqual({ error: "No descriptions" });
    expect((await get("", "oxygen_test_no_such_event")).statusCode).toBe(404);
  }, 30_000);
});
