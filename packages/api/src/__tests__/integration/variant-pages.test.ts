/**
 * Per-variant pages and the all-variations page (slice F, row F8;
 * docs/course-print.md §4.6, docs/course-layout.md §7; research 08 §4.6,
 * §5.2, §5.3):
 *
 *   - `maps.pdf?courses=<root>` one page per (own sheet × variant), key
 *     order, labels `<root> <key>`, `{variant}`, the shared window
 *   - `?courses=<variant>` prints that key on the root's sheet (no sheet of
 *     its own), `?variants=`, `?classes=` of a class on a root
 *   - `?allVariations=` one page, spine + petals, codes, no tint
 *   - `&copies=runners[&spare=n]` the hand-out stack in key order
 *   - the refusals; `autoSheets` of a variant is its root's
 */

import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName } from "pdf-lib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { WireCourseStructure } from "@oxygen/shared";
import { registerCourseMapRoutes, selectPrintPages } from "../../course-maps/routes.js";
import { allVariationsSuffix, sheetForMapRow } from "../../course-maps/pdf-page.js";
import { createTestEvent, disconnect, type TestEventContext } from "../helpers/test-db.js";
import { makeCaller } from "../helpers/caller.js";
import { applyEventMap } from "../../event-map.js";
import { clearEventDocumentCaches } from "../../map-store/event-document.js";
import { hasTool, qpdfCheck } from "../../render/pdf-golden.js";
import { Prisma } from "../../generated/prisma/client.js";

const hasQpdf = await hasTool("qpdf");
const fixture = resolve(__dirname, "../../../../../e2e/test.ocd");

let ctx: TestEventContext;
let caller: ReturnType<typeof makeCaller>;
let server: FastifyInstance;
let S: number;
let F: number;
const site: Record<number, number> = {};
let long: { id: number; key: (k: string) => number };
let shortSeq: number;
let h21: number;
let d21: number;

type Items = WireCourseStructure["items"];
const ctl = (siteId: number): Items[number] => ({ siteId });

const pdfUrl = (query: string) => `/api/maps/${ctx.nameId}/maps.pdf${query}`;
const get = (query: string) => server.inject({ method: "GET", url: pdfUrl(query) });

/** `/PageLabels` prefixes, one per page. */
function pageLabels(pdf: PDFDocument): string[] {
  const nums = pdf.catalog.lookup(PDFName.of("PageLabels"), PDFDict).lookup(PDFName.of("Nums"), PDFArray).asArray();
  const out: string[] = [];
  for (let i = 1; i < nums.length; i += 2) {
    const p = (nums[i] as PDFDict).lookup(PDFName.of("P"));
    out.push(p instanceof PDFHexString ? p.decodeText() : "");
  }
  return out;
}

async function context() {
  const event = await ctx.db.event.findUniqueOrThrow({ where: { id: ctx.eventId } });
  const allControls = await ctx.db.control.findMany({
    where: { eventId: ctx.eventId, removed: false },
    select: { id: true, seq: true, codes: true, name: true, status: true, kind: true, xpos: true, ypos: true, description: true },
  });
  return { event: { name: event.name, date: event.date }, allControls, mapInfo: { scale: 15000, meridianTiltDeg: 0 } };
}

