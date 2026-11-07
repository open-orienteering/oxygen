/**
 * Materialised variants (slice F, row F6; docs/course-layer.md §12, research
 * 08 §4.3 "Materialisation", §7 integration row):
 *
 *   - course.setStructure with groups writes one child course per variant
 *     (name, key, linear structure, mirror, lengths), journaled one
 *     `course.upserted` per row, root first, and the classes' pools
 *   - re-materialisation: a new key, a vanished one (soft-deleted, its
 *     runners' `course_id` nulled and journaled), a returning one revived
 *   - variantList, list / detail fields, the refusals, clone, delete,
 *     control.delete, a class picking a root later, an import over a root
 *   - the migration's constraints; backup and snapshot carry the children
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import type { WireCourseStructure } from "@oxygen/shared";
import { createTestEvent, disconnect, type TestEventContext } from "../helpers/test-db.js";
import { makeCaller } from "../helpers/caller.js";
import { exportEventSnapshot, importEventSnapshot } from "../../sync/lease.js";

let ctx: TestEventContext;
let caller: ReturnType<typeof makeCaller>;
let S: number;
let F: number;

type Items = WireCourseStructure["items"];
const group = (id: string, alts: number[][], loop = false): Items[number] => ({
  kind: "variation",
  id,
  alternatives: alts.map((ids, i) => ({ label: String.fromCharCode(65 + i), items: ids.map((siteId) => ({ siteId })) })),
  ...(loop ? { loop: true } : {}),
});
const ctl = (siteId: number): Items[number] => ({ siteId });

async function write(courseId: number, items: Items, labelOffsets?: Record<string, { dx: number; dy: number }>) {
  return caller.course.setStructure({
    courseId,
    structure: { version: 1, id: "x", orderMode: "ordered", items, ...(labelOffsets ? { labelOffsets } : {}) },
  });
}

async function rowOf(seq: number) {
  return ctx.db.course.findFirstOrThrow({ where: { eventId: ctx.eventId, seq } });
}

async function children(rootSeq: number, opts: { all?: boolean } = {}) {
  const root = await rowOf(rootSeq);
  return ctx.db.course.findMany({
    where: { parentCourseId: root.id, ...(opts.all ? {} : { removed: false }) },
    orderBy: { variantKey: "asc" },
  });
}

async function codesOf(courseUuid: string): Promise<string> {
  const ccs = await ctx.db.courseControl.findMany({
    where: { courseId: courseUuid },
    orderBy: { position: "asc" },
    include: { control: { select: { codes: true } } },
  });
  return ccs.map((cc) => cc.control.codes).join(" ");
}

/** Journal entries written by `fn`, oldest first. */
async function entriesDuring(fn: () => Promise<unknown>) {
  const head = await ctx.db.journalEntry.findFirst({
    where: { eventId: ctx.eventId },
    orderBy: { hlc: "desc" },
    select: { hlc: true },
  });
  await fn();
  return ctx.db.journalEntry.findMany({
    where: { eventId: ctx.eventId, hlc: { gt: head?.hlc ?? 0n } },
    orderBy: { hlc: "asc" },
  });
}
const payloadOf = (e: { payload: unknown }) => e.payload as { id?: string; fields: Record<string, unknown>; coursePools?: { courseId: string }[]; runnerId?: number };

beforeAll(async () => {
  ctx = await createTestEvent("course_variants");
  caller = makeCaller(ctx.event);
  S = (await caller.control.create({ status: 4, xpos: 10, ypos: 10 })).id;
  F = (await caller.control.create({ status: 5, xpos: 90, ypos: 10 })).id;
  for (const [code, x] of [[31, 20], [32, 30], [33, 40], [34, 50], [35, 60], [36, 70], [37, 80]] as const) {
    await caller.control.create({ codes: String(code), xpos: x, ypos: 20 + (code % 3) * 5 });
  }
});

afterAll(async () => {
  await ctx.cleanup();
  await disconnect();
});

