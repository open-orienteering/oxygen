/**
 * Course-map pages through the composer, end to end on the database
 * (docs/course-print.md §4–7): the E2E fixture map (`e2e/test.ocd`)
 * imported and pinned on a `vector` event, a template, a course and an
 * all-controls sheet, rendered by `renderCoursePages` — the function the
 * `maps.pdf` route will call (C3). Structural assertions with pdf-lib;
 * `qpdf --check` and the rasterised comparison are C3's.
 */

import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFRawStream, PDFRef, decodePDFRawStream } from "pdf-lib";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { defaultMapAppearance } from "@oxygen/shared";
import { applyEventMap } from "../../event-map.js";
import { clearCourseMapSourceCache } from "../../course-maps/map-source.js";
import { loadPinnedPrintDocument, renderCoursePages, sheetForMapRow, type PrintMapRow } from "../../course-maps/pdf-page.js";
import { createTestEvent, disconnect, type TestEventContext } from "../helpers/test-db.js";

const fixture = resolve(__dirname, "../../../../../e2e/test.ocd");
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 10"><rect width="20" height="10" fill="#c00"/></svg>');

let vec: TestEventContext;
let legacy: TestEventContext;
let rows: PrintMapRow[];
let pngId: number;
let svgId: number;

beforeAll(async () => {
  vec = await createTestEvent("course_print");
  legacy = await createTestEvent("course_print_legacy");
  // Per-run trailer: content-addressed rows are global (see map-documents.test.ts).
  const bytes = Buffer.concat([readFileSync(fixture), Buffer.from(`print-${randomBytes(4).toString("hex")}`)]);
  const applied = await applyEventMap(vec.db, vec.eventId, "test.ocd", bytes);
  expect(applied.documentHash).toMatch(/^[0-9a-f]{64}$/);
  await vec.db.event.update({ where: { id: vec.eventId }, data: { mapPipeline: "vector" } });
  await applyEventMap(legacy.db, legacy.eventId, "test.ocd", bytes);
  clearCourseMapSourceCache();

  const db = vec.db;
  const PNG = await sharp({ create: { width: 4, height: 2, channels: 4, background: "#00a000" } }).png().toBuffer();
  const mk = (codes: string, xpos: number, ypos: number, extra: Record<string, unknown> = {}) => db.control.create({ data: { eventId: vec.eventId, codes, xpos, ypos, ...extra } });
  const c31 = await mk("31", -80, 0, { description: { d: "2.004" } });
  const c32 = await mk("32", -60, 15);
  const c33 = await mk("33", -45, -5, { description: { d: "1.010", s: "1,5" } });
  await mk("", -95, -10, { status: "start" });
  pngId = Number((await db.graphic.create({ data: { eventId: vec.eventId, name: "logo.png", mime: "image/png", data: PNG, sizeBytes: PNG.length } })).id);
  svgId = Number((await db.graphic.create({ data: { eventId: vec.eventId, name: "logo.svg", mime: "image/svg+xml", data: SVG, sizeBytes: SVG.length } })).id);
  const template = await db.mapTemplate.create({
    data: {
      eventId: vec.eventId,
      name: "A4",
      printScale: 7500,
      settings: {
        printMarginMm: 3,
        mapFrame: { x: 8, y: 8, width: 194, height: 281 },
        description: { visible: true, x: 150, y: 12, cellSizeMm: 6 },
        appearance: defaultMapAppearance,
      },
      objects: [
        { id: "title", anchor: "page", kind: "text", x: 12, y: 284, text: "{event} · {course}", fontSizeMm: 5, color: "#000000" },
        { id: "logo", anchor: "page", kind: "image", graphicId: pngId, x: 12, y: 260, width: 20, height: 10 },
        { id: "svg", anchor: "page", kind: "image", graphicId: svgId, x: 40, y: 260, width: 20, height: 10 },
      ],
    },
  });
  const course = await db.course.create({
    data: {
      eventId: vec.eventId,
      name: "Blå",
      lengthM: 2300,
      climbM: 45,
      courseControls: { create: [{ position: 1, controlId: c31.id }, { position: 2, controlId: c32.id, labelDx: 0, labelDy: 6 }, { position: 3, controlId: c33.id }] },
    },
  });
  await db.courseMap.create({ data: { eventId: vec.eventId, name: "Blå karta", kind: "course", courseId: course.id, templateId: template.id, windowCenter: { x: -70, y: 5 } } });
  await db.courseMap.create({ data: { eventId: vec.eventId, name: "Alla kontroller", kind: "all_controls", templateId: template.id, windowCenter: { x: -70, y: 5 }, sortOrder: 1 } });
  rows = (await db.courseMap.findMany({
    where: { eventId: vec.eventId },
    include: { template: true, course: { include: { classes: { select: { name: true } }, courseControls: { orderBy: { position: "asc" }, include: { control: true } } } } },
    orderBy: [{ sortOrder: "asc" }],
  })) as unknown as PrintMapRow[];
}, 90_000);