beforeAll(async () => {
  ctx = await createTestEvent("variant_pages");
  caller = makeCaller(ctx.event);
  const bytes = Buffer.concat([readFileSync(fixture), Buffer.from(`variants-${randomBytes(4).toString("hex")}`)]);
  await applyEventMap(ctx.db, ctx.eventId, "test.ocd", bytes);
  clearEventDocumentCaches();
  S = (await caller.control.create({ status: 4, xpos: -95, ypos: -10 })).id;
  F = (await caller.control.create({ status: 5, xpos: -50, ypos: -10 })).id;
  for (const [code, x, y] of [[31, -85, 0], [32, -75, 15], [33, -65, 15], [34, -60, 0]] as const) {
    site[code] = (await caller.control.create({ codes: String(code), xpos: x, ypos: y })).id;
  }
  // A butterfly at 31: variants AB and BA (the F7 E2E fixture's shape).
  const { id } = await caller.course.create({ name: "Long", climb: 40 });
  await caller.course.setStructure({
    courseId: id,
    structure: {
      version: 1,
      id: "x",
      orderMode: "ordered",
      items: [
        ctl(S), ctl(site[31]),
        { kind: "variation", id: "b", loop: true, alternatives: [{ label: "A", items: [ctl(site[32])] }, { label: "B", items: [ctl(site[33])] }] },
        ctl(site[34]), ctl(F),
      ],
    },
  });
  const variants = await caller.course.variantList({ courseId: id });
  long = { id, key: (k) => variants.find((v) => v.variantKey === k)!.courseId };
  shortSeq = (await caller.course.create({ name: "Short" })).id;
  await caller.course.setStructure({ courseId: shortSeq, structure: { version: 1, id: "y", orderMode: "ordered", items: [ctl(S), ctl(site[31]), ctl(F)] } });
  h21 = (await caller.class.create({ name: "H21", courseId: id })).id;
  d21 = (await caller.class.create({ name: "D21", courseId: shortSeq })).id;
  // Dealt the least-populated variant: AB, BA, AB (F6b).
  for (let i = 0; i < 3; i++) await caller.runner.create({ name: `H${i}`, classId: h21 });
  for (let i = 0; i < 2; i++) await caller.runner.create({ name: `D${i}`, classId: d21 });
  await caller.layout.autoSheets({});

  server = Fastify({ logger: false });
  registerCourseMapRoutes(server);
  await server.ready();
}, 90_000);

afterAll(async () => {
  await server?.close();
  await ctx?.cleanup();
  await disconnect();
});

