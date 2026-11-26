/**
 * Draw safety (fix package 7: RES-03, RES-09, RES-15, RES-17).
 *
 * - A redraw keeps the start of runners who have started or finished,
 *   unless forced; an "only missing" draw touches only runners without a start.
 * - The applied draw is the previewed draw, and a stale preview is refused.
 * - The draw is one transaction: a failure part-way leaves nothing changed.
 * - Start numbers continue after the ones the draw keeps, and the journal
 *   carries them.
 */

import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import {
  createTestEvent,
  disconnect,
  type TestEventContext,
} from "../helpers/test-db.js";
import { makeCaller } from "../helpers/caller.js";

// Lets one test make the per-class step of execute fail after the runner
// writes, to prove the whole draw rolls back.
const failClassUpsert = vi.hoisted(() => ({ on: false }));
vi.mock("../../referenceJournal.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../referenceJournal.js")>();
  return {
    ...real,
    emitClassUpserted: async (...args: Parameters<typeof real.emitClassUpserted>) => {
      if (failClassUpsert.on) throw new Error("injected failure");
      return real.emitClassUpserted(...args);
    },
  };
});

const MIN = 600;
const TEN = 360_000;

let ctx: TestEventContext;
let caller: ReturnType<typeof makeCaller>;
let classA: number;
let classB: number;
let card = 70_000;

const settings = {
  firstStart: TEN,
  baseInterval: MIN,
  maxParallelStarts: 2,
  detectCourseOverlap: false,
};

function cfg(classId: number) {
  return { classId, method: "random" as const, interval: 2 * MIN };
}

async function makeClass(name: string, runners: number): Promise<number> {
  const course = await caller.course.create({ name: `Course ${name}`, length: 3000 });
  const cls = await caller.class.create({ name, courseId: course.id });
  for (let i = 0; i < runners; i++) {
    await caller.runner.create({
      name: `${name} ${i}`,
      classId: cls.id,
      cardNo: ++card,
      clubName: `OK ${i % 3}`,
    });
  }
  return cls.id;
}

async function runnersOf(classSeq: number) {
  const cls = await ctx.db.class.findFirstOrThrow({
    where: { eventId: ctx.eventId, seq: classSeq },
  });
  return ctx.db.runner.findMany({
    where: { eventId: ctx.eventId, classId: cls.id, removed: false },
    orderBy: { seq: "asc" },
  });
}

/** Preview then apply what was previewed. */
async function drawAndApply(
  classes: ReturnType<typeof cfg>[],
  options?: { mode: "all" | "onlyMissing"; force: boolean },
) {
  const preview = await caller.draw.preview({ classes, settings, options });
  const res = await caller.draw.execute({
    classes,
    settings,
    options,
    seed: preview.seed,
    previewToken: preview.previewToken,
  });
  return { preview, res };
}

beforeEach(async () => {
  ctx = await createTestEvent("draw_safety");
  caller = makeCaller(ctx.event);
  classA = await makeClass("H21", 5);
  classB = await makeClass("D21", 3);
});

afterEach(async () => {
  failClassUpsert.on = false;
  await ctx.cleanup();
});

afterAll(async () => {
  await disconnect();
});

