/**
 * Templates by key, auto sheets, class overrides, `maps.pdf?classes=` and
 * the sheet / template version tokens (docs/course-layout.md §2, §5–§7;
 * slice D, row D8).
 */

import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { PDFDocument } from "pdf-lib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { defaultMapAppearance, versionConflictOf } from "@oxygen/shared";
import { registerCourseMapRoutes } from "../../course-maps/routes.js";
import { createTestEvent, disconnect, type TestEventContext } from "../helpers/test-db.js";
import { makeCaller } from "../helpers/caller.js";
import { applyEventMap } from "../../event-map.js";
import { clearCourseMapSourceCache } from "../../course-maps/map-source.js";
import { classUpsertPayload } from "../../referenceJournal.js";

const fixture = resolve(__dirname, "../../../../../e2e/test.ocd");
const migration = readFileSync(resolve(__dirname, "../../../prisma/migrations/20261103120000_auto_templates/migration.sql"), "utf8");

const settings = {
  printMarginMm: 3,
  mapFrame: { x: 8, y: 8, width: 194, height: 281 },
  description: { visible: true, x: 150, y: 12, cellSizeMm: 6 },
  appearance: defaultMapAppearance,
};

let server: FastifyInstance;
const convertedSvgs: string[] = [];

beforeAll(async () => {
  const fakeConverter = {
    async convert(svg: string) {
      convertedSvgs.push(svg);
      const pdf = await PDFDocument.create();
      pdf.addPage([595.28, 841.89]);
      return Buffer.from(await pdf.save());
    },
  };
  server = Fastify({ logger: false });
  registerCourseMapRoutes(server, { converter: fakeConverter });
  await server.ready();
});

afterAll(async () => {
  await server.close();
  await disconnect();
});

async function errorOf(p: Promise<unknown>): Promise<{ code?: string; cause?: unknown; message: string }> {
  try {
    await p;
  } catch (e) {
    return e as { code?: string; cause?: unknown; message: string };
  }
  throw new Error("expected a rejection");
}

/** A course of four controls around (0, 0), extent 60 × 20 mm on the map. */
async function seedCourse(t: TestEventContext, name: string, spread = 1) {
  const mk = (codes: string, xpos: number, ypos: number, status?: string) =>
    t.db.control.create({ data: { eventId: t.eventId, codes, xpos: xpos * spread, ypos: ypos * spread, ...(status ? { status } : {}) } });
  const a = await mk(`${name}1`, -30, 0);
  const b = await mk(`${name}2`, 30, 10);
  const c = await mk(`${name}3`, 0, -10);
  return t.db.course.create({
    data: {
      eventId: t.eventId,
      name,
      lengthM: 1500,
      climbM: 10,
      courseControls: { create: [a, b, c].map((ctl, i) => ({ position: i + 1, controlId: ctl.id })) },
    },
  });
}

