/**
 * Work package 2 (RES-01, SI-10, SI-11, WEB-53): the guarded apply of a
 * readout result. A re-read never overwrites a DQ or a hand-set status/finish,
 * a worse read is held for confirmation, and a backup push applies a result.
 */
import { describe, it, expect, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { TRPCError } from "@trpc/server";
import { RunnerStatus } from "@oxygen/shared";
import { createTestEvent, disconnect } from "../helpers/test-db.js";
import { makeCaller } from "../helpers/caller.js";

afterAll(async () => {
  await disconnect();
});

async function build(label: string) {
  const ctx = await createTestEvent(label);
  const caller = makeCaller(ctx.event);
  const controls = await Promise.all(
    ["31", "32", "33"].map((codes) =>
      ctx.db.control.create({ data: { eventId: ctx.eventId, codes, name: "" } }),
    ),
  );
  const course = await ctx.db.course.create({
    data: { eventId: ctx.eventId, name: "B1", lengthM: 2500 },
  });
  await ctx.db.courseControl.createMany({
    data: controls.map((c, i) => ({ courseId: course.id, controlId: c.id, position: i + 1 })),
  });
  const cls = await ctx.db.class.create({
    data: { eventId: ctx.eventId, name: "B1", courseId: course.id },
  });
  const cardNo = 777_001;
  const runner = await caller.runner.create({
    name: "Guarded Runner",
    classId: cls.seq,
    cardNo,
    startTime: 360_000,
  });
  const seq = runner.id as number;
  const row = () => ctx.db.runner.findFirstOrThrow({ where: { eventId: ctx.eventId, seq } });
  return { ctx, caller, cardNo, seq, row };
}

const goodRead = (cardNo: number) => ({
  cardNo,
  cardType: "SIAC",
  punches: [
    { controlCode: 31, time: 366_000 },
    { controlCode: 32, time: 372_000 },
    { controlCode: 33, time: 378_000 },
  ],
  startTime: 360_000,
  finishTime: 384_000,
});
const emptyRead = (cardNo: number) => ({ cardNo, cardType: "SIAC", punches: [] });

/** What DeviceManager does with a read: store, evaluate, apply. */
async function readAndApply(
  f: Awaited<ReturnType<typeof build>>,
  read: ReturnType<typeof goodRead> | ReturnType<typeof emptyRead>,
  extra: { confirmed?: boolean } = {},
) {
  await f.caller.cardReadout.storeReadout(read);
  const r = await f.caller.cardReadout.readout({ cardNo: f.cardNo });
  if (!r.found) throw new Error("runner not found");
  return f.caller.cardReadout.applyResult({
    runnerId: f.seq,
    status: r.timing.status,
    finishTime: r.timing.finishTime,
    startTime: r.timing.startTime,
    ...extra,
  });
}

describe("guarded readout apply", () => {
  it("applies a first read and treats an identical re-read as unchanged", async () => {
    const f = await build("ra-first");
    try {
      const a = await readAndApply(f, goodRead(f.cardNo));
      expect(a.outcome).toBe("applied");
      expect((await f.row()).status).toBe("ok");
      const journalBefore = await f.ctx.db.journalEntry.count({
        where: { eventId: f.ctx.eventId, type: "result.applied" },
      });
      const b = await readAndApply(f, goodRead(f.cardNo));
      expect(b.outcome).toBe("unchanged");
      const journalAfter = await f.ctx.db.journalEntry.count({
        where: { eventId: f.ctx.eventId, type: "result.applied" },
      });
      expect(journalAfter).toBe(journalBefore);
    } finally {
      await f.ctx.cleanup();
    }
  });

  it("keeps a DQ on a re-read, even when confirmed", async () => {
    const f = await build("ra-dq");
    try {
      await readAndApply(f, goodRead(f.cardNo));
      await f.caller.runner.update({ id: f.seq, status: RunnerStatus.DQ });
      for (const confirmed of [false, true]) {
        const r = await readAndApply(f, goodRead(f.cardNo), { confirmed });
        expect(r.outcome).toBe("protected");
        expect((await f.row()).status).toBe("dq");
      }
    } finally {
      await f.ctx.cleanup();
    }
  });

  it("keeps a hand-set status (MP corrected to OK)", async () => {
    const f = await build("ra-manual-status");
    try {
      // Missing the last control: the matcher says MP.
      const mp = goodRead(f.cardNo);
      mp.punches = mp.punches.slice(0, 2);
      await readAndApply(f, mp);
      expect((await f.row()).status).toBe("missing_punch");
      await f.caller.runner.update({ id: f.seq, status: RunnerStatus.OK });
      expect((await f.row()).statusManual).toBe(true);
      const r = await readAndApply(f, mp);
      expect(r.outcome).toBe("protected");
      expect((await f.row()).status).toBe("ok");
    } finally {
      await f.ctx.cleanup();
    }
  });

  it("holds a cleared card: result and punches stay, confirm replaces the result", async () => {
    const f = await build("ra-cleared");
    try {
      await readAndApply(f, goodRead(f.cardNo));
      const before = await f.row();
      const cardBefore = await f.ctx.db.card.findFirstOrThrow({
        where: { eventId: f.ctx.eventId, cardNo: f.cardNo },
      });
      const stored = await f.caller.cardReadout.storeReadout(emptyRead(f.cardNo));
      expect(stored.cardHeld).toBe(true);
      const cardAfter = await f.ctx.db.card.findFirstOrThrow({
        where: { eventId: f.ctx.eventId, cardNo: f.cardNo },
      });
      expect(cardAfter.punchesRaw).toBe(cardBefore.punchesRaw);

      // The held card still evaluates to the stored result: nothing changes.
      const r = await readAndApply(f, emptyRead(f.cardNo));
      expect(r.outcome).toBe("unchanged");
      // A client-computed DNF over the OK result (e.g. an offline queue) asks.
      const ask = await f.caller.cardReadout.applyResult({
        runnerId: f.seq,
        status: RunnerStatus.DNF,
        finishTime: 0,
        startTime: 360_000,
      });
      expect(ask.ok).toBe(false);
      expect(ask.outcome).toBe("needsConfirmation");
      expect(ask.reason).toBe("no-finish");
      const after = await f.row();
      expect(after.status).toBe("ok");
      expect(after.finishTime).toBe(before.finishTime);

      // The operator confirms: the worse result goes in.
      const c = await f.caller.cardReadout.applyResult({
        runnerId: f.seq,
        status: RunnerStatus.DNF,
        finishTime: 0,
        startTime: 360_000,
        confirmed: true,
      });
      expect(c.outcome).toBe("applied");
      expect((await f.row()).status).toBe("dnf");
    } finally {
      await f.ctx.cleanup();
    }
  });

  it("holds a read the reader marks as not fresh", async () => {
    const f = await build("ra-stale");
    try {
      await readAndApply(f, goodRead(f.cardNo));
      const r = await f.caller.cardReadout.applyResult({
        runnerId: f.seq,
        status: RunnerStatus.MissingPunch,
        finishTime: 384_000,
        startTime: 360_000,
        punchesFresh: false,
      });
      expect(r.outcome).toBe("needsConfirmation");
      expect(r.reason).toBe("stale-punches");
      expect((await f.row()).status).toBe("ok");
    } finally {
      await f.ctx.cleanup();
    }
  });

  it("a hand-keyed finish survives a card without a finish punch", async () => {
    const f = await build("ra-manual-finish");
    try {
      const fin = await f.caller.race.recordFinish({ id: f.seq, finishTimeAbsolute: 384_000 });
      expect(fin.ok).toBe(true);
      expect((await f.row()).finishManual).toBe(true);
      // All controls, no finish punch and no header finish.
      const noFinish = goodRead(f.cardNo);
      delete (noFinish as { finishTime?: number }).finishTime;
      const r = await readAndApply(f, noFinish);
      expect(["applied", "unchanged"]).toContain(r.outcome);
      const row = await f.row();
      expect(row.finishTime).toBeGreaterThan(0);
      expect(row.status).toBe("ok");
    } finally {
      await f.ctx.cleanup();
    }
  });
});

describe("recordFinish overwrite (WEB-53)", () => {
  it("refuses a different finish without allowOverwrite, accepts it with", async () => {
    const f = await build("ra-finish-overwrite");
    try {
      await f.caller.race.recordFinish({ id: f.seq, finishTimeAbsolute: 384_000 });
      const err = await f.caller.race
        .recordFinish({ id: f.seq, finishTimeAbsolute: 390_000 })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(TRPCError);
      expect((err as TRPCError).code).toBe("CONFLICT");
      expect((err as TRPCError).message).toMatch(/^FINISH_EXISTS/);
      // Same time again is idempotent.
      await f.caller.race.recordFinish({ id: f.seq, finishTimeAbsolute: 384_000 });
      await f.caller.race.recordFinish({ id: f.seq, finishTimeAbsolute: 390_000, allowOverwrite: true });
      expect((await f.row()).finishTime).toBeGreaterThan(0);
    } finally {
      await f.ctx.cleanup();
    }
  });
});

describe("backup push applies a result (SI-11)", () => {
  it("writes status and times for a linked runner", async () => {
    const f = await build("ra-backup");
    try {
      await f.caller.cardReadout.importReadoutBackups({
        stationSerial: 1,
        records: [
          {
            slotAddress: 0x200,
            cardNo: f.cardNo,
            cardType: "SIAC",
            punches: goodRead(f.cardNo).punches,
            startTime: 360_000,
            finishTime: 384_000,
            checkTime: 358_000,
            clearTime: null,
          },
        ],
      });
      const [b] = await f.caller.cardReadout.listReadoutBackups();
      const push = await f.caller.cardReadout.pushReadoutBackup({ backupId: b.id });
      expect(push.alreadyPushed).toBe(false);
      expect(push.apply?.outcome).toBe("applied");
      const row = await f.row();
      expect(row.status).toBe("ok");
      expect(row.finishTime).toBeGreaterThan(0);
    } finally {
      await f.ctx.cleanup();
    }
  });
});

describe("result.applied ingest", () => {
  it("does not overwrite a DQ", async () => {
    const f = await build("ra-ingest");
    try {
      await readAndApply(f, goodRead(f.cardNo));
      await f.caller.runner.update({ id: f.seq, status: RunnerStatus.DQ });
      const res = await f.caller.events.push({
        events: [
          {
            id: randomUUID(),
            type: "result.applied" as never,
            competitionId: f.ctx.event.nameId,
            stationId: "station-A",
            timestamp: 1_700_000_000_000,
            payload: {
              cardNo: f.cardNo,
              runnerId: f.seq,
              status: RunnerStatus.OK,
              finishTime: 384_000,
              startTime: 360_000,
            },
          },
        ],
      });
      expect(res.failed).toHaveLength(0);
      expect((await f.row()).status).toBe("dq");
    } finally {
      await f.ctx.cleanup();
    }
  });
});