describe("materialisation (course-layer.md §12)", () => {
  it("writes one child course per variant, root first in the journal, the root keeping the first alternatives", async () => {
    const { id } = await caller.course.create({ name: "Long", climb: 40, numberOfMaps: 12 });
    const entries = await entriesDuring(() => write(id, [ctl(S), ctl(31), group("g", [[32], [33]]), ctl(34), ctl(F)]));
    const root = await rowOf(id);
    const kids = await children(id);
    expect(kids.map((k) => [k.variantKey, k.name])).toEqual([["A", "Long A"], ["B", "Long B"]]);
    expect(await codesOf(root.id)).toBe("31 32 34");
    expect(await codesOf(kids[0].id)).toBe("31 32 34");
    expect(await codesOf(kids[1].id)).toBe("31 33 34");
    for (const k of kids) {
      expect(k.parentCourseId).toBe(root.id);
      expect([k.climbM, k.numberOfMaps]).toEqual([40, 12]);
      expect(k.startName).toBe(root.startName);
      expect(k.finishControlId).toBe(root.finishControlId);
      // Measured by rebuildCourseLengths (no map scale here: 0 m, as the root).
      expect(k.lengthSource).toBe(root.lengthSource);
      // The child's structure is the linear variant, its own id.
      const s = k.structure as { id: string; items: { kind?: string }[] };
      expect(s.id).toBe(k.id);
      expect(s.items.some((i) => i.kind === "variation")).toBe(false);
    }
    // Variant A is the root's own path: drawn and measured alike.
    expect([kids[0].lengthM, kids[0].legs]).toEqual([root.lengthM, root.legs]);
    // One course.upserted per row: the root, then its children.
    const courseEntries = entries.filter((e) => e.type === "course.upserted").map((e) => payloadOf(e).id);
    expect(courseEntries).toEqual([root.id, kids[0].id, kids[1].id]);
    expect(payloadOf(entries.find((e) => payloadOf(e).id === kids[1].id)!).fields).toMatchObject({
      parentCourseId: root.id,
      variantKey: "B",
    });
  });

  it("variantList, list and detail name the variants by seq", async () => {
    const { id } = await caller.course.create({ name: "Listed" });
    await write(id, [ctl(S), ctl(31), group("g", [[32], [33], [35]]), ctl(34), ctl(F)]);
    const kids = await children(id);
    const list = await caller.course.variantList({ courseId: id });
    expect(list).toEqual(kids.map((k) => ({ variantKey: k.variantKey, courseId: k.seq, lengthM: k.lengthM })));
    expect(list.map((v) => v.variantKey)).toEqual(["A", "B", "C"]);
    const summaries = await caller.course.list();
    expect(summaries.find((c) => c.id === id)).toMatchObject({ parentCourseId: null, variantKey: null });
    expect(summaries.find((c) => c.id === kids[2].seq)).toMatchObject({ parentCourseId: id, variantKey: "C", name: "Listed C" });
    expect(await caller.course.detail({ id: kids[0].seq })).toMatchObject({ parentCourseId: id, variantKey: "A" });
    expect(await caller.course.variantList({ courseId: kids[0].seq })).toEqual([]);
    // The root's wire structure keeps its groups by public ids.
    const detail = await caller.course.detail({ id });
    expect(detail.structure.items[2]).toEqual(group("g", [[32], [33], [35]]));
  });

  it("a loop yields its permutations, the anchor visited between them", async () => {
    const { id } = await caller.course.create({ name: "Butterfly" });
    await write(id, [ctl(S), ctl(31), group("b", [[32, 33], [35]], true), ctl(31), ctl(F)]);
    const kids = await children(id);
    expect(kids.map((k) => k.variantKey)).toEqual(["AB", "BA"]);
    expect(await codesOf(kids[0].id)).toBe("31 32 33 31 35 31");
    expect(await codesOf(kids[1].id)).toBe("31 35 31 32 33 31");
  });

  it("an empty alternative is a straight leg (answer 5); all empty is refused", async () => {
    const { id } = await caller.course.create({ name: "Empty alt" });
    await write(id, [ctl(S), ctl(31), group("g", [[32], []]), ctl(34), ctl(F)]);
    const kids = await children(id);
    expect(await codesOf(kids[1].id)).toBe("31 34");
    await expect(write(id, [ctl(S), ctl(31), group("g", [[], []]), ctl(34), ctl(F)])).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("refuses colliding keys and too many variants", async () => {
    const { id } = await caller.course.create({ name: "Collide" });
    const g = (gid: string, labels: string[], sites: number[]): Items[number] => ({
      kind: "variation",
      id: gid,
      alternatives: labels.map((label, i) => ({ label, items: [{ siteId: sites[i] }] })),
    });
    await expect(
      write(id, [ctl(31), g("g1", ["A", "AB"], [32, 33]), ctl(34), g("g2", ["B", "C"], [35, 36]), ctl(37), g("g3", ["C", "BC"], [32, 33]), ctl(F)]),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED", message: expect.stringContaining("VARIANT_KEY_DUPLICATE") });
    await expect(
      write(id, [ctl(31), group("b", [[32], [33], [34], [35], [36]], true), ctl(31), ctl(F)]),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED", message: expect.stringContaining("VARIANT_LIMIT") });
    expect(await children(id, { all: true })).toEqual([]);
  });

  it("re-materialises: a new key is added, a vanished one soft-deleted with its runners nulled, a returning one revived", async () => {
    const { id } = await caller.course.create({ name: "Edit" });
    await write(id, [ctl(S), ctl(31), group("g", [[32], [33]]), ctl(34), ctl(F)]);
    const [a, b] = await children(id);
    const runner = await ctx.db.runner.create({
      data: { eventId: ctx.eventId, name: "On B", courseId: b.id, cardNo: 7100001 },
      select: { id: true, seq: true },
    });
    // An edit outside the group keeps both rows and their keys.
    await write(id, [ctl(S), ctl(31), group("g", [[32], [33]]), ctl(35), ctl(F)]);
    expect((await children(id)).map((k) => k.id)).toEqual([a.id, b.id]);
    expect(await codesOf(b.id)).toBe("31 33 35");
    // A third alternative.
    await write(id, [ctl(S), ctl(31), group("g", [[32], [33], [36]]), ctl(35), ctl(F)]);
    expect((await children(id)).map((k) => k.variantKey)).toEqual(["A", "B", "C"]);
    // The group goes: every variant is soft-deleted, the runner loses B.
    const entries = await entriesDuring(() => write(id, [ctl(S), ctl(31), ctl(35), ctl(F)]));
    expect(await children(id)).toEqual([]);
    expect((await children(id, { all: true })).every((k) => k.removed)).toBe(true);
    expect((await ctx.db.runner.findUniqueOrThrow({ where: { id: runner.id } })).courseId).toBeNull();
    const ru = entries.filter((e) => e.type === "runner.updated");
    expect(ru.map((e) => e.payload)).toEqual([{ cardNo: 7100001, runnerId: runner.seq, fields: { courseId: null } }]);
    const removed = entries.filter((e) => e.type === "course.upserted" && payloadOf(e).fields.removed === true);
    expect(removed).toHaveLength(3);
    // The group returns: A and B are the same rows again.
    await write(id, [ctl(S), ctl(31), group("g", [[32], [33]]), ctl(35), ctl(F)]);
    expect((await children(id)).map((k) => k.id)).toEqual([a.id, b.id]);
  });

  it("a vanished variant's runner.updated replays on a peer (courseId seq and null)", async () => {
    const { id } = await caller.course.create({ name: "Replay" });
    await write(id, [ctl(S), ctl(31), group("g", [[32], [33]]), ctl(34), ctl(F)]);
    const [a] = await children(id);
    const r = await ctx.db.runner.create({
      data: { eventId: ctx.eventId, name: "Replayed", cardNo: 7100002 },
      select: { id: true, seq: true },
    });
    const push = (fields: Record<string, unknown>) =>
      caller.events.push({
        events: [{
          id: randomUUID(),
          type: "runner.updated" as never,
          competitionId: ctx.event.nameId,
          stationId: "peer",
          timestamp: Date.now(),
          payload: { cardNo: 7100002, runnerId: r.seq, fields },
        }],
      });
    await push({ courseId: a.seq });
    expect((await ctx.db.runner.findUniqueOrThrow({ where: { id: r.id } })).courseId).toBe(a.id);
    await push({ courseId: null });
    expect((await ctx.db.runner.findUniqueOrThrow({ where: { id: r.id } })).courseId).toBeNull();
  });

  it("keeps label offsets of every alternative: the wire form round-trips them", async () => {
    const { id } = await caller.course.create({ name: "Offsets" });
    await write(id, [ctl(S), ctl(31), group("g", [[32], [33]]), ctl(34), ctl(F)], { "33": { dx: 3, dy: 1 }, "31": { dx: -1, dy: 2 } });
    const [, b] = await children(id);
    const ccB = await ctx.db.courseControl.findMany({ where: { courseId: b.id }, orderBy: { position: "asc" } });
    expect(ccB.map((cc) => [cc.labelDx, cc.labelDy])).toEqual([[-1, 2], [3, 1], [null, null]]);
    const detail = await caller.course.detail({ id });
    expect(detail.structure.labelOffsets).toEqual({ "31": { dx: -1, dy: 2 }, "33": { dx: 3, dy: 1 } });
  });
});

describe("pools (course-layer.md §12)", () => {
  it("a class on the root pools its live variants; a class picking the root later too; a plain course clears them", async () => {
    const { id } = await caller.course.create({ name: "Pooled" });
    const early = await caller.class.create({ name: "H21 pooled", courseId: id });
    const entries = await entriesDuring(() => write(id, [ctl(S), ctl(31), group("g", [[32], [33]]), ctl(34), ctl(F)]));
    const kids = await children(id);
    const earlyRow = await ctx.db.class.findFirstOrThrow({ where: { eventId: ctx.eventId, seq: early.id } });
    const pool = async (classUuid: string) =>
      (await ctx.db.classCoursePool.findMany({ where: { classId: classUuid, stage: 0 }, orderBy: { courseId: "asc" } })).map((p) => p.courseId).sort();
    expect(await pool(earlyRow.id)).toEqual(kids.map((k) => k.id).sort());
    const cu = entries.filter((e) => e.type === "class.upserted");
    expect(cu).toHaveLength(1);
    expect(payloadOf(cu[0]).coursePools!.map((p) => p.courseId).sort()).toEqual(kids.map((k) => k.id).sort());
    // A class picking the root after the variants exist.
    const late = await caller.class.create({ name: "D21 pooled" });
    await caller.class.update({ id: late.id, courseId: id });
    const lateRow = await ctx.db.class.findFirstOrThrow({ where: { eventId: ctx.eventId, seq: late.id } });
    expect(await pool(lateRow.id)).toEqual(kids.map((k) => k.id).sort());
    // A third alternative reaches both pools; dropping it leaves them.
    await write(id, [ctl(S), ctl(31), group("g", [[32], [33], [35]]), ctl(34), ctl(F)]);
    expect(await pool(lateRow.id)).toHaveLength(3);
    await write(id, [ctl(S), ctl(31), group("g", [[32], [33]]), ctl(34), ctl(F)]);
    expect(await pool(lateRow.id)).toEqual(kids.map((k) => k.id).sort());
    // Onto a plain course: no variant pool.
    const plain = await caller.course.create({ name: "Plain pooled" });
    await caller.class.update({ id: late.id, courseId: plain.id });
    expect(await pool(lateRow.id)).toEqual([]);
  });
});

describe("writes on roots and variants (course-layer.md §12)", () => {
  let rootSeq: number;
  let childSeq: number;
  beforeAll(async () => {
    rootSeq = (await caller.course.create({ name: "Guarded" })).id;
    await write(rootSeq, [ctl(S), ctl(31), group("g", [[32], [33]]), ctl(34), ctl(F)]);
    childSeq = (await children(rootSeq))[0].seq;
  });

  it("refuses the sequence fields of course.update and bulkUpdate on a root", async () => {
    for (const patch of [{ controlIds: [31, 32] }, { orderMode: "free_order" as const }, { firstAsStart: true }, { startControlId: null }]) {
      await expect(caller.course.update({ id: rootSeq, ...patch })).rejects.toMatchObject({
        code: "PRECONDITION_FAILED",
        message: expect.stringContaining("ROOT_HAS_VARIATIONS"),
      });
    }
    const plain = await caller.course.create({ name: "Bulk plain" });
    await expect(caller.course.bulkUpdate({ ids: [plain.id, rootSeq], lastAsFinish: true })).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
    });
    expect((await rowOf(plain.id)).lastAsFinish).toBe(false);
    expect((await children(rootSeq))).toHaveLength(2);
  });

  it("refuses every write on a variant", async () => {
    const refused = { code: "PRECONDITION_FAILED", message: expect.stringContaining("COURSE_IS_VARIANT") };
    await expect(caller.course.update({ id: childSeq, name: "Hijack" })).rejects.toMatchObject(refused);
    await expect(caller.course.bulkUpdate({ ids: [childSeq], climb: 5 })).rejects.toMatchObject(refused);
    await expect(caller.course.delete({ id: childSeq })).rejects.toMatchObject(refused);
    await expect(write(childSeq, [ctl(31), ctl(32)])).rejects.toMatchObject(refused);
    await expect(caller.course.setControlLabelOffset({ id: childSeq, controlId: 31, offset: { dx: 1, dy: 1 } })).rejects.toMatchObject(refused);
  });

  it("mirrors the root's name, climb and maps to its variants", async () => {
    const entries = await entriesDuring(() => caller.course.update({ id: rootSeq, name: "Guarded2", climb: 15 }));
    const kids = await children(rootSeq);
    expect(kids.map((k) => [k.name, k.climbM])).toEqual([["Guarded2 A", 15], ["Guarded2 B", 15]]);
    expect(entries.filter((e) => e.type === "course.upserted")).toHaveLength(3);
    await caller.course.bulkUpdate({ ids: [rootSeq], numberOfMaps: 9 });
    expect((await children(rootSeq)).map((k) => k.numberOfMaps)).toEqual([9, 9]);
  });

  it("sets a label offset of a control only on another alternative through the root", async () => {
    await caller.course.setControlLabelOffset({ id: rootSeq, controlId: 33, offset: { dx: 4, dy: 4 } });
    const [, b] = await children(rootSeq);
    const cc = await ctx.db.courseControl.findFirstOrThrow({ where: { courseId: b.id, control: { codes: "33" } } });
    expect([cc.labelDx, cc.labelDy]).toEqual([4, 4]);
  });

  it("clones a root with its variants, a variant as a plain course", async () => {
    const clone = await caller.course.clone({ id: rootSeq, name: "Guarded copy" });
    const kids = await children(clone.id);
    expect(kids.map((k) => k.name)).toEqual(["Guarded copy A", "Guarded copy B"]);
    expect(await codesOf(kids[1].id)).toBe("31 33 34");
    const cc = await ctx.db.courseControl.findFirstOrThrow({ where: { courseId: kids[1].id, control: { codes: "33" } } });
    expect([cc.labelDx, cc.labelDy]).toEqual([4, 4]);
    const flat = await caller.course.clone({ id: childSeq, name: "Guarded flat" });
    const row = await rowOf(flat.id);
    expect([row.parentCourseId, row.variantKey]).toEqual([null, null]);
    expect(await codesOf(row.id)).toBe("31 32 34");
  });

  it("deletes a root with its variants", async () => {
    const { id } = await caller.course.create({ name: "Doomed" });
    await write(id, [ctl(S), ctl(31), group("g", [[32], [33]]), ctl(34), ctl(F)]);
    const entries = await entriesDuring(() => caller.course.delete({ id }));
    expect(await children(id, { all: true }).then((k) => k.every((c) => c.removed))).toBe(true);
    expect(entries.filter((e) => e.type === "course.upserted").map((e) => payloadOf(e).fields.removed)).toEqual([true, true, true]);
  });
});

describe("control.delete re-materialises the roots naming it (course-layer.md §6.2, §12)", () => {
  it("drops a control of alternative B only from that alternative, the group kept, one entry per row", async () => {
    const tmp = await caller.control.create({ codes: "78", xpos: 45, ypos: 45 });
    const { id } = await caller.course.create({ name: "Pruned root" });
    await write(id, [ctl(S), ctl(31), group("g", [[32], [33, 78]]), ctl(34), ctl(F)]);
    const root = await rowOf(id);
    const [a, b] = await children(id);
    const entries = await entriesDuring(() => caller.control.delete({ id: tmp.id }));
    expect(await codesOf(b.id)).toBe("31 33 34");
    expect(await codesOf(a.id)).toBe("31 32 34");
    expect((await children(id)).map((k) => k.id)).toEqual([a.id, b.id]);
    expect((await caller.course.detail({ id })).structure.items[2]).toEqual(group("g", [[32], [33]]));
    const ids = entries.filter((e) => e.type === "course.upserted").map((e) => payloadOf(e).id);
    for (const x of [root.id, a.id, b.id]) expect(ids.filter((y) => y === x)).toHaveLength(1);
  });

  it("dissolves a group whose anchor goes", async () => {
    const tmp = await caller.control.create({ codes: "79", xpos: 25, ypos: 45 });
    const { id } = await caller.course.create({ name: "Unanchored" });
    await write(id, [ctl(79), group("g", [[32], [33]]), ctl(34)]);
    await caller.control.delete({ id: tmp.id });
    expect(await children(id)).toEqual([]);
    expect((await caller.course.detail({ id })).structure.items.map((i) => ("siteId" in i ? i.siteId : "g"))).toEqual([32, 34]);
  });
});

describe("course.importCourses over a root", () => {
  it("replaces it with the file's linear course and drops its variants", async () => {
    const { id } = await caller.course.create({ name: "Imported root" });
    await write(id, [ctl(S), ctl(31), group("g", [[32], [33]]), ctl(34), ctl(F)]);
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<CourseData xmlns="http://www.orienteering.org/datastandard/3.0" iofVersion="3.0">
  <RaceCourseData>
    <Map><Scale>15000</Scale></Map>
    <Control type="Control"><Id>31</Id></Control>
    <Control type="Control"><Id>34</Id></Control>
    <Course>
      <Name>Imported root</Name>
      <Length>2500</Length>
      <CourseControl type="Control"><Control>31</Control></CourseControl>
      <CourseControl type="Control"><Control>34</Control></CourseControl>
    </Course>
  </RaceCourseData>
</CourseData>`;
    const kidsBefore = await children(id);
    const entries = await entriesDuring(() => caller.course.importCourses({ xmlContent: xml, skipPositions: true }));
    expect(await children(id)).toEqual([]);
    const imported = entries.find((e) => e.type === "reference.imported")!;
    const courses = (imported.payload as { courses: { id: string; fields: Record<string, unknown> }[] }).courses;
    for (const k of kidsBefore) expect(courses.find((c) => c.id === k.id)?.fields.removed).toBe(true);
  });
});

describe("storage (the migration, backup, snapshot)", () => {
  it("refuses a second row for a key and a key without a parent", async () => {
    const { id } = await caller.course.create({ name: "Constrained" });
    await write(id, [ctl(S), ctl(31), group("g", [[32], [33]]), ctl(34), ctl(F)]);
    const root = await rowOf(id);
    await expect(
      ctx.db.course.create({ data: { eventId: ctx.eventId, name: "dup", parentCourseId: root.id, variantKey: "A" } }),
    ).rejects.toThrow();
    await expect(ctx.db.course.create({ data: { eventId: ctx.eventId, name: "orphan key", variantKey: "A" } })).rejects.toThrow();
  });

  it("a checkout snapshot carries the children as ordinary rows and imports them", async () => {
    const own = await createTestEvent("course_variants_snapshot");
    const ownCaller = makeCaller(own.event);
    await ownCaller.control.create({ codes: "31", xpos: 20, ypos: 20 });
    await ownCaller.control.create({ codes: "32", xpos: 30, ypos: 20 });
    await ownCaller.control.create({ codes: "33", xpos: 40, ypos: 20 });
    await ownCaller.control.create({ codes: "34", xpos: 50, ypos: 20 });
    const { id } = await ownCaller.course.create({ name: "Snap" });
    await ownCaller.class.create({ name: "Snap class", courseId: id });
    await ownCaller.course.setStructure({
      courseId: id,
      structure: { version: 1, id: "s", orderMode: "ordered", items: [ctl(31), group("g", [[32], [33]]), ctl(34)] },
    });
    const snap = await exportEventSnapshot(own.db, own.event);
    const kids = snap.tables.course.filter((c) => c.parentCourseId);
    expect(kids.map((k) => k.variantKey).sort()).toEqual(["A", "B"]);
    expect(snap.tables.classCoursePool).toHaveLength(2);
    // Import into this database: the event goes first, its rows come back.
    await own.db.event.delete({ where: { id: own.eventId } });
    const ref = await importEventSnapshot(own.db, snap);
    const back = await own.db.course.findMany({ where: { eventId: ref.id, parentCourseId: { not: null } } });
    expect(back.map((k) => k.variantKey).sort()).toEqual(["A", "B"]);
    expect(await own.db.classCoursePool.count({ where: { class: { eventId: ref.id } } })).toBe(2);
    await own.db.event.delete({ where: { id: ref.id } });
  });
});
