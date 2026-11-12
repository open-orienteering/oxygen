/**
 * F32 (docs/course-layer.md §6.3 "Starts and finishes take a code";
 * docs/bugfix-first-leg-from-start.md "Found on the way"): a start or finish
 * created without a code takes the lowest free code in 3–10, then 11–30, so
 * its public id (first code, else seq) never meets another control's code.
 *
 * The regression: a start used to be code-less and addressed by its seq; once
 * the event's seq reached a punch code (a full E2E run: seq 80 beside the seed
 * control coded 80) two controls shared one public id.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll } from "vitest";
import { createTestEvent, disconnect, type TestEventContext } from "../helpers/test-db.js";
import { makeCaller } from "../helpers/caller.js";

let ctx: TestEventContext;
let caller: ReturnType<typeof makeCaller>;

beforeEach(async () => {
  ctx = await createTestEvent("start_finish_codes");
  caller = makeCaller(ctx.event);
}, 60_000);

afterEach(async () => {
  await ctx?.cleanup();
}, 30_000);

afterAll(async () => {
  await disconnect();
}, 30_000);

/** Set the event's control seq counter (`allocate_event_seq()`): the next row created gets `seq`. */
async function setNextSeq(seq: number): Promise<void> {
  await ctx.db.$executeRaw`
    INSERT INTO oxygen.event_seqs (event_id, table_name, next_seq) VALUES (${ctx.eventId}, 'controls', ${seq})
    ON CONFLICT (event_id, table_name) DO UPDATE SET next_seq = EXCLUDED.next_seq`;
}

const range = (lo: number, hi: number) => Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);

