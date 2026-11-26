/**
 * ZeroTime sentinel and time zone (fix package 8: RES-04, RES-05, RES-06,
 * RES-08, RES-16).
 *
 * - ZeroTime is set from the planned first start at creation, and can be
 *   moved before the race (drawn starts keep their clock time).
 * - A start exactly at ZeroTime is refused (it would read back as "no
 *   start"); the draw defaults one hour after ZeroTime.
 * - A runner who starts before ZeroTime (negative relative start) is on the
 *   start screen, counted in the forest, and ranked.
 * - "Now" is the event's own time zone, not the process's.
 * - Backup-memory punches are stored ZeroTime-relative and only count once
 *   pushed.
 */

import { describe, it, expect, afterAll, afterEach } from "vitest";
import { createTestEvent, disconnect, type TestEventContext } from "../helpers/test-db.js";
import { makeCaller } from "../helpers/caller.js";
import { prisma } from "../../db.js";
import { runningTimeDs, timeOfDayDs } from "@oxygen/shared";
import { randomUUID } from "node:crypto";

const H = 36_000;
const MIN = 600;

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});
afterAll(async () => {
  await disconnect();
});

async function event(label: string): Promise<TestEventContext> {
  const ctx = await createTestEvent(label);
  cleanups.push(ctx.cleanup);
  return ctx;
}

/** A caller that sees the event row as it is now (zero time, zone). */
async function freshCaller(ctx: TestEventContext) {
  const row = await ctx.db.event.findUniqueOrThrow({ where: { id: ctx.eventId } });
  return makeCaller({ ...ctx.event, zeroTime: row.zeroTime, timeZone: row.timeZone });
}

async function classWithCourse(caller: ReturnType<typeof makeCaller>, ctx: TestEventContext, name: string) {
  const controls = await Promise.all(
    ["31", "32", "33"].map((codes) => ctx.db.control.create({ data: { eventId: ctx.eventId, codes, name: "" } })),
  );
  const course = await ctx.db.course.create({ data: { eventId: ctx.eventId, name, lengthM: 2500 } });
  await ctx.db.courseControl.createMany({
    data: controls.map((c, i) => ({ courseId: course.id, controlId: c.id, position: i + 1 })),
  });
  const cls = await ctx.db.class.create({ data: { eventId: ctx.eventId, name, courseId: course.id } });
  return cls;
}