describe("auto_key backfill — the migration's data step (09 §5, decision (3))", () => {
  let t: TestEventContext;
  beforeAll(async () => {
    t = await createTestEvent("auto_key_backfill");
  });
  afterAll(async () => {
    await t?.cleanup();
  });

  it("derives every key and marks all but the busiest (then oldest) template of a key extra; no sheet moves, no renames", async () => {
    const db = t.db;
    // Rows as an older image left them: no key; extra for now so the index allows the key write.
    const mk = (name: string, data: Record<string, unknown>, createdAt: string) =>
      db.mapTemplate.create({ data: { eventId: t.eventId, name, printScale: 10000, settings, isExtra: true, createdAt: new Date(createdAt), ...data } });
    const oldIdle = await mk("Old idle", {}, "2026-01-01T00:00:00Z");
    const busy = await mk("Busy", {}, "2026-02-01T00:00:00Z");
    const tieOld = await mk("Tie old", { orientation: "landscape" }, "2026-01-01T00:00:00Z");
    const tieNew = await mk("Tie new", { orientation: "landscape" }, "2026-03-01T00:00:00Z");
    const custom = await mk("Custom", { paper: "custom", paperWidthMm: 200, paperHeightMm: 300, printScale: 4000 }, "2026-01-01T00:00:00Z");
    const course = await seedCourse(t, "B");
    const sheets = [
      await db.courseMap.create({ data: { eventId: t.eventId, name: "s1", courseId: course.id, templateId: busy.id } }),
      await db.courseMap.create({ data: { eventId: t.eventId, name: "s2", courseId: course.id, templateId: busy.id } }),
      await db.courseMap.create({ data: { eventId: t.eventId, name: "s3", courseId: course.id, templateId: oldIdle.id } }),
    ];

    // The migration's two backfill statements, scoped to this event.
    const backfill = migration.slice(migration.indexOf("UPDATE \"oxygen\".\"map_templates\"\nSET \"auto_key\""), migration.indexOf("-- At most one auto template"));
    const statements = backfill
      .replace(/^\s*--.*$/gm, "")
      .replace('WHERE "auto_key" IS NULL;', `WHERE "auto_key" IS NULL AND "event_id" = ${t.eventId};`)
      .replace('FROM "oxygen"."map_templates" t\n)', `FROM "oxygen"."map_templates" t WHERE t."event_id" = ${t.eventId}\n)`)
      .split(";")
      .map((s) => s.trim())
      .filter(Boolean);
    expect(statements).toHaveLength(2);
    for (const sql of statements) await db.$executeRawUnsafe(sql);

    const rows = new Map((await db.mapTemplate.findMany({ where: { eventId: t.eventId } })).map((r) => [r.id, r]));
    expect(rows.get(busy.id)).toMatchObject({ autoKey: "A4-portrait-10000", isExtra: false, name: "Busy" });
    expect(rows.get(oldIdle.id)).toMatchObject({ autoKey: "A4-portrait-10000", isExtra: true, name: "Old idle" });
    expect(rows.get(tieOld.id)).toMatchObject({ autoKey: "A4-landscape-10000", isExtra: false });
    expect(rows.get(tieNew.id)).toMatchObject({ autoKey: "A4-landscape-10000", isExtra: true });
    expect(rows.get(custom.id)).toMatchObject({ autoKey: "custom200x300-portrait-4000", isExtra: false });
    const after = await db.courseMap.findMany({ where: { id: { in: sheets.map((s) => s.id) } }, orderBy: { seq: "asc" } });
    expect(after.map((s) => s.templateId)).toEqual([busy.id, busy.id, oldIdle.id]);
  });
});

describe("templates by key (course-layout.md §5)", () => {
  let t: TestEventContext;
  let caller: ReturnType<typeof makeCaller>;
  beforeAll(async () => {
    t = await createTestEvent("auto_key_writes");
    caller = makeCaller(t.event);
  });
  afterAll(async () => {
    await t?.cleanup();
  });

  it("a write keeps the key; a second template of a key is extra; a duplicate is extra; a key change and a delete promote", async () => {
    const base = { paper: "A4" as const, orientation: "portrait" as const, printScale: 7500, settings, objects: [] };
    const first = await caller.mapTemplate.create({ name: "Club A4", ...base });
    expect(first).toMatchObject({ autoKey: "A4-portrait-7500", isExtra: false });
    const second = await caller.mapTemplate.create({ name: "Other A4", ...base });
    expect(second).toMatchObject({ autoKey: "A4-portrait-7500", isExtra: true });
    const copy = await caller.mapTemplate.duplicate({ id: first.seq, name: "Copy" });
    expect(copy).toMatchObject({ autoKey: "A4-portrait-7500", isExtra: true });

    // The auto template moves to another key: it is that key's auto, and its old key promotes the busiest extra.
    const course = await seedCourse(t, "K");
    await caller.mapTemplate.applyToCourses({ templateId: copy.seq, courseIds: [course.seq] });
    const moved = await caller.mapTemplate.update({ id: first.seq, printScale: 10000 });
    expect(moved).toMatchObject({ autoKey: "A4-portrait-10000", isExtra: false, name: "Club A4" });
    let list = await caller.mapTemplate.list();
    const bySeq = (seq: number) => list.find((r) => r.seq === seq)!;
    expect(bySeq(copy.seq)).toMatchObject({ isExtra: false, sheetCount: 1 });
    expect(bySeq(second.seq)).toMatchObject({ isExtra: true });

    // Moving onto a key that has its auto template makes the moved one extra.
    const back = await caller.mapTemplate.update({ id: first.seq, printScale: 7500 });
    expect(back).toMatchObject({ autoKey: "A4-portrait-7500", isExtra: true });

    // Deleting the auto template promotes one of its extras (oldest of the idle ones).
    await caller.mapTemplate.delete({ id: copy.seq });
    list = await caller.mapTemplate.list();
    const autos = list.filter((r) => r.autoKey === "A4-portrait-7500" && !r.isExtra);
    expect(autos.map((r) => r.seq)).toEqual([second.seq < first.seq ? second.seq : first.seq]);
  });
});