describe("starts and finishes take a code (F32)", () => {
  it("a new start never shares its public id with a control's code", async () => {
    // The full E2E run: the seed's control coded 80, and the event's seq counter at 80.
    await ctx.db.control.create({ data: { eventId: ctx.eventId, codes: "31", xpos: 1, ypos: 1 } });
    await ctx.db.control.create({ data: { eventId: ctx.eventId, codes: "80", xpos: 2, ypos: 2 } });
    const clash = 80;
    await setNextSeq(clash);

    const start = await caller.control.create({ status: 4, xpos: 5, ypos: 5 });
    expect(start.id).toBe(3);
    const row = await ctx.db.control.findFirstOrThrow({ where: { eventId: ctx.eventId, kind: "start" } });
    expect(row.codes).toBe("3");
    expect(row.seq).toBe(clash);
    expect(row.name).toBe("Start 1");

    const list = await caller.control.list();
    const ids = list.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(expect.arrayContaining([31, clash, 3]));

    const coords = await caller.course.controlCoordinates();
    const coordIds = coords.map((c) => c.id);
    expect(new Set(coordIds).size).toBe(coordIds.length);
    // Shown by its name, not its code (user decision 2026-11-12).
    expect(coords.find((c) => c.id === 3)?.code).toBe("Start 1");

    expect((await caller.control.getById({ id: 3 })).name).toBe("Start 1");
    expect((await caller.control.getById({ id: clash })).codes).toBe(String(clash));
  });

  it("takes the lowest free code: 3, 4, skips a held code, then 11 after 10", async () => {
    await caller.control.create({ codes: "5", xpos: 1, ypos: 1 });
    const a = await caller.control.create({ status: 4 });
    const b = await caller.control.create({ status: 5 });
    const c = await caller.control.create({ kind: "start" });
    expect([a.id, b.id, c.id]).toEqual([3, 4, 6]);
    for (const n of range(7, 10)) await caller.control.create({ codes: String(n) });
    const d = await caller.control.create({ kind: "finish" });
    expect(d.id).toBe(11);
    const names = (await ctx.db.control.findMany({
      where: { eventId: ctx.eventId, kind: { in: ["start", "finish"] } },
      orderBy: { seq: "asc" },
      select: { name: true },
    })).map((r) => r.name);
    expect(names).toEqual(["Start 1", "Mål 1", "Start 2", "Mål 2"]);
  });

  it("a given code is used as for a control", async () => {
    const s = await caller.control.create({ status: 4, codes: "9" });
    expect(s.id).toBe(9);
    await expect(caller.control.create({ status: 5, codes: "9" })).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("a legacy code-less start's seq is held: not allocated, and refused as a code", async () => {
    // A row written before F32: code-less, addressed by its seq.
    const legacy = await ctx.db.control.create({
      data: { eventId: ctx.eventId, codes: "", kind: "start", status: "start", name: "Start 1", seq: 3 },
    });
    expect(legacy.seq).toBe(3);
    const s = await caller.control.create({ status: 4 });
    expect(s.id).toBe(4);
    await expect(caller.control.create({ codes: "3" })).rejects.toMatchObject({ code: "CONFLICT" });
    const c = await caller.control.create({ codes: "31" });
    await expect(caller.control.update({ id: c.id, codes: "3" })).rejects.toMatchObject({ code: "CONFLICT" });
    // Its own id still resolves to it.
    expect((await caller.control.getById({ id: 3 })).name).toBe("Start 1");
  });

  it("is refused when 3–30 are all held, nothing written", async () => {
    for (const n of range(3, 30)) await ctx.db.control.create({ data: { eventId: ctx.eventId, codes: String(n) } });
    await expect(caller.control.create({ status: 4 })).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message: expect.stringContaining("START_FINISH_CODES_EXHAUSTED"),
    });
    expect(await ctx.db.control.count({ where: { eventId: ctx.eventId, kind: "start" } })).toBe(0);
  });

  it("parallel creates take distinct codes", async () => {
    const made = await Promise.all(range(1, 4).map(() => caller.control.create({ status: 4 })));
    expect(made.map((m) => m.id).sort((x, y) => x - y)).toEqual([3, 4, 5, 6]);
  });

  it("the code is editable and duplicate-checked", async () => {
    const s = await caller.control.create({ status: 4 });
    await caller.control.create({ codes: "31" });
    await caller.control.update({ id: s.id, codes: "9" });
    expect((await caller.control.getById({ id: 9 })).name).toBe("Start 1");
    await expect(caller.control.update({ id: 9, codes: "31" })).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("clearing a start's code stays allowed (the legacy shape)", async () => {
    const s = await caller.control.create({ status: 4 });
    await caller.control.update({ id: s.id, codes: "" });
    const row = await ctx.db.control.findFirstOrThrow({ where: { eventId: ctx.eventId, kind: "start" } });
    expect(row.codes).toBe("");
    // Addressed by its seq again, which then counts as held.
    expect((await caller.control.getById({ id: row.seq })).name).toBe("Start 1");
  });

  it("a kind change to start allocates a code for a code-less row", async () => {
    const cp = await caller.control.create({ kind: "crossing_point" });
    expect(cp.id).toBeGreaterThan(10_000);
    await caller.control.update({ id: cp.id, kind: "start" });
    const row = await ctx.db.control.findFirstOrThrow({ where: { eventId: ctx.eventId, kind: "start" } });
    expect(row.codes).toBe("3");
    // A coded control that becomes a finish keeps its code.
    const c = await caller.control.create({ codes: "40" });
    await caller.control.update({ id: c.id, kind: "finish" });
    expect((await ctx.db.control.findFirstOrThrow({ where: { eventId: ctx.eventId, kind: "finish" } })).codes).toBe("40");
  });

  it("the course reads the start by its code", async () => {
    const start = await caller.control.create({ status: 4, xpos: 5, ypos: 5 });
    await caller.control.create({ codes: "31", xpos: 50, ypos: 5 });
    const finish = await caller.control.create({ status: 5, xpos: 90, ypos: 5 });
    expect([start.id, finish.id]).toEqual([3, 4]);
    const course = await caller.course.create({ name: "F32", controlIds: [31] });
    await caller.course.update({ id: course.id, startControlId: start.id, finishControlId: finish.id });
    const row = (await caller.course.list()).find((c) => c.id === course.id);
    expect(row?.startControlId).toBe(3);
    expect(row?.finishControlId).toBe(4);
    const stored = await ctx.db.course.findFirstOrThrow({ where: { eventId: ctx.eventId, name: "F32" } });
    expect(stored.startName).toBe("Start 1");
  });
});

const iof = (controls: string, course: string) => `<?xml version="1.0" encoding="UTF-8"?>
<CourseData xmlns="http://www.orienteering.org/datastandard/3.0" iofVersion="3.0">
  <RaceCourseData>
    ${controls}
    <Course><Name>Iof A</Name><Length>1000</Length><Climb>10</Climb>${course}</Course>
  </RaceCourseData>
</CourseData>`;

const IOF_A = iof(
  `<Control type="Start"><Id>S1</Id><Position lng="11.0" lat="58.0"/></Control>
    <Control type="Control"><Id>41</Id><Position lng="11.001" lat="58.001"/></Control>
    <Control type="Finish"><Id>F1</Id><Position lng="11.003" lat="58.003"/></Control>`,
  `<CourseControl type="Start"><Control>S1</Control></CourseControl>
      <CourseControl type="Control"><Control>41</Control></CourseControl>
      <CourseControl type="Finish"><Control>F1</Control></CourseControl>`,
);

describe("the course import gives a new start or finish a code (F32)", () => {
  const ends = () =>
    ctx.db.control.findMany({
      where: { eventId: ctx.eventId, removed: false, status: { in: ["start", "finish"] } },
      orderBy: { seq: "asc" },
      select: { id: true, name: true, codes: true },
    });

  it("allocates on create and keeps the code on a re-import", async () => {
    await caller.control.create({ codes: "3" });
    await caller.course.importCourses({ xmlContent: IOF_A });
    const first = await ends();
    expect(first.map((e) => [e.name, e.codes])).toEqual([["Start 1", "4"], ["Mål 1", "5"]]);
    // Matched by name on a re-import: the same rows, the same codes.
    await caller.course.importCourses({ xmlContent: IOF_A });
    expect(await ends()).toEqual(first);
    // The export keeps the name as the id (user decision 2026-11-12).
    const coords = await caller.course.controlCoordinates();
    expect(coords.filter((c) => c.status === 4 || c.status === 5).map((c) => [c.id, c.code])).toEqual(
      expect.arrayContaining([[4, "Start 1"], [5, "Mål 1"]]),
    );
  });

  it("previewImport counts no start / finish code as an existing control", async () => {
    await caller.control.create({ status: 4 });
    const file = iof(
      `<Control type="Start"><Id>S1</Id></Control>
    <Control type="Control"><Id>3</Id></Control>
    <Control type="Control"><Id>41</Id></Control>
    <Control type="Finish"><Id>F1</Id></Control>`,
      `<CourseControl type="Start"><Control>S1</Control></CourseControl>
      <CourseControl type="Control"><Control>41</Control></CourseControl>
      <CourseControl type="Finish"><Control>F1</Control></CourseControl>`,
    );
    const preview = await caller.course.previewImport({ xmlContent: file });
    expect([preview.newControls, preview.existingControls]).toEqual([2, 0]);
  });

  it("a removed start the import restores takes a new code when its own is taken", async () => {
    const s = await caller.control.create({ status: 4 });
    expect(s.id).toBe(3);
    await caller.control.delete({ id: 3 });
    await caller.control.create({ codes: "3" });
    await caller.course.importCourses({ xmlContent: IOF_A });
    const start = await ctx.db.control.findFirstOrThrow({ where: { eventId: ctx.eventId, kind: "start", removed: false } });
    expect(start.name).toBe("Start 1");
    expect(start.codes).not.toBe("3");
    const ids = (await caller.control.list()).map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("refuses a file control whose code a start holds, nothing written", async () => {
    await caller.control.create({ status: 4 });
    const before = await ctx.db.control.count({ where: { eventId: ctx.eventId } });
    const clash = iof(
      `<Control type="Start"><Id>S1</Id></Control>
    <Control type="Control"><Id>3</Id></Control>
    <Control type="Finish"><Id>F1</Id></Control>`,
      `<CourseControl type="Start"><Control>S1</Control></CourseControl>
      <CourseControl type="Control"><Control>3</Control></CourseControl>
      <CourseControl type="Finish"><Control>F1</Control></CourseControl>`,
    );
    await expect(caller.course.importCourses({ xmlContent: clash, skipPositions: true })).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "Control code 3 is held by Start 1",
    });
    expect(await ctx.db.control.count({ where: { eventId: ctx.eventId } })).toBe(before);
  });
});