describe("ZeroTime at creation and in the settings (RES-04)", () => {
  it("sets ZeroTime one hour before the planned first start", async () => {
    const caller = makeCaller(null);
    const res = await caller.event.create({
      name: "ZT create",
      date: "2026-06-01",
      firstStart: 8 * H + 30 * MIN,
      timeZone: "Europe/Helsinki",
    });
    const row = await prisma().event.findUniqueOrThrow({ where: { nameId: res.nameId } });
    cleanups.push(async () => void (await prisma().event.delete({ where: { id: row.id } })));
    expect(row.zeroTime).toBe(7 * H);
    expect(row.timeZone).toBe("Europe/Helsinki");
  });

  it("keeps the 09:00 default without a first start", async () => {
    const caller = makeCaller(null);
    const res = await caller.event.create({ name: "ZT default", date: "2026-06-01" });
    const row = await prisma().event.findUniqueOrThrow({ where: { nameId: res.nameId } });
    cleanups.push(async () => void (await prisma().event.delete({ where: { id: row.id } })));
    expect(row.zeroTime).toBe(9 * H);
    expect(row.timeZone).toBe("Europe/Stockholm");
  });

  it("moving ZeroTime keeps drawn starts at their clock time", async () => {
    const ctx = await event("zt-shift");
    let caller = await freshCaller(ctx);
    const cls = await classWithCourse(caller, ctx, "H21");
    const r = await caller.runner.create({ name: "A", classId: cls.seq, cardNo: 81_001, startTime: 10 * H });
    await ctx.db.class.update({ where: { id: cls.id }, data: { firstStart: 1 * H } }); // 10:00 relative to 09:00
    const undrawn = await caller.runner.create({ name: "B", classId: cls.seq, cardNo: 81_002 });

    await caller.event.setTimeSettings({ zeroTime: 7 * H, timeZone: "Europe/Stockholm" });
    caller = await freshCaller(ctx);

    expect((await caller.runner.getById({ id: r.id as number })).startTime).toBe(10 * H);
    expect((await ctx.db.class.findUniqueOrThrow({ where: { id: cls.id } })).firstStart).toBe(3 * H);
    const u = await ctx.db.runner.findFirstOrThrow({ where: { eventId: ctx.eventId, seq: undrawn.id as number } });
    expect(u.startTime).toBe(0);
    expect((await caller.event.getTimeSettings()).zeroTime).toBe(7 * H);
  });

  it("refuses to move ZeroTime once a finish exists", async () => {
    const ctx = await event("zt-locked");
    const caller = await freshCaller(ctx);
    const cls = await classWithCourse(caller, ctx, "D21");
    await caller.runner.create({ name: "F", classId: cls.seq, cardNo: 81_010, startTime: 10 * H, finishTime: 11 * H });
    expect((await caller.event.getTimeSettings()).zeroTimeLocked).toBe(true);
    await expect(caller.event.setTimeSettings({ zeroTime: 8 * H, timeZone: "Europe/Stockholm" })).rejects.toThrow(
      /after the race has started/,
    );
    // The zone alone may still change.
    await caller.event.setTimeSettings({ zeroTime: 9 * H, timeZone: "Europe/Oslo" });
    expect((await caller.event.getTimeSettings()).timeZone).toBe("Europe/Oslo");
  });

  it("a removed runner's finish also locks ZeroTime", async () => {
    const ctx = await event("zt-locked-removed");
    const caller = await freshCaller(ctx);
    const cls = await classWithCourse(caller, ctx, "D21");
    const r = await caller.runner.create({ name: "R", classId: cls.seq, cardNo: 81_011, startTime: 10 * H, finishTime: 11 * H });
    await ctx.db.runner.updateMany({ where: { eventId: ctx.eventId, seq: r.id as number }, data: { removed: true } });
    expect((await caller.event.getTimeSettings()).zeroTimeLocked).toBe(true);
  });

  it("refuses while a lease is held", async () => {
    const ctx = await event("zt-lease");
    const caller = await freshCaller(ctx);
    await ctx.db.eventLease.create({ data: { eventId: ctx.eventId, holderNodeId: "venue-1" } });
    await expect(caller.event.setTimeSettings({ zeroTime: 8 * H, timeZone: "Europe/Stockholm" })).rejects.toThrow(
      /checked out/,
    );
    // The zone alone may change under a lease.
    await caller.event.setTimeSettings({ zeroTime: 9 * H, timeZone: "Europe/Oslo" });
    expect((await caller.event.getTimeSettings()).timeZone).toBe("Europe/Oslo");
  });

  it("refuses a move that puts a drawn start on the new ZeroTime", async () => {
    const ctx = await event("zt-collide");
    const caller = await freshCaller(ctx);
    const cls = await classWithCourse(caller, ctx, "H35");
    await caller.runner.create({ name: "C", classId: cls.seq, cardNo: 81_020, startTime: 10 * H });
    await expect(caller.event.setTimeSettings({ zeroTime: 10 * H, timeZone: "Europe/Stockholm" })).rejects.toThrow(
      /ZERO_TIME_COLLISION/,
    );
  });

  it("rejects an unknown time zone", async () => {
    const ctx = await event("zt-zone");
    const caller = await freshCaller(ctx);
    await expect(caller.event.setTimeSettings({ zeroTime: 9 * H, timeZone: "Mars/Olympus" })).rejects.toThrow();
  });
});

