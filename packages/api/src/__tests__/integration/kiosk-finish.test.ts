/**
 * Integration tests for kiosk finish recording and card readout evaluation.
 *
 * Seeds a competition with classes, courses, controls, and runners with
 * various punch data permutations (OK, MP, DNF, DNS/no card).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestDb, type TestDbContext } from "../helpers/test-db.js";
import { makeCaller } from "../helpers/caller.js";
import { RunnerStatus } from "@oxygen/shared";

let ctx: TestDbContext;

// Fixture IDs populated in beforeAll
let classId: number;
let courseId: number;
let runnerOk: { id: number; cardNo: number };
let runnerMp: { id: number; cardNo: number };
let runnerDnf: { id: number; cardNo: number };
let runnerDns: { id: number; cardNo: number };

// Course: 5 controls (31, 32, 33, 34, 35) + start + finish
const CONTROLS = [31, 32, 33, 34, 35];
const START_TIME = 360000; // 10:00:00 in deciseconds (absolute)
const ZERO_TIME = 324000; // 09:00:00 in deciseconds (from createCompetitionDatabase)
const REL_START = START_TIME - ZERO_TIME; // ZeroTime-relative start for direct DB writes

beforeAll(async () => {
  ctx = await createTestDb("kiosk");
  const caller = makeCaller();

  // Create class
  const cls = await ctx.client.oClass.create({
    data: {
      Name: "H21",
      Course: 0,
      FirstStart: 0,
      StartInterval: 0,
      SortIndex: 1,
      Removed: false,
      Counter: 0,
      FreeStart: 0,
    },
  });
  classId = cls.Id;

  // Create course with 5 controls
  const course = await ctx.client.oCourse.create({
    data: {
      Name: "H21 Lång",
      Controls: CONTROLS.join(";") + ";",
      Length: 5200,
      Legs: "1200;800;1100;900;1200;",
    },
  });
  courseId = course.Id;

  // Link class to course
  await ctx.client.oClass.update({
    where: { Id: classId },
    data: { Course: courseId },
  });

  // ── Runner A: OK — all punches + finish ──────────────────
  const rA = await caller.runner.create({ name: "Anna OK", classId, cardNo: 500001 });
  await ctx.client.oRunner.update({
    where: { Id: rA.id },
    data: { StartTime: REL_START }, // DB stores ZeroTime-relative
  });
  // Build MeOS punch string (ZeroTime-relative): start, 5 controls, finish
  // Times: start 10:00:00, controls at +2min intervals, finish at +12min
  const okPunches = [
    `1-${REL_START / 10}.0`,          // start (type 1)
    `31-${(REL_START + 1200) / 10}.0`, // control 31 at +2:00
    `32-${(REL_START + 2400) / 10}.0`, // control 32 at +4:00
    `33-${(REL_START + 3600) / 10}.0`, // control 33 at +6:00
    `34-${(REL_START + 4800) / 10}.0`, // control 34 at +8:00
    `35-${(REL_START + 6000) / 10}.0`, // control 35 at +10:00
    `2-${(REL_START + 7200) / 10}.0`,  // finish (type 2) at +12:00
  ].join(";") + ";";
  const cardA = await ctx.client.oCard.create({
    data: { CardNo: 500001, Punches: okPunches, ReadId: 0 },
  });
  await ctx.client.oRunner.update({
    where: { Id: rA.id },
    data: { Card: cardA.Id },
  });
  runnerOk = { id: rA.id, cardNo: 500001 };

  // ── Runner B: MP — missing control 33 ────────────────────
  const rB = await caller.runner.create({ name: "Björn MP", classId, cardNo: 500002 });
  await ctx.client.oRunner.update({
    where: { Id: rB.id },
    data: { StartTime: REL_START },
  });
  const mpPunches = [
    `1-${REL_START / 10}.0`,
    `31-${(REL_START + 1200) / 10}.0`,
    `32-${(REL_START + 2400) / 10}.0`,
    // control 33 is MISSING
    `34-${(REL_START + 4800) / 10}.0`,
    `35-${(REL_START + 6000) / 10}.0`,
    `2-${(REL_START + 7200) / 10}.0`,
  ].join(";") + ";";
  const cardB = await ctx.client.oCard.create({
    data: { CardNo: 500002, Punches: mpPunches, ReadId: 0 },
  });
  await ctx.client.oRunner.update({
    where: { Id: rB.id },
    data: { Card: cardB.Id },
  });
  runnerMp = { id: rB.id, cardNo: 500002 };

  // ── Runner C: DNF — has punches but NO finish punch ──────
  const rC = await caller.runner.create({ name: "Clara DNF", classId, cardNo: 500003 });
  await ctx.client.oRunner.update({
    where: { Id: rC.id },
    data: { StartTime: REL_START },
  });
  const dnfPunches = [
    `1-${REL_START / 10}.0`,
    `31-${(REL_START + 1200) / 10}.0`,
    `32-${(REL_START + 2400) / 10}.0`,
    `33-${(REL_START + 3600) / 10}.0`,
    // stopped after control 33, no finish
  ].join(";") + ";";
  const cardC = await ctx.client.oCard.create({
    data: { CardNo: 500003, Punches: dnfPunches, ReadId: 0 },
  });
  await ctx.client.oRunner.update({
    where: { Id: rC.id },
    data: { Card: cardC.Id },
  });
  runnerDnf = { id: rC.id, cardNo: 500003 };

  // ── Runner D: DNS — registered but no card data at all ───
  const rD = await caller.runner.create({ name: "David DNS", classId, cardNo: 500004 });
  await ctx.client.oRunner.update({
    where: { Id: rD.id },
    data: { StartTime: REL_START },
  });
  runnerDns = { id: rD.id, cardNo: 500004 };

  // ── Create oControl entries for stale punch detection ─────
  for (const code of CONTROLS) {
    await ctx.client.oControl.create({
      data: { Name: `Control ${code}`, Numbers: `${code}`, Status: 1 },
    });
  }
}, 60000);

afterAll(async () => {
  await ctx.cleanup();
}, 30000);

// ─── Card readout evaluation ───────────────────────────────

describe("cardReadout.readoutByRunner", () => {
  it("evaluates OK status for runner with all punches + finish", async () => {
    const caller = makeCaller();
    const result = await caller.cardReadout.readoutByRunner({ runnerId: runnerOk.id });

    expect(result).not.toBeNull();
    expect(result!.timing.status).toBe(RunnerStatus.OK);
    expect(result!.timing.finishTime).toBe(START_TIME + 7200);
    expect(result!.timing.runningTime).toBe(7200); // 12 minutes in deciseconds
    expect(result!.controls).toHaveLength(CONTROLS.length);
    expect(result!.controls.every((c) => c.status === "ok")).toBe(true);
    expect(result!.missingControls).toHaveLength(0);
    expect(result!.hasCard).toBe(true);
  });

  it("evaluates MP status for runner missing control 33", async () => {
    const caller = makeCaller();
    const result = await caller.cardReadout.readoutByRunner({ runnerId: runnerMp.id });

    expect(result).not.toBeNull();
    expect(result!.timing.status).toBe(RunnerStatus.MissingPunch);
    expect(result!.timing.finishTime).toBe(START_TIME + 7200);
    expect(result!.missingControls).toEqual([33]);
    expect(result!.controls).toHaveLength(CONTROLS.length);
    // 4 ok + 1 missing
    expect(result!.controls.filter((c) => c.status === "ok")).toHaveLength(4);
    expect(result!.controls.filter((c) => c.status === "missing")).toHaveLength(1);
    expect(result!.hasCard).toBe(true);
  });

  it("evaluates DNF status for runner with no finish punch", async () => {
    const caller = makeCaller();
    const result = await caller.cardReadout.readoutByRunner({ runnerId: runnerDnf.id });

    expect(result).not.toBeNull();
    expect(result!.timing.status).toBe(RunnerStatus.DNF);
    expect(result!.timing.finishTime).toBe(0);
    expect(result!.timing.runningTime).toBe(0);
    // Has 3 control punches (31, 32, 33) — 2 missing (34, 35)
    expect(result!.controls.filter((c) => c.status === "ok")).toHaveLength(3);
    expect(result!.missingControls).toEqual([34, 35]);
    expect(result!.hasCard).toBe(true);
  });

  it("returns no card data for DNS runner", async () => {
    const caller = makeCaller();
    const result = await caller.cardReadout.readoutByRunner({ runnerId: runnerDns.id });

    expect(result).not.toBeNull();
    expect(result!.hasCard).toBe(false);
    expect(result!.timing.finishTime).toBe(0);
    expect(result!.timing.runningTime).toBe(0);
    expect(result!.rawPunchCount).toBe(0);
  });
});

// ─── race.recordFinish ─────────────────────────────────────

describe("race.recordFinish", () => {
  it("records finish time and sets status OK", async () => {
    const caller = makeCaller();

    // Runner A has all punches but FinishTime is 0 in oRunner (not yet recorded)
    const before = await caller.runner.getById({ id: runnerOk.id });
    expect(before.finishTime).toBe(0);

    // Record finish using SI card's finish punch time
    const finishTime = START_TIME + 7200; // from card data
    const result = await caller.race.recordFinish({
      runnerId: runnerOk.id,
      finishTime,
    });

    expect(result.finishTime).toBe(finishTime);
    expect(result.status).toBe(RunnerStatus.OK);
    expect(result.runningTime).toBe(7200);

    // Verify persisted
    const after = await caller.runner.getById({ id: runnerOk.id });
    expect(after.finishTime).toBe(finishTime);
    expect(after.status).toBe(RunnerStatus.OK);
  });

  it("is idempotent — re-recording same finish does not error", async () => {
    const caller = makeCaller();
    const finishTime = START_TIME + 7200;

    // Call again for the same runner
    const result = await caller.race.recordFinish({
      runnerId: runnerOk.id,
      finishTime,
    });

    expect(result.finishTime).toBe(finishTime);
    expect(result.status).toBe(RunnerStatus.OK);
  });

  it("records finish for MP runner (status stays OK until readout evaluates)", async () => {
    const caller = makeCaller();
    const finishTime = START_TIME + 7200;

    const result = await caller.race.recordFinish({
      runnerId: runnerMp.id,
      finishTime,
    });

    // recordFinish sets status OK based on start+finish presence
    // Full punch evaluation (MP detection) happens in readout
    expect(result.finishTime).toBe(finishTime);
    expect(result.status).toBe(RunnerStatus.OK);
    expect(result.runningTime).toBe(7200);
  });
});

// ─── race.finishReceipt ────────────────────────────────────

describe("race.finishReceipt", () => {
  it("returns full receipt data with splits for OK runner", async () => {
    const caller = makeCaller();
    const receipt = await caller.race.finishReceipt({ runnerId: runnerOk.id });

    expect(receipt).not.toBeNull();
    expect(receipt!.runner.name).toBe("Anna OK");
    expect(receipt!.runner.className).toBe("H21");
    expect(receipt!.timing.status).toBe(RunnerStatus.OK);
    expect(receipt!.timing.runningTime).toBe(7200);

    // Should have 5 control splits
    expect(receipt!.controls).toHaveLength(CONTROLS.length);
    expect(receipt!.controls[0].controlCode).toBe(31);
    expect(receipt!.controls[0].splitTime).toBe(1200); // 2 min
    expect(receipt!.controls[0].cumTime).toBe(1200);
    expect(receipt!.controls[1].controlCode).toBe(32);
    expect(receipt!.controls[1].splitTime).toBe(1200);
    expect(receipt!.controls[1].cumTime).toBe(2400);

    // Course info
    expect(receipt!.course).not.toBeNull();
    expect(receipt!.course!.name).toBe("H21 Lång");
    expect(receipt!.course!.length).toBe(5200);
    expect(receipt!.course!.controlCount).toBe(5);

    // Leg lengths
    expect(receipt!.controls[0].legLength).toBe(1200);
    expect(receipt!.controls[1].legLength).toBe(800);
  });

  it("returns position in class", async () => {
    const caller = makeCaller();
    const receipt = await caller.race.finishReceipt({ runnerId: runnerOk.id });

    expect(receipt).not.toBeNull();
    // Anna OK is the only OK runner with a finish time recorded
    // Björn MP was also set OK by recordFinish but that's 2 runners
    expect(receipt!.position).not.toBeNull();
    expect(receipt!.position!.rank).toBeGreaterThanOrEqual(1);
    expect(receipt!.position!.total).toBeGreaterThanOrEqual(1);
  });

  it("returns receipt for MP runner with missing controls flagged", async () => {
    const caller = makeCaller();
    const receipt = await caller.race.finishReceipt({ runnerId: runnerMp.id });

    expect(receipt).not.toBeNull();
    expect(receipt!.runner.name).toBe("Björn MP");
    // Readout-level evaluation detects MP
    expect(receipt!.timing.status).toBe(RunnerStatus.MissingPunch);
    expect(receipt!.missingControls).toEqual([33]);
    // No position for MP runners
    expect(receipt!.position).toBeNull();
  });

  it("returns receipt for DNF runner", async () => {
    const caller = makeCaller();
    const receipt = await caller.race.finishReceipt({ runnerId: runnerDnf.id });

    expect(receipt).not.toBeNull();
    expect(receipt!.timing.status).toBe(RunnerStatus.DNF);
    expect(receipt!.timing.finishTime).toBe(0);
    expect(receipt!.timing.runningTime).toBe(0);
  });

  it("returns receipt for DNS runner (no card data)", async () => {
    const caller = makeCaller();
    const receipt = await caller.race.finishReceipt({ runnerId: runnerDns.id });

    expect(receipt).not.toBeNull();
    expect(receipt!.hasCard).toBe(false);
    expect(receipt!.timing.finishTime).toBe(0);
  });
});

// ─── storeReadout → evaluate flow (simulates kiosk) ────────

describe("kiosk card store + evaluate flow", () => {
  it("storeReadout then readoutByRunner gives correct result", async () => {
    const caller = makeCaller();

    // Create a new runner with no card data
    const runner = await caller.runner.create({
      name: "Eva Flow",
      classId,
      cardNo: 500010,
    });
    await ctx.client.oRunner.update({
      where: { Id: runner.id },
      data: { StartTime: REL_START }, // DB stores ZeroTime-relative
    });

    // Simulate kiosk: SI card is read, storeReadout is called
    // (storeReadout takes absolute seconds, API converts to relative for DB)
    await caller.cardReadout.storeReadout({
      cardNo: 500010,
      startTime: START_TIME / 10, // convert deci→sec (absolute)
      finishTime: (START_TIME + 5400) / 10, // +9:00
      punches: CONTROLS.map((code, i) => ({
        controlCode: code,
        time: (START_TIME + (i + 1) * 1080) / 10, // each +1:48
      })),
    });

    // Now readout should work (API returns absolute times)
    const readout = await caller.cardReadout.readoutByRunner({ runnerId: runner.id });
    expect(readout).not.toBeNull();
    expect(readout!.hasCard).toBe(true);
    expect(readout!.timing.status).toBe(RunnerStatus.OK);
    expect(readout!.timing.finishTime).toBe(START_TIME + 5400);
    expect(readout!.controls).toHaveLength(5);
    expect(readout!.missingControls).toHaveLength(0);

    // Simulate kiosk: record finish using card's finish punch time
    const finish = await caller.race.recordFinish({
      runnerId: runner.id,
      finishTime: START_TIME + 5400,
    });
    expect(finish.status).toBe(RunnerStatus.OK);
    expect(finish.runningTime).toBe(5400);
  });
});

// ─── Stale punch detection ──────────────────────────────────

describe("storeReadout: stale punch detection", () => {
  it("stores punches when all controls match competition", async () => {
    const caller = makeCaller();
    const result = await caller.cardReadout.storeReadout({
      cardNo: runnerOk.cardNo,
      punches: CONTROLS.map((code, i) => ({
        controlCode: code,
        time: 36000 + i * 120,
      })),
      startTime: 36000,
      finishTime: 36720,
    });

    expect(result.punchesRelevant).toBe(true);

    // oCard should have been updated with the new punches
    const card = await ctx.client.oCard.findFirst({
      where: { CardNo: runnerOk.cardNo, Removed: false },
    });
    expect(card).not.toBeNull();
    expect(card!.Punches).toContain("31-");
  });

  it("rejects punches when card has foreign controls (stale data)", async () => {
    const caller = makeCaller();
    // Use controls 91, 92, 93 which are NOT in our competition
    const result = await caller.cardReadout.storeReadout({
      cardNo: runnerDns.cardNo,
      punches: [
        { controlCode: 91, time: 36000 },
        { controlCode: 92, time: 36120 },
        { controlCode: 93, time: 36240 },
      ],
      startTime: 35900,
      finishTime: 36300,
    });

    expect(result.punchesRelevant).toBe(false);

    // oCard should NOT have been updated with stale punches
    const card = await ctx.client.oCard.findFirst({
      where: { CardNo: runnerDns.cardNo, Removed: false },
    });
    // Either no card exists or punches are empty
    if (card) {
      expect(card.Punches).not.toContain("91-");
    }
  });

  it("rejects punches when majority are foreign controls", async () => {
    const caller = makeCaller();
    // Card has 1 valid + 2 foreign → 67% foreign > 50% threshold
    const result = await caller.cardReadout.storeReadout({
      cardNo: runnerDns.cardNo,
      punches: [
        { controlCode: 31, time: 36000 },
        { controlCode: 91, time: 36120 },
        { controlCode: 92, time: 36240 },
      ],
    });

    expect(result.punchesRelevant).toBe(false);
  });

  it("accepts punches when minority are foreign (misconfigured control)", async () => {
    const caller = makeCaller();
    // Card has 3 valid + 1 foreign → 25% foreign < 50% threshold
    const result = await caller.cardReadout.storeReadout({
      cardNo: 600099,
      punches: [
        { controlCode: 31, time: 36000 },
        { controlCode: 32, time: 36120 },
        { controlCode: 33, time: 36240 },
        { controlCode: 91, time: 36360 }, // 1 foreign
      ],
      punchesFresh: true,
    });

    expect(result.punchesRelevant).toBe(true);
  });

  it("stores to history even when punches are stale", async () => {
    const caller = makeCaller();

    // Store stale punches
    await caller.cardReadout.storeReadout({
      cardNo: 599999,
      punches: [{ controlCode: 91, time: 36000 }],
      cardType: "SI8",
    });

    // Check readout history — should be stored
    const history = await caller.cardReadout.readoutHistory({ cardNo: 599999 });
    expect(history.length).toBeGreaterThanOrEqual(1);
    expect(history[0].punches).toContain("91-");
  });

  it("deduplicates identical readouts within 1 minute", async () => {
    const caller = makeCaller();
    const uniqueCard = 599998;

    // Store same readout twice quickly
    await caller.cardReadout.storeReadout({
      cardNo: uniqueCard,
      punches: CONTROLS.map((code, i) => ({
        controlCode: code,
        time: 36000 + i * 120,
      })),
    });
    await caller.cardReadout.storeReadout({
      cardNo: uniqueCard,
      punches: CONTROLS.map((code, i) => ({
        controlCode: code,
        time: 36000 + i * 120,
      })),
    });

    const history = await caller.cardReadout.readoutHistory({ cardNo: uniqueCard });
    // Should only have 1 entry (deduped)
    expect(history.length).toBe(1);
  });
});

// ─── readout query: punchesMatchCourse ──────────────────────

describe("cardReadout.readout: punchesMatchCourse", () => {
  it("returns punchesMatchCourse=true when card punches match course", async () => {
    const caller = makeCaller();
    const result = await caller.cardReadout.readout({ cardNo: runnerOk.cardNo });

    expect(result.found).toBe(true);
    if (result.found) {
      expect(result.punchesMatchCourse).toBe(true);
    }
  });

  it("returns punchesMatchCourse=false when no card data", async () => {
    const caller = makeCaller();
    const result = await caller.cardReadout.readout({ cardNo: runnerDns.cardNo });

    expect(result.found).toBe(true);
    if (result.found) {
      expect(result.punchesMatchCourse).toBe(false);
    }
  });
});

// ─── cardReadout.applyResult ─────────────────────────────────

describe("cardReadout.applyResult", () => {
  // Reset runner statuses before these tests so they don't depend on prior test state
  let freshOk: { id: number; cardNo: number };
  let freshMp: { id: number; cardNo: number };
  let freshDnf: { id: number; cardNo: number };

  beforeAll(async () => {
    const caller = makeCaller();

    // Create fresh runners for applyResult tests (DB stores ZeroTime-relative)
    const rOk = await caller.runner.create({ name: "ApplyOk Runner", classId, cardNo: 600001 });
    await ctx.client.oRunner.update({ where: { Id: rOk.id }, data: { StartTime: REL_START } });
    freshOk = { id: rOk.id, cardNo: 600001 };

    const rMp = await caller.runner.create({ name: "ApplyMp Runner", classId, cardNo: 600002 });
    await ctx.client.oRunner.update({ where: { Id: rMp.id }, data: { StartTime: REL_START } });
    freshMp = { id: rMp.id, cardNo: 600002 };

    const rDnf = await caller.runner.create({ name: "ApplyDnf Runner", classId, cardNo: 600003 });
    await ctx.client.oRunner.update({ where: { Id: rDnf.id }, data: { StartTime: REL_START } });
    freshDnf = { id: rDnf.id, cardNo: 600003 };
  });

  it("applies OK status and finishTime to runner", async () => {
    const caller = makeCaller();
    const finishTime = START_TIME + 7200;

    const result = await caller.cardReadout.applyResult({
      runnerId: freshOk.id,
      status: RunnerStatus.OK,
      finishTime,
      startTime: START_TIME,
    });

    expect(result.applied).toBe(true);
    expect(result.status).toBe(RunnerStatus.OK);
    expect(result.finishTime).toBe(finishTime);
    expect(result.startTime).toBe(START_TIME);

    // Verify persisted in DB
    const runner = await caller.runner.getById({ id: freshOk.id });
    expect(runner.status).toBe(RunnerStatus.OK);
    expect(runner.finishTime).toBe(finishTime);
    expect(runner.startTime).toBe(START_TIME);
  });

  it("applies MP status to runner", async () => {
    const caller = makeCaller();
    const finishTime = START_TIME + 7200;

    await caller.cardReadout.applyResult({
      runnerId: freshMp.id,
      status: RunnerStatus.MissingPunch,
      finishTime,
      startTime: START_TIME,
    });

    const runner = await caller.runner.getById({ id: freshMp.id });
    expect(runner.status).toBe(RunnerStatus.MissingPunch);
    expect(runner.finishTime).toBe(finishTime);
  });

  it("applies DNF status with finishTime=0", async () => {
    const caller = makeCaller();

    await caller.cardReadout.applyResult({
      runnerId: freshDnf.id,
      status: RunnerStatus.DNF,
      finishTime: 0,
      startTime: START_TIME,
    });

    const runner = await caller.runner.getById({ id: freshDnf.id });
    expect(runner.status).toBe(RunnerStatus.DNF);
    expect(runner.finishTime).toBe(0);
  });

  it("is idempotent — calling twice with same values does not error", async () => {
    const caller = makeCaller();
    const finishTime = START_TIME + 7200;

    await caller.cardReadout.applyResult({
      runnerId: freshOk.id,
      status: RunnerStatus.OK,
      finishTime,
      startTime: START_TIME,
    });

    // Second call should succeed without error
    const result = await caller.cardReadout.applyResult({
      runnerId: freshOk.id,
      status: RunnerStatus.OK,
      finishTime,
      startTime: START_TIME,
    });

    expect(result.applied).toBe(true);
    const runner = await caller.runner.getById({ id: freshOk.id });
    expect(runner.status).toBe(RunnerStatus.OK);
    expect(runner.finishTime).toBe(finishTime);
  });
});

// ─── Full readout station flow ───────────────────────────────

describe("full readout station flow", () => {
  it("storeReadout → readout → applyResult persists correct status", async () => {
    const caller = makeCaller();

    // Create a fresh runner with no card data
    const runner = await caller.runner.create({
      name: "FlowTest Runner",
      classId,
      cardNo: 600010,
    });
    await ctx.client.oRunner.update({
      where: { Id: runner.id },
      data: { StartTime: REL_START }, // DB stores ZeroTime-relative
    });

    // Step 1: Store card readout (simulates DeviceManager storeReadout call)
    await caller.cardReadout.storeReadout({
      cardNo: 600010,
      startTime: START_TIME / 10,
      finishTime: (START_TIME + 6000) / 10,
      punches: CONTROLS.map((code, i) => ({
        controlCode: code,
        time: (START_TIME + (i + 1) * 1080) / 10,
      })),
    });

    // Step 2: Query readout to get computed status (simulates DeviceManager readout query)
    const readout = await caller.cardReadout.readout({ cardNo: 600010 });
    expect(readout.found).toBe(true);
    if (!readout.found) return;

    expect(readout.timing.status).toBe(RunnerStatus.OK);
    expect(readout.timing.finishTime).toBe(START_TIME + 6000);

    // Step 3: Apply result (simulates DeviceManager applyResult call)
    await caller.cardReadout.applyResult({
      runnerId: readout.runner.id,
      status: readout.timing.status,
      finishTime: readout.timing.finishTime,
      startTime: readout.timing.startTime,
    });

    // Verify runner status persisted (API returns absolute times)
    const after = await caller.runner.getById({ id: runner.id });
    expect(after.status).toBe(RunnerStatus.OK);
    expect(after.finishTime).toBe(START_TIME + 6000);
    expect(after.startTime).toBe(START_TIME);
  });
});

// ─── Punch-start readout → placement flow ────────────────────

describe("punch-start readout → placement flow", () => {
  it("punch-start runner gets correct placement after applyResult", async () => {
    const caller = makeCaller();

    // Create runner with NO pre-assigned start time (punch-start)
    const runner = await caller.runner.create({
      name: "PunchStart Runner",
      classId,
      cardNo: 700001,
    });
    // StartTime is 0 (no draw start)

    // Store card readout with start punch
    const cardStartSec = START_TIME / 10; // seconds
    const finishSec = (START_TIME + 6000) / 10;
    await caller.cardReadout.storeReadout({
      cardNo: 700001,
      startTime: cardStartSec,
      finishTime: finishSec,
      punches: CONTROLS.map((code, i) => ({
        controlCode: code,
        time: cardStartSec + (i + 1) * 108,
      })),
    });

    // Query readout: startTime should come from card start punch
    const readout = await caller.cardReadout.readout({ cardNo: 700001 });
    expect(readout.found).toBe(true);
    if (!readout.found) return;

    expect(readout.timing.status).toBe(RunnerStatus.OK);
    expect(readout.timing.startTime).toBe(START_TIME); // from card punch (converted to deciseconds)

    // Apply result with startTime
    await caller.cardReadout.applyResult({
      runnerId: readout.runner.id,
      status: readout.timing.status,
      finishTime: readout.timing.finishTime,
      startTime: readout.timing.startTime,
    });

    // Verify StartTime is now persisted in DB
    const after = await caller.runner.getById({ id: runner.id });
    expect(after.startTime).toBe(START_TIME);
    expect(after.status).toBe(RunnerStatus.OK);

    // Verify placement via result list
    const results = await caller.lists.resultList({ classId });
    const entry = results.find((r) => r.id === runner.id);
    expect(entry).toBeDefined();
    expect(entry!.place).toBeGreaterThan(0);
  });

  it("two punch-start runners are ranked correctly", async () => {
    const caller = makeCaller();

    // Create a separate class for this test to avoid interference
    const cls2 = await ctx.client.oClass.create({
      data: {
        Name: "PunchStartClass",
        Course: courseId,
        FirstStart: 0,
        StartInterval: 0,
        SortIndex: 2,
        Removed: false,
        Counter: 0,
        FreeStart: 0,
      },
    });

    // Runner A: faster (running time = 600ds = 1min)
    const rA = await caller.runner.create({ name: "PS Fast", classId: cls2.Id, cardNo: 700010 });
    const rB = await caller.runner.create({ name: "PS Slow", classId: cls2.Id, cardNo: 700011 });

    // Store and apply A (faster)
    const aStartSec = START_TIME / 10;
    const aFinishSec = (START_TIME + 6000) / 10;
    await caller.cardReadout.storeReadout({
      cardNo: 700010,
      startTime: aStartSec,
      finishTime: aFinishSec,
      punches: CONTROLS.map((code, i) => ({
        controlCode: code,
        time: aStartSec + (i + 1) * 108,
      })),
    });
    const readoutA = await caller.cardReadout.readout({ cardNo: 700010 });
    expect(readoutA.found).toBe(true);
    if (!readoutA.found) return;
    await caller.cardReadout.applyResult({
      runnerId: rA.id,
      status: readoutA.timing.status,
      finishTime: readoutA.timing.finishTime,
      startTime: readoutA.timing.startTime,
    });

    // Store and apply B (slower: +1200ds = +2min)
    const bStartSec = START_TIME / 10;
    const bFinishSec = (START_TIME + 7200) / 10;
    await caller.cardReadout.storeReadout({
      cardNo: 700011,
      startTime: bStartSec,
      finishTime: bFinishSec,
      punches: CONTROLS.map((code, i) => ({
        controlCode: code,
        time: bStartSec + (i + 1) * 130,
      })),
    });
    const readoutB = await caller.cardReadout.readout({ cardNo: 700011 });
    expect(readoutB.found).toBe(true);
    if (!readoutB.found) return;
    await caller.cardReadout.applyResult({
      runnerId: rB.id,
      status: readoutB.timing.status,
      finishTime: readoutB.timing.finishTime,
      startTime: readoutB.timing.startTime,
    });

    // Verify result list placements
    const results = await caller.lists.resultList({ classId: cls2.Id });
    const entryA = results.find((r) => r.id === rA.id);
    const entryB = results.find((r) => r.id === rB.id);

    expect(entryA).toBeDefined();
    expect(entryB).toBeDefined();
    expect(entryA!.place).toBe(1); // faster
    expect(entryB!.place).toBe(2); // slower
  });

  it("placements recalculate for all class runners after each apply", async () => {
    const caller = makeCaller();

    // Create isolated class
    const cls = await ctx.client.oClass.create({
      data: {
        Name: "IncrementalClass",
        Course: courseId,
        FirstStart: 0,
        StartInterval: 0,
        SortIndex: 3,
        Removed: false,
        Counter: 0,
        FreeStart: 0,
      },
    });

    // Helper to store + readout + apply a runner
    async function readoutAndApply(cardNo: number, runnerId: number, finishDs: number) {
      const startSec = START_TIME / 10;
      const finishSec = (START_TIME + finishDs) / 10;
      await caller.cardReadout.storeReadout({
        cardNo,
        startTime: startSec,
        finishTime: finishSec,
        punches: CONTROLS.map((code, i) => ({
          controlCode: code,
          time: startSec + (i + 1) * 100,
        })),
      });
      const readout = await caller.cardReadout.readout({ cardNo });
      if (!readout.found) throw new Error("readout not found");
      await caller.cardReadout.applyResult({
        runnerId,
        status: readout.timing.status,
        finishTime: readout.timing.finishTime,
        startTime: readout.timing.startTime,
      });
    }

    // Create 3 runners
    const rSlow = await caller.runner.create({ name: "Incr Slow", classId: cls.Id, cardNo: 800001 });
    const rMid = await caller.runner.create({ name: "Incr Mid", classId: cls.Id, cardNo: 800002 });
    const rFast = await caller.runner.create({ name: "Incr Fast", classId: cls.Id, cardNo: 800003 });

    // Apply slowest first
    await readoutAndApply(800001, rSlow.id, 9000); // 15min
    let results = await caller.lists.resultList({ classId: cls.Id });
    expect(results.find((r) => r.id === rSlow.id)!.place).toBe(1); // only runner → place 1

    // Apply middle runner — slow runner's place should update
    await readoutAndApply(800002, rMid.id, 7200); // 12min
    results = await caller.lists.resultList({ classId: cls.Id });
    expect(results.find((r) => r.id === rMid.id)!.place).toBe(1);  // faster → 1st
    expect(results.find((r) => r.id === rSlow.id)!.place).toBe(2); // now 2nd

    // Apply fastest runner — both previous runners' places should update
    await readoutAndApply(800003, rFast.id, 6000); // 10min
    results = await caller.lists.resultList({ classId: cls.Id });
    expect(results.find((r) => r.id === rFast.id)!.place).toBe(1); // fastest → 1st
    expect(results.find((r) => r.id === rMid.id)!.place).toBe(2);  // now 2nd
    expect(results.find((r) => r.id === rSlow.id)!.place).toBe(3); // now 3rd
  });

  it("tied runners get same place after incremental apply", async () => {
    const caller = makeCaller();

    const cls = await ctx.client.oClass.create({
      data: {
        Name: "TieClass",
        Course: courseId,
        FirstStart: 0,
        StartInterval: 0,
        SortIndex: 4,
        Removed: false,
        Counter: 0,
        FreeStart: 0,
      },
    });

    const startSec = START_TIME / 10;
    const tiedFinish = 6000; // same running time for both

    const rA = await caller.runner.create({ name: "Tie A", classId: cls.Id, cardNo: 810001 });
    const rB = await caller.runner.create({ name: "Tie B", classId: cls.Id, cardNo: 810002 });
    const rC = await caller.runner.create({ name: "Tie Third", classId: cls.Id, cardNo: 810003 });

    // Apply A
    await caller.cardReadout.storeReadout({
      cardNo: 810001,
      startTime: startSec,
      finishTime: (START_TIME + tiedFinish) / 10,
      punches: CONTROLS.map((code, i) => ({ controlCode: code, time: startSec + (i + 1) * 100 })),
    });
    let readout = await caller.cardReadout.readout({ cardNo: 810001 });
    if (!readout.found) throw new Error("not found");
    await caller.cardReadout.applyResult({
      runnerId: rA.id,
      status: readout.timing.status,
      finishTime: readout.timing.finishTime,
      startTime: readout.timing.startTime,
    });

    // Apply B (same time)
    await caller.cardReadout.storeReadout({
      cardNo: 810002,
      startTime: startSec,
      finishTime: (START_TIME + tiedFinish) / 10,
      punches: CONTROLS.map((code, i) => ({ controlCode: code, time: startSec + (i + 1) * 100 })),
    });
    readout = await caller.cardReadout.readout({ cardNo: 810002 });
    if (!readout.found) throw new Error("not found");
    await caller.cardReadout.applyResult({
      runnerId: rB.id,
      status: readout.timing.status,
      finishTime: readout.timing.finishTime,
      startTime: readout.timing.startTime,
    });

    // Apply C (slower)
    await caller.cardReadout.storeReadout({
      cardNo: 810003,
      startTime: startSec,
      finishTime: (START_TIME + 8000) / 10,
      punches: CONTROLS.map((code, i) => ({ controlCode: code, time: startSec + (i + 1) * 100 })),
    });
    readout = await caller.cardReadout.readout({ cardNo: 810003 });
    if (!readout.found) throw new Error("not found");
    await caller.cardReadout.applyResult({
      runnerId: rC.id,
      status: readout.timing.status,
      finishTime: readout.timing.finishTime,
      startTime: readout.timing.startTime,
    });

    // Both A and B should share place 1, C should be place 3 (1,1,3 style)
    const results = await caller.lists.resultList({ classId: cls.Id });
    expect(results.find((r) => r.id === rA.id)!.place).toBe(1);
    expect(results.find((r) => r.id === rB.id)!.place).toBe(1);
    expect(results.find((r) => r.id === rC.id)!.place).toBe(3); // 3rd, not 2nd
  });
});