describe("per-variant pages (course-print.md §4.6)", () => {
  it("autoSheets made sheets for the root and the plain course only; a variant's autoSheets is its root's", async () => {
    const sheets = await ctx.db.courseMap.findMany({ where: { eventId: ctx.eventId }, include: { course: { select: { name: true } } } });
    expect(sheets.map((s) => s.course?.name).sort()).toEqual(["Long", "Short"]);
    const viaChild = await caller.layout.autoSheets({ courseId: long.key("BA") });
    expect(viaChild.createdSheets).toEqual([]);
    expect(viaChild.courseSheets).toEqual(sheets.filter((s) => s.course?.name === "Long").map((s) => s.seq));
  });

  it("?courses=<root>: one page per variant in key order, labelled <root> <key>, on one shared window", async () => {
    const res = await get(`?courses=${long.id}`);
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-disposition"]).toContain("_maps.pdf");
    const pdf = await PDFDocument.load(res.rawPayload);
    expect(pdf.getPageCount()).toBe(2);
    expect(pageLabels(pdf)).toEqual(["Long AB", "Long BA"]);

    const pages = await selectPrintPages(ctx.db, ctx.eventId, { courses: String(long.id) });
    // The course stays the root (course objects are scoped to it); the runners' course is the child.
    const root = await ctx.db.course.findFirstOrThrow({ where: { eventId: ctx.eventId, seq: long.id } });
    const kids = await ctx.db.course.findMany({ where: { parentCourseId: root.id }, orderBy: { variantKey: "asc" } });
    expect(pages.map((p) => [p.row.course?.id, p.runnerCourseId])).toEqual(kids.map((k) => [root.id, k.id]));
    const c = await context();
    const sheets = pages.map((p) => sheetForMapRow(p.row, c));
    expect(sheets.map((s) => [s.label, s.textValues.variant, s.textValues.course, s.description?.header?.courseName])).toEqual([
      ["Long AB", "AB", "Long AB", "Long AB"],
      ["Long BA", "BA", "Long BA", "Long BA"],
    ]);
    // The variant's linear path: S 31 32 31 33 34 F, numbered as it prints.
    const byId = new Map(c.allControls.map((x) => [x.id, x.status === "start" || x.status === "finish" ? x.status : x.codes]));
    const path = (s: (typeof sheets)[number]) => (Array.isArray(s.course.structure) ? [] : s.course.structure!.items.map((i) => byId.get(i.siteId)));
    expect(path(sheets[0])).toEqual(["start", "31", "32", "31", "33", "34", "finish"]);
    expect(path(sheets[1])).toEqual(["start", "31", "33", "31", "32", "34", "finish"]);
    expect(sheets[0].description?.rows.filter((r) => r.kind === "control").map((r) => [r.sequence, r.code])).toEqual([
      [1, "31"], [2, "32"], [3, "31"], [4, "33"], [5, "34"],
    ]);
    // A NULL window centre centres on every alternative: the variants share the window.
    expect(sheets[0].window).toEqual(sheets[1].window);
  }, 60_000);

  it("?courses=<variant> prints that key on its root's sheet and creates no sheet of its own; ?variants= selects keys", async () => {
    const before = await ctx.db.courseMap.count({ where: { eventId: ctx.eventId } });
    const res = await get(`?courses=${long.key("BA")}`);
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-disposition"]).toContain("_Long_BA.pdf");
    const pdf = await PDFDocument.load(res.rawPayload);
    expect(pageLabels(pdf)).toEqual(["Long BA"]);
    expect(pdf.getTitle()).toContain("· Long BA");
    expect(await ctx.db.courseMap.count({ where: { eventId: ctx.eventId } })).toBe(before);

    const some = await get(`?variants=${long.id}:BA,AB`);
    expect(pageLabels(await PDFDocument.load(some.rawPayload))).toEqual(["Long AB", "Long BA"]);
  }, 60_000);

  it("?classes= of a class on a root prints the class's root per variant, the header naming the class", async () => {
    const res = await get(`?classes=${h21}`);
    expect(res.statusCode).toBe(200);
    expect(pageLabels(await PDFDocument.load(res.rawPayload))).toEqual(["Long AB", "Long BA"]);
    const pages = await selectPrintPages(ctx.db, ctx.eventId, { classes: String(h21) });
    const sheet = sheetForMapRow(pages[1].row, await context());
    expect(sheet.description?.header?.classNames).toBe("H21");
    expect(sheet.textValues.variant).toBe("BA");
  }, 60_000);

  it("?allVariations=<root>: one page, the spine and both petals in the one purple, codes, every control once in the block", async () => {
    const res = await get(`?allVariations=${long.id}`);
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-disposition"]).toContain("_Long_AB_BA.pdf");
    expect(pageLabels(await PDFDocument.load(res.rawPayload))).toEqual(["Long AB/BA"]);
    const pages = await selectPrintPages(ctx.db, ctx.eventId, { allVariations: String(long.id) });
    const sheet = sheetForMapRow(pages[0].row, await context());
    const structures = sheet.course.structure as readonly { id: string; items: { siteId: string }[]; tint?: string }[];
    expect(structures).toHaveLength(3);
    expect(structures.some((s) => s.tint)).toBe(false);
    expect(sheet.course.viewOptions.labelMode).toBe("code");
    expect("allVariations" in sheet.course.viewOptions).toBe(false);
    expect(sheet.textValues.variant).toBe("AB/BA");
    expect(sheet.description?.rows.filter((r) => r.kind === "control").map((r) => [r.sequence, r.code])).toEqual([
      [undefined, "31"], [undefined, "32"], [undefined, "33"], [undefined, "34"],
    ]);
    // Every visited site is drawn.
    expect(sheet.course.sites.map((s) => s.kind).sort()).toEqual(["control", "control", "control", "control", "finish", "start"]);
    expect(sheet.course.sites.map((s) => s.code).filter((code) => /^3\d$/.test(code)).sort()).toEqual(["31", "32", "33", "34"]);
  }, 60_000);

  it("&copies=runners[&spare=n]: each variant page once per runner assigned to it, plus spare, in key order", async () => {
    const res = await get(`?courses=${long.id}&copies=runners&spare=1`);
    expect(res.statusCode).toBe(200);
    const pdf = await PDFDocument.load(res.rawPayload);
    // AB 2 + 1, BA 1 + 1.
    expect(pageLabels(pdf)).toEqual(["Long AB", "Long AB", "Long AB", "Long BA", "Long BA"]);
    // The copies share the composed page's content stream (PdfWriter.copyPage).
    expect(pdf.getPage(1).node.Contents()?.toString()).toBe(pdf.getPage(0).node.Contents()?.toString());
    expect(pdf.getPage(3).node.Contents()?.toString()).not.toBe(pdf.getPage(0).node.Contents()?.toString());
    if (hasQpdf || process.env.CI) expect(await qpdfCheck(res.rawPayload)).toMatch(/No syntax or stream encoding errors/);

    // A class's stack counts that class's runners; a plain course its classes' runners (no variant of their own).
    expect((await PDFDocument.load((await get(`?classes=${h21}&copies=runners`)).rawPayload)).getPageCount()).toBe(3);
    expect((await PDFDocument.load((await get(`?courses=${shortSeq}&copies=runners`)).rawPayload)).getPageCount()).toBe(2);
    expect((await PDFDocument.load((await get(`?variants=${long.id}:BA&copies=runners&spare=2`)).rawPayload)).getPageCount()).toBe(3);
  }, 90_000);

  it("the unfiltered export prints the root per variant and the plain course", async () => {
    const res = await get("");
    expect(res.statusCode).toBe(200);
    expect(pageLabels(await PDFDocument.load(res.rawPayload))).toEqual(["Long AB", "Long BA", "Short"]);
    // A root's sheet named by `maps=` prints every variant too: a root has no page of its own.
    const sheet = (await ctx.db.courseMap.findFirstOrThrow({ where: { eventId: ctx.eventId, course: { seq: long.id } } })).seq;
    expect(pageLabels(await PDFDocument.load((await get(`?maps=${sheet}`)).rawPayload))).toEqual(["Long AB", "Long BA"]);
  }, 60_000);

  it("the all-variations name lists five keys, then …", () => {
    expect(allVariationsSuffix(["AB", "BA"])).toBe("AB/BA");
    expect(allVariationsSuffix(["A", "B", "C", "D", "E"])).toBe("A/B/C/D/E");
    expect(allVariationsSuffix(["A", "B", "C", "D", "E", "F"])).toBe("A/B/C/D/E/…");
  });

  it("courseMap.resolveSheet { variantKey }: Layout mode and Class view of a root draw a variant (course-layout.md §1, §6)", async () => {
    const sheet = (await ctx.db.courseMap.findFirstOrThrow({ where: { eventId: ctx.eventId, course: { seq: long.id } } })).seq;
    const plain = await caller.courseMap.resolveSheet({ seq: sheet });
    expect(plain.variantKey).toBeNull();
    const ba = await caller.courseMap.resolveSheet({ seq: sheet, variantKey: "BA" });
    expect(ba.variantKey).toBe("BA");
    expect(ba.courseSeq).toBe(long.id);
    expect(ba.page.textValues.variant).toBe("BA");
    expect(ba.block.title).toBe("Long BA");
    expect(ba.block.rows.filter((r) => r.kind === "control").map((r) => r.code)).toEqual(["31", "33", "31", "32", "34"]);
    // Every variant and the root's own read share the window.
    expect(ba.window).toEqual((await caller.courseMap.resolveSheet({ seq: sheet, variantKey: "AB" })).window);
    expect(plain.window).toEqual(ba.window);
    const cls = await caller.courseMap.resolveSheet({ classSeq: h21, variantKey: "AB" });
    expect([cls.variantKey, cls.block.header?.classNames, cls.classView?.className]).toEqual(["AB", "H21", "H21"]);
    // A key without a live variant (the editor's structure ahead of the write) reads the sheet as is.
    expect((await caller.courseMap.resolveSheet({ seq: sheet, variantKey: "ZZ" })).variantKey).toBeNull();
    // A course without variants ignores the key.
    const short = (await ctx.db.courseMap.findFirstOrThrow({ where: { eventId: ctx.eventId, course: { seq: shortSeq } } })).seq;
    expect((await caller.courseMap.resolveSheet({ seq: short, variantKey: "AB" })).variantKey).toBeNull();
  });

  it("courseMap.list validates a root's sheet per variant: an outside control names its key", async () => {
    const row = await ctx.db.courseMap.findFirstOrThrow({ where: { eventId: ctx.eventId, course: { seq: long.id } } });
    expect((await caller.courseMap.list()).find((m) => m.seq === row.seq)?.validation.valid).toBe(true);
    // 33 is only on the petal B: far away, it leaves the window of both variants (both visit it).
    const c33 = await ctx.db.control.findFirstOrThrow({ where: { eventId: ctx.eventId, codes: "33" } });
    await ctx.db.control.update({ where: { id: c33.id }, data: { xpos: 900, ypos: 900 } });
    await ctx.db.courseMap.update({ where: { id: row.id }, data: { windowCenter: { x: -75, y: 5 } } });
    try {
      const issues = (await caller.courseMap.list()).find((m) => m.seq === row.seq)!.validation.issues;
      expect(issues.filter((i) => i.code === "control_outside_frame").map((i) => i.variantKey)).toEqual(["AB", "BA"]);
    } finally {
      await ctx.db.control.update({ where: { id: c33.id }, data: { xpos: -65, ypos: 15 } });
      await ctx.db.courseMap.update({ where: { id: row.id }, data: { windowCenter: Prisma.DbNull } });
    }
  });

  it("refuses what it cannot print (400 with the reason)", async () => {
    const cases: [string, RegExp][] = [
      [`?variants=${long.id}:ZZ`, /Unknown variant: ZZ/],
      [`?variants=${shortSeq}:A`, /no variations/],
      [`?variants=${long.id}`, /variants must be/],
      [`?allVariations=${shortSeq}`, /no variations/],
      [`?allVariations=${long.key("AB")}`, /no variations/],
      [`?courses=${long.id}&variants=${long.id}:AB`, /Use one of/],
      [`?courses=${long.id}&copies=all`, /copies must be runners/],
      [`?courses=${long.id}&spare=2`, /spare needs copies=runners/],
      [`?courses=${long.id}&copies=runners&spare=-1`, /spare must be/],
      [`?allVariations=${long.id}&copies=runners`, /copies=runners needs/],
      ["?copies=runners", /copies=runners needs/],
    ];
    for (const [query, error] of cases) {
      const res = await get(query);
      expect(res.statusCode, query).toBe(400);
      expect(res.json().error, query).toMatch(error);
    }
  });
});