describe("a start exactly at ZeroTime is refused (RES-04, DB-05)", () => {
  it("on a runner edit", async () => {
    const ctx = await event("zt-edit");
    const caller = await freshCaller(ctx);
    const cls = await classWithCourse(caller, ctx, "H21");
    const r = await caller.runner.create({ name: "E", classId: cls.seq, cardNo: 82_001 });
    await expect(caller.runner.update({ id: r.id as number, startTime: 9 * H })).rejects.toThrow(/ZERO_TIME_COLLISION/);
    await expect(
      caller.runner.create({ name: "E2", classId: cls.seq, cardNo: 82_002, startTime: 9 * H }),
    ).rejects.toThrow(/ZERO_TIME_COLLISION/);
    await caller.runner.update({ id: r.id as number, startTime: 9 * H + 10 });
    expect((await caller.runner.getById({ id: r.id as number })).startTime).toBe(9 * H + 10);
  });

  it("in the draw, which defaults one hour after ZeroTime", async () => {
    const ctx = await event("zt-draw");
    const caller = await freshCaller(ctx);
    const cls = await classWithCourse(caller, ctx, "H21");
    for (let i = 0; i < 3; i++) await caller.runner.create({ name: `D${i}`, classId: cls.seq, cardNo: 83_000 + i });

    const defaults = await caller.draw.defaults();
    expect(defaults.suggestedFirstStart).toBe(10 * H);

    const classes = [{ classId: cls.seq, method: "simultaneous" as const, interval: 0 }];
    const atZero = { firstStart: 9 * H, baseInterval: MIN, maxParallelStarts: 1, detectCourseOverlap: false };
    const bad = await caller.draw.preview({ classes, settings: atZero });
    expect(bad.blockers.join(" ")).toMatch(/ZERO_TIME_COLLISION/);
    await expect(
      caller.draw.execute({ classes, settings: atZero, seed: bad.seed, previewToken: bad.previewToken }),
    ).rejects.toThrow(/ZERO_TIME_COLLISION/);

    const ok = { ...atZero, firstStart: defaults.suggestedFirstStart };
    const good = await caller.draw.preview({ classes, settings: ok });
    expect(good.blockers).toEqual([]);
    await caller.draw.execute({ classes, settings: ok, seed: good.seed, previewToken: good.previewToken });
    const rows = await ctx.db.runner.findMany({ where: { eventId: ctx.eventId, classId: cls.id } });
    expect(rows.every((r) => r.startTime === 1 * H)).toBe(true);
  });

  it("refuses a draw that runs past midnight (RES-16)", async () => {
    const ctx = await event("zt-midnight");
    const caller = await freshCaller(ctx);
    const cls = await classWithCourse(caller, ctx, "N");
    for (let i = 0; i < 3; i++) await caller.runner.create({ name: `N${i}`, classId: cls.seq, cardNo: 84_000 + i });
    const classes = [{ classId: cls.seq, method: "random" as const, interval: 30 * MIN }];
    const settings = { firstStart: 23 * H + 15 * MIN, baseInterval: MIN, maxParallelStarts: 1, detectCourseOverlap: false };
    const p = await caller.draw.preview({ classes, settings });
    expect(p.blockers.join(" ")).toMatch(/PAST_MIDNIGHT/);
  });

  it("requires an interval unless the class has a mass start (RES-13)", async () => {
    const ctx = await event("zt-interval");
    const caller = await freshCaller(ctx);
    const cls = await classWithCourse(caller, ctx, "I");
    const settings = { firstStart: 10 * H, baseInterval: MIN, maxParallelStarts: 1, detectCourseOverlap: false };
    await expect(
      caller.draw.preview({ classes: [{ classId: cls.seq, method: "random", interval: 0 }], settings }),
    ).rejects.toThrow(/interval/);
  });
});