describe("a redraw keeps runners who have started (RES-03)", () => {
  it("keeps the start of a finished, a status-set, a read-out and a punched runner", async () => {
    await drawAndApply([cfg(classA)]);
    const [finished, withStatus, readOut, punched, fresh] = await runnersOf(classA);
    await ctx.db.runner.update({ where: { id: finished.id }, data: { finishTime: 30_000 } });
    await ctx.db.runner.update({ where: { id: withStatus.id }, data: { status: "dns" } });
    await ctx.db.cardReadout.create({
      data: { eventId: ctx.eventId, cardNo: readOut.cardNo!, punches: [] },
    });
    await ctx.db.punch.create({
      data: { eventId: ctx.eventId, cardNo: punched.cardNo!, controlCode: 31, time: 1000 },
    });
    const before = new Map((await runnersOf(classA)).map((r) => [r.id, r]));

    const { preview, res } = await drawAndApply([cfg(classA)]);
    expect(preview.skippedStarted).toBe(4);
    expect(res.skippedStarted).toBe(4);
    expect(res.totalDrawn).toBe(1);
    expect(preview.classes[0].entries.map((e) => e.runnerId)).toEqual([fresh.seq]);

    for (const r of await runnersOf(classA)) {
      if (r.id === fresh.id) continue;
      expect(r.startTime).toBe(before.get(r.id)!.startTime);
      expect(r.startNo).toBe(before.get(r.id)!.startNo);
    }
  });

  it("rewrites them when forced", async () => {
    await drawAndApply([cfg(classA)]);
    const [finished] = await runnersOf(classA);
    await ctx.db.runner.update({ where: { id: finished.id }, data: { finishTime: 30_000 } });

    const { preview, res } = await drawAndApply([cfg(classA)], { mode: "all", force: true });
    expect(preview.skippedStarted).toBe(0);
    expect(res.totalDrawn).toBe(5);
    expect(preview.replaced).toBe(5);
  });

  it("only-missing draws just the runners without a start, after the class's last start", async () => {
    await drawAndApply([cfg(classA)]);
    const late = await caller.runner.create({
      name: "Late Larry",
      classId: classA,
      cardNo: ++card,
      clubName: "OK Late",
    });
    const before = await runnersOf(classA);
    const cls = await ctx.db.class.findFirstOrThrow({ where: { eventId: ctx.eventId, seq: classA } });

    const { res } = await drawAndApply([cfg(classA)], { mode: "onlyMissing", force: false });
    expect(res.totalDrawn).toBe(1);

    const after = await runnersOf(classA);
    const lateRow = after.find((r) => r.seq === late.id)!;
    const lastKept = Math.max(...before.filter((r) => r.seq !== late.id).map((r) => r.startTime));
    expect(lateRow.startTime).toBe(lastKept + 2 * MIN);
    for (const r of after) {
      if (r.seq === late.id) continue;
      expect(r.startTime).toBe(before.find((b) => b.id === r.id)!.startTime);
    }
    // The class's own first start and interval stay.
    const clsAfter = await ctx.db.class.findFirstOrThrow({ where: { id: cls.id } });
    expect(clsAfter.firstStart).toBe(cls.firstStart);
  });

  it("defaults report drawn and started counts so the panel can preselect", async () => {
    await drawAndApply([cfg(classA)]);
    const [finished] = await runnersOf(classA);
    await ctx.db.runner.update({ where: { id: finished.id }, data: { finishTime: 30_000 } });
    const d = await caller.draw.defaults();
    const a = d.classes.find((c) => c.id === classA)!;
    const b = d.classes.find((c) => c.id === classB)!;
    expect(a.drawnCount).toBe(5);
    expect(a.startedCount).toBe(1);
    expect(b.drawnCount).toBe(0);
  });
});