afterAll(async () => {
  await vec?.cleanup();
  await legacy?.cleanup();
  await disconnect();
});

async function build(mode: "cmyk" | "rgb" = "cmyk") {
  const pinned = await loadPinnedPrintDocument(vec.db, vec.eventId);
  if (!pinned) throw new Error("no pinned document");
  const event = await vec.db.event.findUniqueOrThrow({ where: { id: vec.eventId } });
  const allControls = await vec.db.control.findMany({ where: { eventId: vec.eventId, removed: false } });
  const sheets = rows.map((row) => sheetForMapRow(row, { event: { name: event.name, date: event.date }, allControls, mapInfo: pinned.info }));
  const graphics = new Map((await vec.db.graphic.findMany({ where: { eventId: vec.eventId } })).map((g) => [Number(g.id), { mime: g.mime, data: new Uint8Array(g.data) }]));
  return renderCoursePages({ document: pinned.document, rotationCorrectionDeg: pinned.rotationCorrectionDeg, sheets, graphics, mode, deterministic: true, info: { title: `${event.name} maps` } });
}

const lookup = <T>(doc: PDFDocument, o: unknown): T => (o instanceof PDFRef ? doc.context.lookup(o) : o) as T;

describe("course pages from the pinned document", () => {
  it("only a vector event with a pin has a print document", async () => {
    expect(await loadPinnedPrintDocument(legacy.db, legacy.eventId)).toBeNull();
    expect(await loadPinnedPrintDocument(vec.db, vec.eventId)).not.toBeNull();
  });

  it("one document, one A4 page per sheet, TrimBox = MediaBox, labels and outlines per sheet", async () => {
    const out = await build();
    expect(out.pageCount).toBe(2);
    expect(out.warnings.filter((w) => !w.includes("NO_FONT"))).toEqual([]);
    const doc = await PDFDocument.load(out.bytes);
    expect(doc.getPageCount()).toBe(2);
    for (const page of doc.getPages()) {
      const { width, height } = page.getSize();
      expect(width).toBeCloseTo(595.276, 2);
      expect(height).toBeCloseTo(841.89, 2);
      expect(page.node.lookup(PDFName.of("TrimBox"), PDFArray).asArray().map((n) => (n as PDFNumber).asNumber())).toEqual([0, 0, width, height].map((v) => expect.closeTo(v, 2)));
    }
    expect(doc.getTitle()).toMatch(/maps$/);
    expect(doc.getCreator()).toBe("Oxygen");
    const nums = doc.catalog.lookup(PDFName.of("PageLabels"), PDFDict).lookup(PDFName.of("Nums"), PDFArray);
    expect(nums.size()).toBe(4);
    expect(doc.catalog.lookup(PDFName.of("Outlines"), PDFDict).lookup(PDFName.of("Count"), PDFNumber).asNumber()).toBe(2);
  }, 60_000);

  it("fonts: one Type0 / CIDFontType2 subset per face, shared by both pages", async () => {
    const doc = await PDFDocument.load((await build()).bytes);
    const fontsOf = (i: number) => doc.getPage(i).node.Resources()!.lookup(PDFName.of("Font"), PDFDict);
    const f0 = fontsOf(0), f1 = fontsOf(1);
    expect(f0.entries().map(([k, v]) => `${k}=${v}`).sort()).toEqual(f1.entries().map(([k, v]) => `${k}=${v}`).sort());
    const type0 = lookup<PDFDict>(doc, f0.entries()[0][1]);
    expect(type0.get(PDFName.of("Subtype"))).toEqual(PDFName.of("Type0"));
    const cid = lookup<PDFDict>(doc, type0.lookup(PDFName.of("DescendantFonts"), PDFArray).get(0));
    expect(cid.get(PDFName.of("Subtype"))).toEqual(PDFName.of("CIDFontType2"));
  }, 60_000);

  it("map layer under T_map clipped to the frame; course purple in the stack's CMYK; no rg in cmyk", async () => {
    const doc = await PDFDocument.load((await build()).bytes);
    const c = doc.getPage(0).node.Contents();
    const streams = c instanceof PDFArray ? c.asArray().map((r) => lookup<PDFRawStream>(doc, r)) : [lookup<PDFRawStream>(doc, c)];
    const ops = streams.map((s) => new TextDecoder().decode(decodePDFRawStream(s).decode())).join("\n");
    expect(ops).toContain("22.677 22.677 549.921 796.535 re W n");
    // 1:7 500 map printed at 1:7 500: scale 1 × µm → pt.
    expect(ops).toMatch(/0\.002834646 0 0 0\.002834646 [\d.]+ [\d.]+ cm/);
    expect(ops).not.toMatch(/ (rg|RG)\b/);
    expect(ops).toMatch(/\/F\d+ [\d.]+ Tf/);
    expect(ops).toMatch(/\/Im\d+ Do/);
  }, 60_000);

  it("images: the PNG logo and the rasterised SVG logo are image XObjects shared by the pages", async () => {
    const doc = await PDFDocument.load((await build()).bytes);
    const xo = [0, 1].map((i) => doc.getPage(i).node.Resources()!.lookup(PDFName.of("XObject"), PDFDict));
    const images = xo[0].entries().filter(([, v]) => lookup<PDFRawStream>(doc, v).dict.get(PDFName.of("Subtype")) === PDFName.of("Image"));
    expect(images.length).toBeGreaterThanOrEqual(2);
    for (const [k, v] of images) expect(xo[1].get(k)).toEqual(v);
    // The SVG logo at 600 dpi of 20 × 10 mm.
    const sizes = images.map(([, v]) => lookup<PDFRawStream>(doc, v).dict.lookup(PDFName.of("Width"), PDFNumber).asNumber());
    expect(sizes).toContain(Math.round((20 / 25.4) * 600));
  }, 60_000);

  it("/Measure /GEO: the fixture's SWEREF99 TM georeference gives frame corners near 58.6° N 15° E", async () => {
    const doc = await PDFDocument.load((await build()).bytes);
    const vp = doc.getPage(0).node.lookup(PDFName.of("VP"), PDFArray).lookup(0, PDFDict);
    const m = vp.lookup(PDFName.of("Measure"), PDFDict);
    expect(m.get(PDFName.of("Subtype"))).toEqual(PDFName.of("GEO"));
    const gpts = m.lookup(PDFName.of("GPTS"), PDFArray).asArray().map((n) => (n as PDFNumber).asNumber());
    expect(gpts).toHaveLength(8);
    for (let i = 0; i < 8; i += 2) {
      expect(gpts[i]).toBeGreaterThan(55);
      expect(gpts[i]).toBeLessThan(70);
      expect(gpts[i + 1]).toBeGreaterThan(10);
      expect(gpts[i + 1]).toBeLessThan(25);
    }
  }, 60_000);

  it("deterministic: equal sheets give equal bytes; rgb differs from cmyk", async () => {
    const a = await build(), b = await build(), rgb = await build("rgb");
    expect(Buffer.from(a.bytes).equals(Buffer.from(b.bytes))).toBe(true);
    expect(Buffer.from(a.bytes).equals(Buffer.from(rgb.bytes))).toBe(false);
  }, 90_000);
});