describe("starts before ZeroTime (RES-05)", () => {
  it("are on the start screen, in the forest and ranked", async () => {
    const ctx = await event("zt-early");
    const caller = await freshCaller(ctx);
    const cls = await classWithCourse(caller, ctx, "H21");
    // ZeroTime 09:00. Early: 08:30 start, 08:55 finish. Late: 10:00 → 10:40.
    const early = await caller.runner.create({ name: "Early", classId: cls.seq, cardNo: 85_001, startTime: 8 * H + 30 * MIN });
    const late = await caller.runner.create({ name: "Late", classId: cls.seq, cardNo: 85_002, startTime: 10 * H });
    expect((await ctx.db.runner.findFirstOrThrow({ where: { eventId: ctx.eventId, seq: early.id as number } })).startTime).toBe(
      -30 * MIN,
    );

    const screen = await caller.event.startScreen();
    expect(screen.runners.map((r) => r.name)).toEqual(["Early", "Late"]);
    expect(screen.runners[0].startTime).toBe(8 * H + 30 * MIN);

    const startList = await caller.lists.startList();
    const earlyRow = startList.find((r) => r.name === "Early")!;
    // Whatever the time of day of this test run, an 08:30 start is
    // recognised as a start (it used to be "no start" because it is
    // negative when stored).
    const nowDs = timeOfDayDs(Date.now(), "Europe/Stockholm");
    expect(earlyRow.hasStarted ?? false).toBe(nowDs >= 8 * H + 30 * MIN);

    await caller.runner.update({ id: early.id as number, finishTime: 8 * H + 55 * MIN, status: 1 });
    await caller.runner.update({ id: late.id as number, finishTime: 10 * H + 40 * MIN, status: 1 });
    const receipt = await caller.race.finishReceipt({ runnerId: early.id as number });
    expect(receipt?.position).toEqual({ rank: 1, total: 2 });
  });
});

describe("the event's time zone (RES-06)", () => {
  it("serverTime is the time of day in the event zone", async () => {
    const ctx = await event("zt-tz");
    await ctx.db.event.update({ where: { id: ctx.eventId }, data: { timeZone: "Asia/Tokyo" } });
    const caller = await freshCaller(ctx);
    const t = await caller.race.serverTime();
    expect(t.timeZone).toBe("Asia/Tokyo");
    expect(Math.abs(t.deciseconds - timeOfDayDs(t.now, "Asia/Tokyo"))).toBeLessThanOrEqual(1);
    // Tokyo is never the same time of day as UTC (+9 h, no DST).
    expect(Math.abs(t.deciseconds - timeOfDayDs(t.now, "UTC"))).toBeGreaterThan(H);
  });
});

describe("backup-memory punches (RES-08)", () => {
  it("are stored relative, listed as clock time, and count only once pushed", async () => {
    const ctx = await event("zt-backup");
    const caller = await freshCaller(ctx);
    const cls = await classWithCourse(caller, ctx, "B1");
    const cardNo = 86_001;
    const runner = await caller.runner.create({ name: "Rescue", classId: cls.seq, cardNo, startTime: 10 * H });
    const ctrl32 = await ctx.db.control.findFirstOrThrow({ where: { eventId: ctx.eventId, codes: "32" } });

    // The unit at control 32 has a 10:15 punch; the card lost it.
    const imported = await caller.control.importBackupPunches({
      controlId: ctrl32.seq,
      punches: [{ cardNo, punchTime: 10 * H + 15 * MIN }],
    });
    expect(imported.inserted).toBe(1);
    const row = await ctx.db.punch.findFirstOrThrow({ where: { eventId: ctx.eventId, source: "backup_memory" } });
    expect(row.time).toBe(1 * H + 15 * MIN);

    const listed = await caller.control.listAllBackupPunches();
    expect(listed).toHaveLength(1);
    expect(listed[0].punchTime).toBe(10 * H + 15 * MIN);

    const card = {
      cardNo,
      cardType: "SI10",
      punches: [
        { controlCode: 31, time: 10 * H + 5 * MIN },
        { controlCode: 33, time: 10 * H + 25 * MIN },
      ],
      startTime: 10 * H,
      finishTime: 10 * H + 30 * MIN,
    };
    // Before the push the backup row is evidence only: 32 is missing.
    const readStatus = async () => {
      await caller.cardReadout.storeReadout(card);
      const r = await caller.cardReadout.readout({ cardNo });
      if (!r.found) throw new Error("runner not found");
      return r;
    };
    // Before the push the backup row is evidence only: 32 is missing.
    expect((await readStatus()).timing.status).toBe(3);

    await caller.control.pushBackupPunch({ punchId: listed[0].id });
    const mirror = await ctx.db.punch.findFirstOrThrow({ where: { eventId: ctx.eventId, source: "manual" } });
    expect(mirror.time).toBe(1 * H + 15 * MIN);

    const after = await readStatus();
    expect(after.timing.status).toBe(1);
    expect(after.controls.find((c) => c.controlCode === 32)?.status).toBe("ok");
    expect(runner.id).toBeTruthy();
  });
});