describe("autoSheets and class overrides (course-layout.md §6)", () => {
  let t: TestEventContext;
  let caller: ReturnType<typeof makeCaller>;
  let course: { id: string; seq: number };
  let wide: { id: string; seq: number };
  let h21: { id: string; seq: number };
  let d21: { id: string; seq: number };

  beforeAll(async () => {
    t = await createTestEvent("auto_sheets");
    caller = makeCaller(t.event);
    await t.db.mapFile.create({ data: { eventId: t.eventId, fileName: "test.ocd", fileData: readFileSync(fixture), scale: 7500 } });
    clearCourseMapSourceCache();
    course = await seedCourse(t, "Blå");
    // 252 mm wide at the map's scale: only a landscape A4 frame holds it.
    wide = await seedCourse(t, "Lång", 4.2);
    h21 = await t.db.class.create({ data: { eventId: t.eventId, name: "H21", courseId: course.id } });
    d21 = await t.db.class.create({ data: { eventId: t.eventId, name: "D21", courseId: course.id } });
  });
  afterAll(async () => {
    await t?.cleanup();
  });

  it("a course without a sheet gets one on its key's auto template, centred on the course; a second call creates nothing", async () => {
    const r = await caller.layout.autoSheets({ courseId: course.seq });
    expect(r.createdSheets).toHaveLength(1);
    expect(r.createdTemplates).toHaveLength(1);
    const templates = await caller.mapTemplate.list();
    // No template yet: A4 portrait at the map's scale (the fixture's).
    const auto = templates.find((x) => x.seq === r.createdTemplates[0])!;
    expect(auto).toMatchObject({ paper: "A4", orientation: "portrait", isExtra: false });
    expect(auto.name).toBe(`A4 portrait 1:${auto.printScale}`);
    expect(auto.autoKey).toBe(`A4-portrait-${auto.printScale}`);
    const sheet = await caller.courseMap.get({ seq: r.createdSheets[0] });
    expect(sheet).toMatchObject({ kind: "course", classId: null, sectionIndex: 0, windowCenter: null, name: "Blå" });

    const again = await caller.layout.autoSheets({ courseId: course.seq });
    expect(again).toMatchObject({ createdSheets: [], createdTemplates: [], courseSheets: r.createdSheets });
  });

  it("the next course reuses the event's template look and turns the sheet when only landscape holds it", async () => {
    const first = (await caller.mapTemplate.list())[0];
    const r = await caller.layout.autoSheets({ courseId: wide.seq });
    const created = (await caller.mapTemplate.list()).find((x) => x.seq === r.createdTemplates[0])!;
    expect(created).toMatchObject({ paper: "A4", orientation: "landscape", printScale: first.printScale, autoKey: `A4-landscape-${first.printScale}` });
    expect(created.settings.printMarginMm).toBe(first.settings.printMarginMm);
    expect(created.settings.mapFrame.width).toBeGreaterThan(created.settings.mapFrame.height);
  });

  it("a class print scale gets class sheets on the auto template at that scale; the override is not journaled", async () => {
    const r = await caller.layout.setClassOverride({ classId: h21.seq, printScale: 10000 });
    expect(r?.classSheets[h21.seq]).toHaveLength(1);
    const sheet = await t.db.courseMap.findFirstOrThrow({ where: { classId: h21.id }, include: { template: true } });
    expect(sheet.template).toMatchObject({ printScale: 10000, autoKey: "A4-portrait-10000", isExtra: false });
    expect(sheet.name).toBe("Blå · H21");
    // The course's own sheet is untouched; the list says which sheet is a class's.
    const list = await caller.courseMap.list();
    expect(list.filter((m) => m.courseId === course.seq).map((m) => m.class?.name ?? null).sort()).toEqual(["H21", null]);
    const overrides = await caller.layout.classOverrides({ courseId: course.seq });
    expect(overrides.find((c) => c.seq === h21.seq)).toMatchObject({ printScale: 10000, sheetTemplateSeq: null, sheets: [sheet.seq] });
    const payload = await classUpsertPayload(t.db, h21.id);
    expect(payload.fields).not.toHaveProperty("printScale");
    expect(payload.fields).not.toHaveProperty("sheetTemplateId");
    // Idempotent.
    expect((await caller.layout.autoSheets({ courseId: course.seq })).createdSheets).toEqual([]);
  });

  it("Class view reads the class's sheet; a class without one reads its course's sheet as the class prints it", async () => {
    const own = await caller.courseMap.resolveSheet({ classSeq: h21.seq });
    expect(own.classView).toMatchObject({ classSeq: h21.seq, className: "H21", printScale: 10000, ownSheet: true });
    expect(own.template.printScale).toBe(10000);
    const plain = await caller.courseMap.resolveSheet({ classSeq: d21.seq });
    expect(plain.classView).toMatchObject({ className: "D21", ownSheet: false });
    expect(plain.sheet?.classSeq).toBeNull();
    expect(plain.page.textValues?.classes).toBe("D21");
    expect(own.page.textValues?.classes).toBe("H21");
  });

  it("an explicit template with another scale prints at the class's scale; clearing the override removes the class sheets", async () => {
    const extra = await caller.mapTemplate.create({ name: "H21 special", paper: "A4", orientation: "portrait", printScale: 7500, settings, objects: [] });
    await caller.layout.setClassOverride({ classId: h21.seq, sheetTemplateId: extra.seq });
    const sheet = await t.db.courseMap.findFirstOrThrow({ where: { classId: h21.id } });
    expect(sheet.templateId).toBe((await t.db.mapTemplate.findFirstOrThrow({ where: { eventId: t.eventId, seq: extra.seq } })).id);
    expect((sheet.overrides as { printScale?: number }).printScale).toBe(10000);

    await caller.layout.setClassOverride({ classId: h21.seq, printScale: null, sheetTemplateId: null });
    expect(await t.db.courseMap.count({ where: { classId: h21.id } })).toBe(0);
  });

  it("a class that changes course leaves its old class sheets behind on the next autoSheets", async () => {
    await caller.layout.setClassOverride({ classId: d21.seq, printScale: 10000 });
    expect(await t.db.courseMap.count({ where: { classId: d21.id, courseId: course.id } })).toBe(1);
    await t.db.class.update({ where: { id: d21.id }, data: { courseId: wide.id } });
    await caller.layout.autoSheets({ courseId: wide.seq });
    const rows = await t.db.courseMap.findMany({ where: { classId: d21.id } });
    expect(rows.map((r) => r.courseId)).toEqual([wide.id]);
  });

  it("autoSheets without a course covers every course", async () => {
    const extra = await seedCourse(t, "Grön");
    const r = await caller.layout.autoSheets({});
    expect(r.createdSheets).toHaveLength(1);
    expect(await t.db.courseMap.count({ where: { courseId: extra.id, classId: null } })).toBe(1);
  });
});