describe("the all-variations page numbers an equal fork (F15; course-print.md §4.6)", () => {
  it("?allVariations=<root> of S 31 [32 | 33] 34 F: labels by number, the block rows 1, 2, 2, 3; the butterfly page above stays codes", async () => {
    const { id } = await caller.course.create({ name: "Fork" });
    await caller.course.setStructure({
      courseId: id,
      structure: {
        version: 1,
        id: "f",
        orderMode: "ordered",
        items: [ctl(S), ctl(site[31]), { kind: "variation", id: "g", alternatives: [{ label: "A", items: [ctl(site[32])] }, { label: "B", items: [ctl(site[33])] }] }, ctl(site[34]), ctl(F)],
      },
    });
    await caller.layout.autoSheets({});
    const res = await get(`?allVariations=${id}`);
    expect(res.statusCode).toBe(200);
    const pages = await selectPrintPages(ctx.db, ctx.eventId, { allVariations: String(id) });
    const c = await context();
    const sheet = sheetForMapRow(pages[0].row, c);
    const idOf = (code: string) => c.allControls.find((x) => x.codes === code)!.id;
    expect(sheet.course.viewOptions.labels).toEqual({ [idOf("31")]: "1", [idOf("32")]: "2", [idOf("33")]: "2", [idOf("34")]: "3" });
    expect(sheet.course.viewOptions.labelMode).toBe("code");
    expect("allVariations" in sheet.course.viewOptions).toBe(false);
    const structures = sheet.course.structure as readonly { tint?: string }[];
    expect(structures.some((s) => s.tint)).toBe(false);
    expect(sheet.description?.rows.filter((r) => r.kind === "control").map((r) => [r.sequence, r.code])).toEqual([[1, "31"], [2, "32"], [2, "33"], [3, "34"]]);

    // An unequal fork keeps codes: no labels, rows without numbers.
    await caller.course.setStructure({
      courseId: id,
      structure: {
        version: 1,
        id: "f",
        orderMode: "ordered",
        items: [ctl(S), ctl(site[31]), { kind: "variation", id: "g", alternatives: [{ label: "A", items: [ctl(site[32])] }, { label: "B", items: [ctl(site[33]), ctl(site[34])] }] }, ctl(site[34]), ctl(F)],
      },
    });
    const unequal = sheetForMapRow((await selectPrintPages(ctx.db, ctx.eventId, { allVariations: String(id) }))[0].row, c);
    expect("labels" in unequal.course.viewOptions).toBe(false);
    expect(unequal.description?.rows.filter((r) => r.kind === "control").map((r) => r.sequence)).toEqual([undefined, undefined, undefined, undefined]);
  }, 90_000);
});