describe("the applied draw is the previewed draw (RES-15)", () => {
  it("writes exactly the previewed times and numbers", async () => {
    const classes = [{ ...cfg(classA), method: "clubSeparation" as const }, cfg(classB)];
    const { preview } = await drawAndApply(classes);
    const bySeq = new Map(
      [...(await runnersOf(classA)), ...(await runnersOf(classB))].map((r) => [r.seq, r]),
    );
    for (const c of preview.classes) {
      for (const e of c.entries) {
        const row = bySeq.get(e.runnerId)!;
        expect(row.startTime + ctx.event.zeroTime).toBe(e.startTime);
        expect(row.startNo).toBe(e.startNo);
      }
    }
  });

  it("reuses a seed: the same seed previews the same order", async () => {
    const first = await caller.draw.preview({ classes: [cfg(classA)], settings });
    const again = await caller.draw.preview({ classes: [cfg(classA)], settings, seed: first.seed });
    expect(again.classes).toEqual(first.classes);
    expect(again.previewToken).toBe(first.previewToken);
  });

  it("refuses a stale preview and changes nothing", async () => {
    const preview = await caller.draw.preview({ classes: [cfg(classA)], settings });
    await caller.runner.create({ name: "Sneaky Sam", classId: classA, cardNo: ++card });
    const journalBefore = await ctx.db.journalEntry.count({
      where: { eventId: ctx.eventId, type: "start.adjusted" },
    });

    await expect(
      caller.draw.execute({
        classes: [cfg(classA)],
        settings,
        seed: preview.seed,
        previewToken: preview.previewToken,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    expect((await runnersOf(classA)).every((r) => r.startTime === 0 && r.startNo === 0)).toBe(true);
    expect(
      await ctx.db.journalEntry.count({ where: { eventId: ctx.eventId, type: "start.adjusted" } }),
    ).toBe(journalBefore);
  });

  it("refuses a token that does not match the seed", async () => {
    const preview = await caller.draw.preview({ classes: [cfg(classA)], settings });
    await expect(
      caller.draw.execute({
        classes: [cfg(classA)],
        settings,
        seed: (preview.seed + 1) % 0xffffffff,
        previewToken: preview.previewToken,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });
});

describe("the draw is one transaction (RES-09)", () => {
  it("a failure after the runner writes leaves no runner or journal row changed", async () => {
    const preview = await caller.draw.preview({ classes: [cfg(classA), cfg(classB)], settings });
    failClassUpsert.on = true;
    await expect(
      caller.draw.execute({
        classes: [cfg(classA), cfg(classB)],
        settings,
        seed: preview.seed,
        previewToken: preview.previewToken,
      }),
    ).rejects.toThrow();
    failClassUpsert.on = false;

    const all = [...(await runnersOf(classA)), ...(await runnersOf(classB))];
    expect(all.every((r) => r.startTime === 0 && r.startNo === 0)).toBe(true);
    expect(
      await ctx.db.journalEntry.count({ where: { eventId: ctx.eventId, type: "start.adjusted" } }),
    ).toBe(0);
  });

  it("is refused while the event is checked out to another node", async () => {
    const preview = await caller.draw.preview({ classes: [cfg(classA)], settings });
    await ctx.db.eventLease.create({ data: { eventId: ctx.eventId, holderNodeId: `box-${randomUUID()}` } });
    await expect(
      caller.draw.execute({
        classes: [cfg(classA)],
        settings,
        seed: preview.seed,
        previewToken: preview.previewToken,
      }),
    ).rejects.toThrow();
    expect((await runnersOf(classA)).every((r) => r.startTime === 0)).toBe(true);
  });

  it("applying the same preview twice gives the same result", async () => {
    const preview = await caller.draw.preview({ classes: [cfg(classA)], settings });
    const input = {
      classes: [cfg(classA)],
      settings,
      seed: preview.seed,
      previewToken: preview.previewToken,
    };
    await caller.draw.execute(input);
    const first = (await runnersOf(classA)).map((r) => [r.id, r.startTime, r.startNo]);
    // A retry after a lost response recomputes the same draw from the same
    // seed, so it writes the same values instead of a new shuffle.
    await expect(caller.draw.execute(input)).resolves.toMatchObject({ totalDrawn: 5 });
    expect((await runnersOf(classA)).map((r) => [r.id, r.startTime, r.startNo])).toEqual(first);
  });
});

describe("start numbers (RES-17)", () => {
  it("a redraw of one class continues after the other classes' numbers", async () => {
    await drawAndApply([cfg(classA), cfg(classB)]);
    const bNos = (await runnersOf(classB)).map((r) => r.startNo);
    await drawAndApply([cfg(classA)]);
    const aNos = (await runnersOf(classA)).map((r) => r.startNo);
    const all = [...aNos, ...bNos];
    expect(new Set(all).size).toBe(all.length);
    expect(Math.min(...aNos)).toBeGreaterThan(Math.max(...bNos));
  });

  it("journals the start number with every start.adjusted", async () => {
    await drawAndApply([cfg(classA)]);
    const entries = await ctx.db.journalEntry.findMany({
      where: { eventId: ctx.eventId, type: "start.adjusted" },
    });
    expect(entries).toHaveLength(5);
    const rows = new Map((await runnersOf(classA)).map((r) => [r.cardNo, r]));
    for (const e of entries) {
      const p = e.payload as { cardNo: number; startNo: number; startTime: number };
      expect(p.startNo).toBe(rows.get(p.cardNo)!.startNo);
      expect(p.startTime).toBe(rows.get(p.cardNo)!.startTime + ctx.event.zeroTime);
    }
    // Every entry carries its own HLC.
    expect(new Set(entries.map((e) => e.hlc)).size).toBe(5);
  });

  it("replays startNo from start.adjusted, and leaves it alone when absent", async () => {
    const [r] = await runnersOf(classB);
    const push = (payload: Record<string, unknown>) =>
      caller.events.push({
        events: [
          {
            id: randomUUID(),
            type: "start.adjusted",
            competitionId: ctx.event.nameId,
            stationId: "station-A",
            timestamp: Date.now(),
            payload,
          },
        ],
      });
    await push({ cardNo: r.cardNo, startTime: TEN, startNo: 77 });
    let row = await ctx.db.runner.findUniqueOrThrow({ where: { id: r.id } });
    expect(row.startNo).toBe(77);
    expect(row.startTime).toBe(TEN - ctx.event.zeroTime);

    await push({ cardNo: r.cardNo, startTime: TEN + MIN });
    row = await ctx.db.runner.findUniqueOrThrow({ where: { id: r.id } });
    expect(row.startNo).toBe(77);
    expect(row.startTime).toBe(TEN + MIN - ctx.event.zeroTime);
  });
});