describe("sheet and template version tokens (course-layout.md §2)", () => {
  let t: TestEventContext;
  let caller: ReturnType<typeof makeCaller>;
  beforeAll(async () => {
    t = await createTestEvent("layout_versions");
    caller = makeCaller(t.event);
    await t.db.mapFile.create({ data: { eventId: t.eventId, fileName: "test.ocd", fileData: readFileSync(fixture), scale: 7500 } });
    clearCourseMapSourceCache();
  });
  afterAll(async () => {
    await t?.cleanup();
  });

  it("saveLayout and mapTemplate.update refuse a stale baseVersion with CONFLICT and the row now; no token keeps last-writer-wins", async () => {
    const course = await seedCourse(t, "V");
    const r = await caller.layout.autoSheets({ courseId: course.seq });
    const read = await caller.courseMap.resolveSheet({ seq: r.courseSheets[0] });
    const sheetBase = read.sheet!.version;
    expect(sheetBase).not.toBe("0");
    const write = { id: read.sheet!.seq, windowCenter: { x: 1, y: 2 }, printScale: read.template.printScale, description: read.template.settings.description, objects: [] };
    const ok = await caller.courseMap.saveLayout({ ...write, baseVersion: sheetBase });
    expect(BigInt(ok.version)).toBeGreaterThan(BigInt(sheetBase));
    const stale = await errorOf(caller.courseMap.saveLayout({ ...write, windowCenter: { x: 9, y: 9 }, baseVersion: sheetBase }));
    expect(stale.code).toBe("CONFLICT");
    const data = versionConflictOf((stale.cause as { data?: unknown }).data);
    expect(data).toMatchObject({ kind: "sheet", id: read.sheet!.seq, version: ok.version, differing: null });
    expect((await caller.courseMap.get({ seq: read.sheet!.seq })).windowCenter).toEqual({ x: 1, y: 2 });
    await caller.courseMap.saveLayout({ ...write, windowCenter: { x: 3, y: 3 } });
    expect((await caller.courseMap.get({ seq: read.sheet!.seq })).windowCenter).toEqual({ x: 3, y: 3 });

    const tplBase = read.template.version;
    const updated = await caller.mapTemplate.update({ id: read.template.seq, objects: [], baseVersion: tplBase });
    const staleTpl = await errorOf(caller.mapTemplate.update({ id: read.template.seq, objects: [], baseVersion: tplBase }));
    expect(staleTpl.code).toBe("CONFLICT");
    expect(versionConflictOf((staleTpl.cause as { data?: unknown }).data)).toMatchObject({ kind: "template", id: read.template.seq, version: updated.version });
  });
});

