/**
 * Integration tests for oCard write guards, runner linking, and readout flow.
 *
 * Validates that:
 * - Registration scans (stale/empty data) do NOT write to oCard
 * - Real readouts DO write to oCard with correct ReadId
 * - runner.create links existing oCard
 * - storeReadout prefers the runner-linked oCard
 * - Status→OK auto-populates times from oCard
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestDb, type TestDbContext } from "../helpers/test-db.js";
import { makeCaller } from "../helpers/caller.js";

let ctx: TestDbContext;
let caller: ReturnType<typeof makeCaller>;

let classId: number;
let courseId: number;

const CONTROLS = [41, 42, 43, 44, 45];
const FOREIGN_CONTROLS = [91, 92, 93]; // not in this competition
const START_TIME_SECS = 36000; // 10:00:00 in seconds
const START_TIME_DS = 360000; // 10:00:00 in deciseconds

beforeAll(async () => {
  ctx = await createTestDb("cardlink");
  caller = makeCaller();

  // Create class
  const cls = await ctx.client.oClass.create({
    data: {
      Name: "Test",
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

  // Create course
  const course = await ctx.client.oCourse.create({
    data: {
      Name: "Test Course",
      Controls: CONTROLS.join(";") + ";",
      Length: 3000,
      Legs: "600;600;600;600;600;",
    },
  });
  courseId = course.Id;

  // Link class to course
  await ctx.client.oClass.update({
    where: { Id: classId },
    data: { Course: courseId },
  });

  // Create oControl entries for the competition controls
  for (const code of CONTROLS) {
    await ctx.client.oControl.create({
      data: { Name: "", Numbers: `${code}`, Status: 0 },
    });
  }
});

afterAll(async () => {
  await ctx.cleanup();
});

// ── Test 1: Registration scan with foreign controls skips oCard ──

describe("storeReadout oCard guards", () => {
  it("skips oCard when punches contain foreign controls", async () => {
    const cardNo = 600001;
    const result = await caller.cardReadout.storeReadout({
      cardNo,
      punches: FOREIGN_CONTROLS.map((code, i) => ({
        controlCode: code,
        time: START_TIME_SECS + (i + 1) * 120,
      })),
      startTime: START_TIME_SECS,
      finishTime: START_TIME_SECS + 600,
      punchesFresh: true,
    });

    expect(result.punchesRelevant).toBe(false);
    expect(result.cardId).toBeNull();

    // Verify no oCard was created
    const cards = await ctx.client.oCard.findMany({
      where: { CardNo: cardNo },
    });
    expect(cards).toHaveLength(0);
  });

  it("skips oCard when card has no control punches (empty card)", async () => {
    const cardNo = 600002;
    const result = await caller.cardReadout.storeReadout({
      cardNo,
      punches: [], // only check/start — no control punches
      checkTime: START_TIME_SECS - 60,
      startTime: START_TIME_SECS,
      punchesFresh: true,
    });

    expect(result.punchesRelevant).toBe(true); // no foreign controls
    expect(result.cardId).toBeNull(); // but no control punches → skip

    const cards = await ctx.client.oCard.findMany({
      where: { CardNo: cardNo },
    });
    expect(cards).toHaveLength(0);
  });

  it("skips oCard when punchesFresh is false (DOW mismatch)", async () => {
    const cardNo = 600003;
    const result = await caller.cardReadout.storeReadout({
      cardNo,
      punches: CONTROLS.map((code, i) => ({
        controlCode: code,
        time: START_TIME_SECS + (i + 1) * 120,
      })),
      startTime: START_TIME_SECS,
      finishTime: START_TIME_SECS + 720,
      punchesFresh: false, // client DOW check says stale
    });

    expect(result.punchesRelevant).toBe(true);
    expect(result.cardId).toBeNull();

    const cards = await ctx.client.oCard.findMany({
      where: { CardNo: cardNo },
    });
    expect(cards).toHaveLength(0);
  });

  it("writes oCard when punches are fresh and relevant", async () => {
    const cardNo = 600004;
    const result = await caller.cardReadout.storeReadout({
      cardNo,
      punches: CONTROLS.map((code, i) => ({
        controlCode: code,
        time: START_TIME_SECS + (i + 1) * 120,
      })),
      startTime: START_TIME_SECS,
      finishTime: START_TIME_SECS + 720,
      punchesFresh: true,
    });

    expect(result.punchesRelevant).toBe(true);
    expect(result.cardId).not.toBeNull();
    expect(result.created).toBe(true);

    const card = await ctx.client.oCard.findFirst({
      where: { CardNo: cardNo },
    });
    expect(card).not.toBeNull();
    expect(card!.Punches).toContain("41-");
    expect(card!.ReadId).not.toBe(0); // ReadId hash was set
  });

  it("writes oCard when minority of punches are foreign (ratio check)", async () => {
    const cardNo = 600005;
    // 5 competition controls + 1 foreign = 6 total, foreign is 17% < 50%
    const punches = [
      ...CONTROLS.map((code, i) => ({
        controlCode: code,
        time: START_TIME_SECS + (i + 1) * 120,
      })),
      { controlCode: 99, time: START_TIME_SECS + 700 }, // 1 foreign control
    ];
    const result = await caller.cardReadout.storeReadout({
      cardNo,
      punches,
      startTime: START_TIME_SECS,
      finishTime: START_TIME_SECS + 720,
      punchesFresh: true,
    });

    expect(result.punchesRelevant).toBe(true); // minority foreign → still relevant
    expect(result.cardId).not.toBeNull();
  });
});

// ── Test 2: Full registration→readout flow ──

describe("registration→readout flow", () => {
  it("stale registration scan does not pollute oCard, real readout works", async () => {
    const cardNo = 600010;

    // Create runner
    const { id: runnerId } = await caller.runner.create({ name: "Test Runner", classId, cardNo });
    await ctx.client.oRunner.update({
      where: { Id: runnerId },
      data: { StartTime: START_TIME_DS },
    });

    // Step 1: Registration scan with stale same-course punches (punchesFresh=false)
    const regResult = await caller.cardReadout.storeReadout({
      cardNo,
      punches: CONTROLS.map((code, i) => ({
        controlCode: code,
        time: START_TIME_SECS + (i + 1) * 60, // old times
      })),
      startTime: START_TIME_SECS,
      finishTime: START_TIME_SECS + 600,
      punchesFresh: false,
    });
    expect(regResult.cardId).toBeNull(); // oCard NOT written

    // Verify no oCard exists yet
    const cardsAfterReg = await ctx.client.oCard.findMany({
      where: { CardNo: cardNo },
    });
    expect(cardsAfterReg).toHaveLength(0);

    // Step 2: Real readout after the race (punchesFresh=true, different times)
    const realResult = await caller.cardReadout.storeReadout({
      cardNo,
      punches: CONTROLS.map((code, i) => ({
        controlCode: code,
        time: START_TIME_SECS + (i + 1) * 120, // real times
      })),
      startTime: START_TIME_SECS,
      finishTime: START_TIME_SECS + 720,
      punchesFresh: true,
    });
    expect(realResult.cardId).not.toBeNull();

    // Verify oCard has real data (not stale)
    const card = await ctx.client.oCard.findFirst({
      where: { CardNo: cardNo, Removed: false },
    });
    expect(card).not.toBeNull();
    // Real finish time is 36720s → deciseconds 367200 → "2-36720.0"
    expect(card!.Punches).toContain("2-36720.0");

    // Verify performReadout returns correct times and matchScore
    const readout = await caller.cardReadout.readout({ cardNo });
    expect(readout.found).toBe(true);
    if (readout.found) {
      expect(readout.timing.finishTime).toBe(367200); // 36720s * 10
      expect(readout.timing.runningTime).toBeGreaterThan(0);
      // All 5 controls matched, 0 foreign → matchScore should be 1.0
      expect(readout.matchScore).toBe(1.0);
      expect(readout.punchesMatchCourse).toBe(true);
    }
  });
});

// ── Test 3: runner.create links existing oCard ──

describe("runner.create links oCard", () => {
  it("links runner to existing oCard on creation", async () => {
    const cardNo = 600020;

    // First create an oCard (from a previous readout or MeOS)
    const card = await ctx.client.oCard.create({
      data: { CardNo: cardNo, Punches: "41-36120.0;2-36720.0;", ReadId: 0 },
    });

    // Now create the runner with the same cardNo
    const { id: runnerId } = await caller.runner.create({
      name: "Linked Runner",
      classId,
      cardNo,
    });

    // Verify runner.Card FK points to the oCard
    const runner = await ctx.client.oRunner.findUnique({
      where: { Id: runnerId },
    });
    expect(runner!.Card).toBe(card.Id);
  });
});

// ── Test 4: storeReadout prefers runner-linked oCard ──

describe("storeReadout prefers runner-linked oCard", () => {
  it("updates the runner-linked oCard, not a random one", async () => {
    const cardNo = 600030;

    // Create two oCards with the same CardNo
    const cardA = await ctx.client.oCard.create({
      data: { CardNo: cardNo, Punches: "old;", ReadId: 0 },
    });
    const cardB = await ctx.client.oCard.create({
      data: { CardNo: cardNo, Punches: "old;", ReadId: 0 },
    });

    // Create runner linked to cardB
    const runner = await ctx.client.oRunner.create({
      data: {
        Name: "Prefer Linked",
        CardNo: cardNo,
        Card: cardB.Id,
        Class: classId,
        InputResult: "",
        Annotation: "",
      },
    });

    // Call storeReadout with fresh data
    await caller.cardReadout.storeReadout({
      cardNo,
      punches: CONTROLS.map((code, i) => ({
        controlCode: code,
        time: START_TIME_SECS + (i + 1) * 120,
      })),
      startTime: START_TIME_SECS,
      finishTime: START_TIME_SECS + 720,
      punchesFresh: true,
    });

    // cardB (linked) should be updated, cardA should still have old data
    const updatedA = await ctx.client.oCard.findUnique({ where: { Id: cardA.Id } });
    const updatedB = await ctx.client.oCard.findUnique({ where: { Id: cardB.Id } });
    expect(updatedA!.Punches).toBe("old;");
    expect(updatedB!.Punches).toContain("41-");
  });
});

// ── Test 5: ReadId deduplication ──

describe("ReadId deduplication", () => {
  it("skips oCard update when ReadId matches", async () => {
    const cardNo = 600040;
    const punches = CONTROLS.map((code, i) => ({
      controlCode: code,
      time: START_TIME_SECS + (i + 1) * 120,
    }));

    // First write
    const first = await caller.cardReadout.storeReadout({
      cardNo,
      punches,
      startTime: START_TIME_SECS,
      finishTime: START_TIME_SECS + 720,
      punchesFresh: true,
    });
    expect(first.created).toBe(true);

    const cardAfterFirst = await ctx.client.oCard.findFirst({
      where: { CardNo: cardNo },
    });

    // Second write with identical data
    const second = await caller.cardReadout.storeReadout({
      cardNo,
      punches,
      startTime: START_TIME_SECS,
      finishTime: START_TIME_SECS + 720,
      punchesFresh: true,
    });
    expect(second.created).toBe(false);

    // Verify the Modified timestamp didn't change (ReadId dedup skipped the update)
    const cardAfterSecond = await ctx.client.oCard.findFirst({
      where: { CardNo: cardNo },
    });
    // ReadId should match
    expect(cardAfterFirst!.ReadId).toBe(cardAfterSecond!.ReadId);
  });
});

// ── Test 6: Status→OK auto-populates times ──

describe("status→OK auto-populates times", () => {
  it("derives StartTime and FinishTime from oCard when status changed to OK", async () => {
    const cardNo = 600050;

    // Create runner with an assigned start time
    const { id: runnerId } = await caller.runner.create({
      name: "Auto Time Runner",
      classId,
      cardNo,
    });
    await ctx.client.oRunner.update({
      where: { Id: runnerId },
      data: { StartTime: START_TIME_DS },
    });

    // Create oCard with punch data
    const punchStr = [
      `1-${START_TIME_DS / 10}.0`,             // start
      ...CONTROLS.map((c, i) => `${c}-${(START_TIME_DS + (i + 1) * 1200) / 10}.0`),
      `2-${(START_TIME_DS + 7200) / 10}.0`,     // finish
    ].join(";") + ";";

    const card = await ctx.client.oCard.create({
      data: { CardNo: cardNo, Punches: punchStr, ReadId: 0 },
    });
    await ctx.client.oRunner.update({
      where: { Id: runnerId },
      data: { Card: card.Id },
    });

    // Status is 0, StartTime assigned, FinishTime is 0
    const before = await ctx.client.oRunner.findUnique({ where: { Id: runnerId } });
    expect(before!.FinishTime).toBe(0);

    // Change status to OK
    await caller.runner.update({ id: runnerId, data: { status: 1 } });

    // Verify FinishTime was auto-populated
    const after = await ctx.client.oRunner.findUnique({ where: { Id: runnerId } });
    expect(after!.Status).toBe(1);
    expect(after!.FinishTime).toBeGreaterThan(0);
    expect(after!.FinishTime).toBe(START_TIME_DS + 7200); // 10:12:00 in ds
  });
});

// ── Test 7: MeOS negative time normalization ──

describe("MeOS negative time normalization", () => {
  it("normalizes negative MeOS punch times to absolute times via ZeroTime", async () => {
    const cardNo = 600060;

    const { id: runnerId } = await caller.runner.create({
      name: "MeOS Time Runner",
      classId,
      cardNo,
    });

    // MeOS stores punch times as (rawSITime - ZeroTime). Edge cases in MeOS's
    // 12h→24h conversion can produce negative values. ZeroTime is 324000 (09:00).
    // Write an oCard with MeOS-style negative times (double-minus encoding):
    //   -6000 ds → absolute 324000 + (-6000) = 318000 (08:50:00)
    //   -4800 ds → absolute 319200 (08:52:00)
    //   etc.
    // Positive MeOS-relative times are also present (0 and 1200 ds).
    // When ANY time is negative, ALL card punches should be normalized.
    const punchStr = [
      "1--600.0",     // start: -6000 ds → 318000 (08:50:00)
      "41--480.0",    // ctrl 41: -4800 ds → 319200 (08:52:00)
      "42--360.0",    // ctrl 42: -3600 ds → 320400 (08:54:00)
      "43--240.0",    // ctrl 43: -2400 ds → 321600 (08:56:00)
      "44--120.0",    // ctrl 44: -1200 ds → 322800 (08:58:00)
      "45-0.0",       // ctrl 45: 0 ds → 324000 (09:00:00)
      "2-120.0",      // finish: 1200 ds → 325200 (09:02:00)
    ].join(";") + ";";

    const card = await ctx.client.oCard.create({
      data: { CardNo: cardNo, Punches: punchStr, ReadId: 0 },
    });
    await ctx.client.oRunner.update({
      where: { Id: runnerId },
      data: { Card: card.Id, StartTime: 0 },
    });

    const readout = await caller.cardReadout.readout({ cardNo });
    expect(readout.found).toBe(true);
    if (readout.found) {
      // All times should be positive after normalization
      expect(readout.timing.startTime).toBeGreaterThan(0);
      expect(readout.timing.finishTime).toBeGreaterThan(0);
      expect(readout.timing.runningTime).toBeGreaterThan(0);

      // Verify exact normalized values (ZeroTime 324000 added to all)
      expect(readout.timing.cardStartTime).toBe(318000); // -6000 + 324000
      expect(readout.timing.finishTime).toBe(325200);     // 1200 + 324000
      expect(readout.timing.runningTime).toBe(7200);       // 325200 - 318000 = 12 minutes
    }
  });
});