describe("backup punches through the journal (RES-08)", () => {
  function wire(nameId: string, payload: Record<string, unknown>) {
    return {
      id: randomUUID(),
      type: "punch.recorded" as never,
      competitionId: nameId,
      stationId: "venue",
      timestamp: 1_700_000_000_000,
      payload,
    };
  }

  it("a peer stores the import as evidence and the push as a manual mirror", async () => {
    const ctx = await event("zt-journal");
    const caller = await freshCaller(ctx);
    const backupId = randomUUID();
    const mirrorId = randomUUID();
    const base = { cardNo: 87_001, controlCode: 32, time: 10 * H + 15 * MIN, origin: "backup_memory" };
    await caller.events.push({ events: [wire(ctx.nameId, { ...base, id: backupId, backupRow: true })] });
    let rows = await ctx.db.punch.findMany({ where: { eventId: ctx.eventId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: backupId, source: "backup_memory", isOriginal: true, time: 1 * H + 15 * MIN });

    await caller.events.push({ events: [wire(ctx.nameId, { ...base, id: mirrorId, pushedFrom: backupId })] });
    rows = await ctx.db.punch.findMany({ where: { eventId: ctx.eventId }, orderBy: { importedAt: "asc" } });
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.id === backupId)).toMatchObject({ source: "backup_memory", isOriginal: false });
    expect(rows.find((r) => r.id === mirrorId)).toMatchObject({ source: "manual", time: 1 * H + 15 * MIN });
  });

  it("an entry from an older node (no flag) still lands as a live punch", async () => {
    const ctx = await event("zt-journal-legacy");
    const caller = await freshCaller(ctx);
    await caller.events.push({
      events: [wire(ctx.nameId, { id: randomUUID(), cardNo: 87_002, controlCode: 33, time: 10 * H, origin: "backup_memory" })],
    });
    const rows = await ctx.db.punch.findMany({ where: { eventId: ctx.eventId } });
    expect(rows).toHaveLength(1);
    expect(rows[0].source).toBe("card");
  });

  it("an import exactly at ZeroTime is kept as a time, not 'no time'", async () => {
    const ctx = await event("zt-backup-zero");
    const caller = await freshCaller(ctx);
    const ctrl = await ctx.db.control.create({ data: { eventId: ctx.eventId, codes: "40", name: "" } });
    await caller.control.importBackupPunches({ controlId: ctrl.seq, punches: [{ cardNo: 87_003, punchTime: 9 * H }] });
    const row = await ctx.db.punch.findFirstOrThrow({ where: { eventId: ctx.eventId } });
    expect(row.time).toBe(1);
  });
});

describe("running time across midnight (RES-16)", () => {
  it("23:30 → 00:20 is 50 minutes", () => {
    expect(runningTimeDs(23 * H + 30 * MIN, 20 * MIN)).toBe(50 * MIN);
  });

  it("a finish before a daytime start gives no result, not a 23:55 run", async () => {
    const ctx = await event("zt-neg");
    const caller = await freshCaller(ctx);
    const cls = await classWithCourse(caller, ctx, "X");
    const a = await caller.runner.create({ name: "Wrong", classId: cls.seq, cardNo: 88_001, startTime: 11 * H });
    const b = await caller.runner.create({ name: "Right", classId: cls.seq, cardNo: 88_002, startTime: 10 * H });
    await caller.runner.update({ id: a.id as number, finishTime: 10 * H + 55 * MIN, status: 1 });
    await caller.runner.update({ id: b.id as number, finishTime: 10 * H + 40 * MIN, status: 1 });
    const wrong = await caller.race.finishReceipt({ runnerId: a.id as number });
    expect(wrong?.runningTime).toBe(0);
    expect(wrong?.position).toBeNull();
    const right = await caller.race.finishReceipt({ runnerId: b.id as number });
    // The wrong run is not counted as a (23:55) result in the class.
    expect(right?.position).toEqual({ rank: 1, total: 1 });
  });
});
