/**
 * Integration tests for the readout-station backup-memory recovery flow.
 *
 * The disaster-recovery path:
 *   1. SI cards are read on a standalone readout station while Oxygen is
 *      down — readouts are stored only in the station's backup flash.
 *   2. Operator later dumps the flash with `webserial.readBackupMemory`
 *      and `cardReadout.importReadoutBackups` stages the parsed records
 *      in `card_readout_backups`.
 *   3. Operator reviews on BackupPunchesPage and `pushReadoutBackup`
 *      replays each row through the live `storeReadoutImpl` pipeline.
 *
 * Each test covers one of: import dedup, push effect, push idempotency.
 */

import { describe, it, expect, afterAll } from "vitest";
import { createTestEvent, disconnect } from "../helpers/test-db.js";
import { makeCaller } from "../helpers/caller.js";

afterAll(async () => {
  await disconnect();
});

interface Fixture {
  ctx: Awaited<ReturnType<typeof createTestEvent>>;
  caller: ReturnType<typeof makeCaller>;
  runnerSeq: number;
  cardNo: number;
}

async function buildFixture(label: string): Promise<Fixture> {
  const ctx = await createTestEvent(label);
  const caller = makeCaller(ctx.event);

  // Three controls, one course, one class, one runner with a registered
  // card — same shape kiosk-finish.test.ts uses.
  const controls = await Promise.all([
    ctx.db.control.create({
      data: { eventId: ctx.eventId, codes: "31", name: "" },
    }),
    ctx.db.control.create({
      data: { eventId: ctx.eventId, codes: "32", name: "" },
    }),
    ctx.db.control.create({
      data: { eventId: ctx.eventId, codes: "33", name: "" },
    }),
  ]);
  const course = await ctx.db.course.create({
    data: { eventId: ctx.eventId, name: "B1", lengthM: 2500 },
  });
  await ctx.db.courseControl.createMany({
    data: controls.map((c, i) => ({
      courseId: course.id,
      controlId: c.id,
      position: i + 1,
    })),
  });
  const cls = await ctx.db.class.create({
    data: { eventId: ctx.eventId, name: "B1", courseId: course.id },
  });
  const cardNo = 666_001;
  const runner = await caller.runner.create({
    name: "Backup Recovery Runner",
    classId: cls.seq,
    cardNo,
    startTime: 360_000,
  });
  return { ctx, caller, runnerSeq: runner.id as number, cardNo };
}

/** Sample readout record matching the runner's course. */
function sampleRecord(cardNo: number, slotAddress = 0x200) {
  return {
    slotAddress,
    cardNo,
    cardType: "SIAC",
    punches: [
      { controlCode: 31, time: 366_000 },
      { controlCode: 32, time: 372_000 },
      { controlCode: 33, time: 378_000 },
    ],
    startTime: 360_000,
    finishTime: 384_000,
    checkTime: 358_000,
    clearTime: null,
  };
}

describe("readout-backup recovery flow", () => {
  it("imports records and dedups on re-import via punchesHash", async () => {
    const f = await buildFixture("rb-dedup");
    try {
      const r1 = await f.caller.cardReadout.importReadoutBackups({
        stationSerial: 12345,
        records: [sampleRecord(f.cardNo)],
      });
      expect(r1.inserted).toBe(1);
      expect(r1.duplicates).toBe(0);

      // Same payload, different stationSerial — should still dedup on
      // (eventId, punchesHash). The same logical readout never lands
      // twice.
      const r2 = await f.caller.cardReadout.importReadoutBackups({
        stationSerial: 67890,
        records: [sampleRecord(f.cardNo)],
      });
      expect(r2.inserted).toBe(0);
      expect(r2.duplicates).toBe(1);

      const rows = await f.caller.cardReadout.listReadoutBackups();
      expect(rows).toHaveLength(1);
      expect(rows[0].matchStatus).toBe("pending");
      expect(rows[0].runner?.name).toBe("Backup Recovery Runner");
    } finally {
      await f.ctx.cleanup();
    }
  });

  it("push replays the backup through the live storeReadout pipeline", async () => {
    const f = await buildFixture("rb-push");
    try {
      await f.caller.cardReadout.importReadoutBackups({
        stationSerial: 12345,
        records: [sampleRecord(f.cardNo)],
      });
      const rowsBefore = await f.caller.cardReadout.listReadoutBackups();
      expect(rowsBefore).toHaveLength(1);
      const backupId = rowsBefore[0].id;
      expect(rowsBefore[0].pushedAt).toBeNull();

      const pushResult = await f.caller.cardReadout.pushReadoutBackup({
        backupId,
      });
      expect(pushResult.ok).toBe(true);
      expect(pushResult.alreadyPushed).toBe(false);
      expect(pushResult.pushedReadoutId).toBeTruthy();
      expect(pushResult.linkedRunnerId).toBe(f.runnerSeq);

      // The live cardReadout row should exist downstream of the push.
      const liveReadouts = await f.ctx.db.cardReadout.findMany({
        where: { eventId: f.ctx.eventId, cardNo: f.cardNo },
      });
      expect(liveReadouts).toHaveLength(1);

      // Backup row should now report as pushed.
      const rowsAfter = await f.caller.cardReadout.listReadoutBackups();
      expect(rowsAfter[0].matchStatus).toBe("pushed");
      expect(rowsAfter[0].pushedAt).not.toBeNull();
      expect(rowsAfter[0].pushedReadoutId).toBe(pushResult.pushedReadoutId);
    } finally {
      await f.ctx.cleanup();
    }
  });

  it("push is idempotent — calling twice does not duplicate work", async () => {
    const f = await buildFixture("rb-idempotent");
    try {
      await f.caller.cardReadout.importReadoutBackups({
        stationSerial: 12345,
        records: [sampleRecord(f.cardNo)],
      });
      const [row] = await f.caller.cardReadout.listReadoutBackups();
      const first = await f.caller.cardReadout.pushReadoutBackup({
        backupId: row.id,
      });
      expect(first.alreadyPushed).toBe(false);

      const second = await f.caller.cardReadout.pushReadoutBackup({
        backupId: row.id,
      });
      expect(second.alreadyPushed).toBe(true);
      expect(second.pushedReadoutId).toBe(first.pushedReadoutId);

      // Only one live cardReadout row total.
      const liveReadouts = await f.ctx.db.cardReadout.findMany({
        where: { eventId: f.ctx.eventId, cardNo: f.cardNo },
      });
      expect(liveReadouts).toHaveLength(1);
    } finally {
      await f.ctx.cleanup();
    }
  });

  it("imports for an unregistered card surface as no_runner", async () => {
    const f = await buildFixture("rb-no-runner");
    try {
      const phantomCard = 999_999;
      await f.caller.cardReadout.importReadoutBackups({
        stationSerial: 12345,
        records: [sampleRecord(phantomCard)],
      });
      const rows = await f.caller.cardReadout.listReadoutBackups();
      const phantom = rows.find((r) => r.cardNo === phantomCard);
      expect(phantom).toBeDefined();
      expect(phantom!.matchStatus).toBe("no_runner");
      expect(phantom!.runner).toBeNull();
    } finally {
      await f.ctx.cleanup();
    }
  });
});
