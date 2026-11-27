/**
 * Course import safety (review package 17, decision D3; course-layer.md
 * §6.4 "Import semantics"):
 *
 *   - a matched control keeps its status, extra codes and name in both modes (CRS-001)
 *   - an empty / map-only file is refused before anything is written (CRS-005)
 *   - the import is one transaction: a failure after the Replace-all wipe
 *     leaves the event as it was and journals nothing (EVT-05, API-05, MC-38, DB-16, CRS-022)
 *   - a live row is matched before a removed one with the same code (CRS-021)
 *   - a file without lengths keeps the stored length (CRS-032)
 *   - duplicate ids and a class mapped twice are refused (CRS-060)
 *   - preview consequences equal what the import does; the journal entry
 *     reproduces the state on a peer
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestEvent, disconnect, type TestEventContext } from "../helpers/test-db.js";
import { makeCaller } from "../helpers/caller.js";

const failure = vi.hoisted(() => ({ journal: false }));
vi.mock("../../journalEmit.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../journalEmit.js")>();
  return {
    ...actual,
    appendJournal: (async (...args: Parameters<typeof actual.appendJournal>) => {
      if (failure.journal && (args[1] as { type?: string }).type === "reference.imported") throw new Error("injected journal failure");
      return actual.appendJournal(...args);
    }) as typeof actual.appendJournal,
  };
});

let ctx: TestEventContext;
let caller: ReturnType<typeof makeCaller>;

const ctlXml = (id: string, x: number, type = "Control") =>
  `<Control type="${type}"><Id>${id}</Id><MapPosition x="${x}" y="10"/></Control>`;
const courseXml = (name: string, codes: string[], length?: number) => `
    <Course>
      <Name>${name}</Name>${length ? `<Length>${length}</Length>` : ""}
      <CourseControl type="Start"><Control>S1</Control></CourseControl>
      ${codes.map((c) => `<CourseControl type="Control"><Control>${c}</Control></CourseControl>`).join("")}
      <CourseControl type="Finish"><Control>F1</Control></CourseControl>
    </Course>`;
const file = (controls: string[], courses: string[], extra = "") => `<?xml version="1.0" encoding="UTF-8"?>
<CourseData xmlns="http://www.orienteering.org/datastandard/3.0" iofVersion="3.0">
  <RaceCourseData>
    <Map><Scale>10000</Scale></Map>
    ${ctlXml("S1", 0, "Start")}
    ${controls.map((c, i) => ctlXml(c, 10 + i * 10)).join("")}
    ${ctlXml("F1", 90, "Finish")}
    ${courses.join("")}
    ${extra}
  </RaceCourseData>
</CourseData>`;
const BASE = file(["31", "32", "33"], [courseXml("A", ["31", "32"], 3000), courseXml("B", ["32", "33"], 2000)]);

const live = (model: "course" | "control") =>
  (ctx.db[model] as unknown as { findMany(a: unknown): Promise<Array<{ id: string; name: string; codes?: string; status?: string; removed: boolean; lengthM?: number; legs?: string; lengthSource?: string | null }>> }).findMany({
    where: { eventId: ctx.eventId, removed: false },
    orderBy: { seq: "asc" },
  });
const control = (code: string) => ctx.db.control.findFirstOrThrow({ where: { eventId: ctx.eventId, codes: { startsWith: code }, removed: false } });
const importEntries = () => ctx.db.journalEntry.count({ where: { eventId: ctx.eventId, type: "reference.imported" } });

beforeEach(async () => {
  ctx = await createTestEvent("course_import_safety");
  caller = makeCaller(ctx.event);
  failure.journal = false;
});
afterEach(async () => {
  await ctx.cleanup();
});
afterAll(async () => {
  await disconnect();
});

describe("a matched control keeps what the organiser set (CRS-001)", () => {
  for (const replaceAll of [false, true]) {
    it(`status, extra codes and name survive a re-import (replaceAll: ${replaceAll})`, async () => {
      await caller.course.importCourses({ xmlContent: BASE });
      const c31 = await control("31");
      await ctx.db.control.update({ where: { id: c31.id }, data: { status: "bad", codes: "31;131", name: "Big stone" } });
      const result = await caller.course.importCourses({ xmlContent: BASE, replaceAll });
      const after = await ctx.db.control.findUniqueOrThrow({ where: { id: c31.id } });
      expect([after.status, after.codes, after.name, after.removed]).toEqual(["bad", "31;131", "Big stone", false]);
      expect(result.controlsCreated).toBe(0);
      expect(result.coursesCreated).toBe(0);
    });
  }
});

describe("refusals before any write", () => {
  it("an empty or map-only file under Replace all leaves courses, controls and class links (CRS-005)", async () => {
    await caller.course.importCourses({ xmlContent: BASE });
    const cls = await caller.class.create({ name: "H21", courseId: (await caller.course.list()).find((c) => c.name === "A")!.id });
    const before = [await live("course"), await live("control")];
    const empty = file(["31"], []);
    await expect(caller.course.previewImport({ xmlContent: empty })).resolves.toMatchObject({
      blockers: { replaceAll: [{ code: "no_courses" }], merge: [] },
    });
    await expect(caller.course.importCourses({ xmlContent: empty, replaceAll: true })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(caller.course.importCourses({ ocdBase64: Buffer.from("not an ocad file").toString("base64"), replaceAll: true })).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "Not an OCAD file",
    });
    expect([await live("course"), await live("control")]).toEqual(before);
    const clsRow = await ctx.db.class.findFirstOrThrow({ where: { eventId: ctx.eventId, seq: cls.id } });
    expect(clsRow.courseId).not.toBeNull();
  });

  it("a file with several races is refused (BAD_REQUEST, not a server error)", async () => {
    const two = BASE.replace("</CourseData>", BASE.slice(BASE.indexOf("<RaceCourseData>"), BASE.indexOf("</CourseData>")) + "</CourseData>");
    await expect(caller.course.previewImport({ xmlContent: two })).rejects.toMatchObject({ code: "BAD_REQUEST", message: "The file holds 2 races; export one race per file" });
  });

  it("duplicate control ids and course names are refused, naming the id (CRS-060)", async () => {
    const dupControl = file(["31", "31"], [courseXml("A", ["31"])]);
    await expect(caller.course.importCourses({ xmlContent: dupControl })).rejects.toMatchObject({ code: "BAD_REQUEST", message: "The file lists control 31 more than once" });
    const dupCourse = file(["31"], [courseXml("A", ["31"]), courseXml("a", ["31"])]);
    await expect(caller.course.importCourses({ xmlContent: dupCourse })).rejects.toMatchObject({ message: "The file lists course A more than once" });
    expect(await live("course")).toEqual([]);
    expect(await live("control")).toEqual([]);
  });

  it("a class mapped to two courses is refused", async () => {
    const cls = await caller.class.create({ name: "H21" });
    await expect(caller.course.importCourses({ xmlContent: BASE, classMapping: { A: [cls.id], B: [cls.id] } })).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "Class H21 is mapped to several courses: A, B",
    });
    expect(await live("course")).toEqual([]);
  });
});

describe("one transaction (EVT-05)", () => {
  it("a failure after the Replace-all wipe leaves the event as it was and journals nothing", async () => {
    await caller.course.importCourses({ xmlContent: BASE });
    const cls = await caller.class.create({ name: "H21", courseId: (await caller.course.list()).find((c) => c.name === "B")!.id });
    const before = [await live("course"), await live("control")];
    const entries = await importEntries();
    failure.journal = true;
    const other = file(["41"], [courseXml("C", ["41"])]);
    await expect(caller.course.importCourses({ xmlContent: other, replaceAll: true })).rejects.toThrow("injected journal failure");
    expect([await live("course"), await live("control")]).toEqual(before);
    expect((await ctx.db.class.findFirstOrThrow({ where: { eventId: ctx.eventId, seq: cls.id } })).courseId).not.toBeNull();
    expect(await importEntries()).toBe(entries);
  });
});

describe("matching", () => {
  it("prefers a live control over a removed one with the same code (CRS-021)", async () => {
    const removed = await ctx.db.control.create({ data: { eventId: ctx.eventId, seq: 900, codes: "31", removed: true } });
    await caller.control.create({ codes: "31", xpos: 1, ypos: 1 });
    await caller.course.importCourses({ xmlContent: BASE });
    expect((await ctx.db.control.findMany({ where: { eventId: ctx.eventId, codes: "31", removed: false } })).length).toBe(1);
    expect((await ctx.db.control.findUniqueOrThrow({ where: { id: removed.id } })).removed).toBe(true);
  });
});

describe("lengths (CRS-032)", () => {
  it("a file without lengths keeps the stored length and its provenance; a new course gets a derived one", async () => {
    await caller.course.importCourses({ xmlContent: BASE });
    const a = (await live("course")).find((c) => c.name === "A")!;
    expect([a.lengthM, a.lengthSource]).toEqual([3000, "file"]);
    const noLengths = file(["31", "32", "33"], [courseXml("A", ["31", "32"]), courseXml("N", ["31", "33"])]);
    const preview = await caller.course.previewImport({ xmlContent: noLengths });
    expect(preview.consequences.merge.coursesKeepingLength).toEqual(["A"]);
    expect(preview.consequences.merge.coursesLengthDerived).toEqual(["N"]);
    await caller.course.importCourses({ xmlContent: noLengths });
    const after = (await live("course")).find((c) => c.name === "A")!;
    expect([after.lengthM, after.lengthSource]).toEqual([3000, "file"]);
  });
});

describe("preview and import agree", () => {
  it("Replace all removes what the file does not carry, unassigns only classes on removed courses, and says so first", async () => {
    await caller.course.importCourses({ xmlContent: BASE });
    const list = await caller.course.list();
    const onA = await caller.class.create({ name: "H21", courseId: list.find((c) => c.name === "A")!.id });
    const onB = await caller.class.create({ name: "D21", courseId: list.find((c) => c.name === "B")!.id });
    const next = file(["31", "32"], [courseXml("A", ["31", "32"], 3100)]);
    const preview = await caller.course.previewImport({ xmlContent: next });
    const c = preview.consequences.replaceAll;
    expect(c.coursesRemoved).toEqual(["B"]);
    expect(c.controlsRemoved).toEqual(["33"]);
    expect(c.classesUnassigned).toEqual([{ seq: onB.id, name: "D21", courseName: "B" }]);
    expect(c.coursesLengthChanged).toEqual([{ name: "A", fromM: 3000, toM: 3100 }]);
    expect(preview.consequences.merge.coursesRemoved).toEqual([]);

    const result = await caller.course.importCourses({ xmlContent: next, replaceAll: true });
    expect(result.coursesRemoved).toEqual(["B"]);
    expect(result.controlsRemoved).toBe(1);
    expect(result.classesUnassigned).toBe(1);
    expect([result.coursesCreated, result.coursesUpdated]).toEqual([0, 1]);
    expect((await live("course")).map((x) => x.name)).toEqual(["A"]);
    const classes = await ctx.db.class.findMany({ where: { eventId: ctx.eventId }, orderBy: { seq: "asc" } });
    expect(classes.find((x) => x.seq === onA.id)!.courseId).not.toBeNull();
    expect(classes.find((x) => x.seq === onB.id)!.courseId).toBeNull();

    // A peer applying the entry under its Replace-all mirror keeps H21 on A.
    const entry = await ctx.db.journalEntry.findFirstOrThrow({ where: { eventId: ctx.eventId, type: "reference.imported" }, orderBy: { hlc: "desc" } });
    const payload = entry.payload as { replaceAll: boolean; classes: Array<{ id: string }> };
    expect(payload.replaceAll).toBe(true);
    expect(payload.classes.map((x) => x.id)).toContain(classes.find((x) => x.seq === onA.id)!.id);
  });

  it("a substring class match is shown but not pre-selected", async () => {
    await caller.class.create({ name: "D10" });
    const preview = await caller.course.previewImport({
      xmlContent: file(["31"], [courseXml("D1", ["31"])]),
    });
    const [match] = preview.courses[0].classMatches;
    expect([match.dbClassName, match.matchType, match.preselect]).toEqual(["D10", "substring", false]);
  });
});

describe("review follow-ups (package 17)", () => {
  it("is refused while the event is checked out to another node, and writes nothing", async () => {
    await ctx.db.eventLease.create({ data: { eventId: ctx.eventId, holderNodeId: "box-elsewhere" } });
    await expect(caller.course.importCourses({ xmlContent: BASE })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(await live("course")).toEqual([]);
  });

  it("restores a removed two-code site once when the file carries both codes", async () => {
    const site = await ctx.db.control.create({ data: { eventId: ctx.eventId, seq: 901, codes: "31;131", removed: true } });
    await caller.course.importCourses({ xmlContent: file(["31", "131"], [courseXml("A", ["31", "131"])]) });
    const after = await ctx.db.control.findUniqueOrThrow({ where: { id: site.id } });
    expect([after.removed, after.codes]).toEqual([false, "31;131"]);
  });

  it("under Replace all a start the file does not carry frees its code", async () => {
    await ctx.db.control.create({ data: { eventId: ctx.eventId, seq: 902, name: "Start 3", kind: "start", status: "start", codes: "5" } });
    const xml = file(["5"], [courseXml("A", ["5"])]);
    await expect(caller.course.importCourses({ xmlContent: xml })).rejects.toMatchObject({ message: "Control code 5 is held by Start 3" });
    await caller.course.importCourses({ xmlContent: xml, replaceAll: true });
    expect((await live("control")).some((c) => c.codes === "5")).toBe(true);
  });

  it("counts a class the mapping puts back as not unassigned", async () => {
    await caller.course.importCourses({ xmlContent: BASE });
    const onB = await caller.class.create({ name: "D21", courseId: (await caller.course.list()).find((c) => c.name === "B")!.id });
    const result = await caller.course.importCourses({ xmlContent: file(["31", "32"], [courseXml("A", ["31", "32"])]), replaceAll: true, classMapping: { A: [onB.id] } });
    expect(result.classesUnassigned).toBe(0);
  });

  it("a restored site drops an extra code another restored row claims, or a live start holds", async () => {
    const older = await ctx.db.control.create({ data: { eventId: ctx.eventId, seq: 903, codes: "31;45;5", removed: true, updatedAt: new Date("2026-01-01") } });
    const newer = await ctx.db.control.create({ data: { eventId: ctx.eventId, seq: 904, codes: "45", removed: true, updatedAt: new Date("2026-06-01") } });
    await ctx.db.control.create({ data: { eventId: ctx.eventId, seq: 905, name: "Start 4", kind: "start", status: "start", codes: "5" } });
    await caller.course.importCourses({ xmlContent: file(["31", "45"], [courseXml("A", ["31", "45"])]) });
    expect((await ctx.db.control.findUniqueOrThrow({ where: { id: older.id } })).codes).toBe("31");
    expect((await ctx.db.control.findUniqueOrThrow({ where: { id: newer.id } })).codes).toBe("45");
  });
});