describe("maps.pdf?classes= (course-layout.md §7)", () => {
  let t: TestEventContext;
  let caller: ReturnType<typeof makeCaller>;
  let h21Seq: number;
  let d21Seq: number;
  let courseSeq: number;
  const pdfUrl = (q: string) => `/api/maps/${t.nameId}/maps.pdf${q}`;

  beforeAll(async () => {
    t = await createTestEvent("maps_pdf_classes");
    caller = makeCaller(t.event);
    const bytes = Buffer.concat([readFileSync(fixture), Buffer.from(`classes-${randomBytes(4).toString("hex")}`)]);
    await applyEventMap(t.db, t.eventId, "test.ocd", bytes);
    clearCourseMapSourceCache();
    const course = await seedCourse(t, "Röd");
    courseSeq = course.seq;
    const h21 = await t.db.class.create({ data: { eventId: t.eventId, name: "H21", courseId: course.id } });
    const d21 = await t.db.class.create({ data: { eventId: t.eventId, name: "D21", courseId: course.id } });
    h21Seq = h21.seq;
    d21Seq = d21.seq;
    await caller.layout.autoSheets({ courseId: course.seq });
    await caller.layout.setClassOverride({ classId: h21.seq, printScale: 10000 });
  }, 90_000);
  afterAll(async () => {
    await t?.cleanup();
  });

  it("`?classes=` composes one page per class; courses and all leave class sheets out", async () => {
    clearCourseMapSourceCache();
    const before = convertedSvgs.length;
    const res = await server.inject({ method: "GET", url: pdfUrl(`?classes=${h21Seq},${d21Seq}`) });
    expect(res.statusCode).toBe(200);
    expect(res.headers["x-print-pipeline"]).toBeUndefined();
    expect(convertedSvgs).toHaveLength(before);
    expect((await PDFDocument.load(res.rawPayload)).getPageCount()).toBe(2);

    const course = await server.inject({ method: "GET", url: pdfUrl(`?courses=${courseSeq}`) });
    expect((await PDFDocument.load(course.rawPayload)).getPageCount()).toBe(1);
    const all = await server.inject({ method: "GET", url: pdfUrl("") });
    expect((await PDFDocument.load(all.rawPayload)).getPageCount()).toBe(1);

    expect((await server.inject({ method: "GET", url: pdfUrl(`?classes=${h21Seq}&courses=${courseSeq}`) })).statusCode).toBe(400);
    expect((await server.inject({ method: "GET", url: pdfUrl("?classes=99999") })).statusCode).toBe(400);
  }, 60_000);
});
