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
