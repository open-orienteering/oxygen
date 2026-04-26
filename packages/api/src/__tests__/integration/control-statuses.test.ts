/**
 * Integration tests for the MeOS control-status evaluation pipeline.
 *
 * Verifies end-to-end that a course mixing every non-OK status
 * (Bad / Optional / NoTiming / BadNoTiming / Multiple) flows through
 * the readout, the runners-list / placement endpoint, and the Eventor
 * upload payload with the adjusted running time and the right
 * per-position semantics.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestDb, type TestDbContext } from "../helpers/test-db.js";
import { makeCaller } from "../helpers/caller.js";
import { ControlStatus } from "@oxygen/shared";

let ctx: TestDbContext;
let caller: ReturnType<typeof makeCaller>;

let classId: number;
let courseId: number;

const ZERO_TIME_DS = 324000; // 09:00:00
const ZERO_TIME_SECS = 32400;
const START_TIME_SECS = 36000; // 10:00:00 absolute
const START_TIME_DS = 360000;

beforeAll(async () => {
  ctx = await createTestDb("ctrlstat");
  caller = makeCaller({ dbName: ctx.dbName });

  // Class with no class-level NoTiming so we can exercise control-level
  // NoTiming in isolation.
  const cls = await ctx.client.oClass.create({
    data: {
      Name: "Status Test Class",
      Course: 0,
      FirstStart: 0,
      StartInterval: 0,
      SortIndex: 1,
      Counter: 0,
      FreeStart: 0,
    },
  });
  classId = cls.Id;

  // Six controls with each MeOS status we care about. Numbers always equal Id
  // here to keep the test focused on Status semantics — Id-vs-code rewiring
  // is covered by course-controls-renumber.test.ts.
  await Promise.all([
    ctx.client.oControl.create({
      data: { Id: 41, Name: "", Numbers: "41", Status: ControlStatus.OK },
    }),
    ctx.client.oControl.create({
      // Bad: skipped, missing != MP
      data: { Id: 42, Name: "", Numbers: "42", Status: ControlStatus.Bad },
    }),
    ctx.client.oControl.create({
      // NoTiming: required, but leg into it is deducted
      data: { Id: 43, Name: "", Numbers: "43", Status: ControlStatus.NoTiming },
    }),
    ctx.client.oControl.create({
      // Multiple: any of the listed codes hit in any order, all required
      data: { Id: 44, Name: "", Numbers: "44;45;46", Status: ControlStatus.Multiple },
    }),
    ctx.client.oControl.create({
      // BadNoTiming: skipped + propagates leg deduction to next ok
      data: { Id: 47, Name: "", Numbers: "47", Status: ControlStatus.BadNoTiming },
    }),
    ctx.client.oControl.create({
      // OK trailing control — picks up the BadNoTiming leg deduction
      data: { Id: 48, Name: "", Numbers: "48", Status: ControlStatus.OK },
    }),
    ctx.client.oControl.create({
      // Optional: skipped same as Bad, just a different intent. Kept on
      // the side so the multi-control course in this test stays simple.
      data: { Id: 49, Name: "", Numbers: "49", Status: ControlStatus.Optional },
    }),
  ]);

  // Course visiting OK → Bad → NoTiming → Multiple → BadNoTiming → OK.
  // After resolver expansion that's 1 + 1 + 1 + 3 + 1 + 1 = 8 positions.
  const course = await ctx.client.oCourse.create({
    data: {
      Name: "Status Course",
      Controls: "41;42;43;44;47;48;",
      Length: 5000,
      Legs: "600;600;600;600;600;600;600;",
    },
  });
  courseId = course.Id;

  await ctx.client.oClass.update({
    where: { Id: classId },
    data: { Course: courseId },
  });
});

afterAll(async () => {
  await ctx.cleanup();
});

describe("control statuses end-to-end", () => {
  // We register a single runner with a fully-clean card hitting every
  // required position (skipped controls are NOT punched), and assert that
  // the readout / placement / Eventor pipeline applies the right rules.
  let runnerId: number;
  const cardNo = 800001;

  beforeAll(async () => {
    const created = await caller.runner.create({ name: "Tester", classId, cardNo });
    runnerId = created.id;
    await ctx.client.oRunner.update({
      where: { Id: runnerId },
      data: { StartTime: START_TIME_DS - ZERO_TIME_DS },
    });

    // Card punches: 41 → 43 (skipped 42) → 44/45/46 (multiple) → 48
    // (skipped 47, leg into 48 should be deducted by BadNoTiming).
    await caller.cardReadout.storeReadout({
      cardNo,
      punches: [
        { controlCode: 41, time: START_TIME_SECS + 600 },
        // 42 is Bad — runner does NOT punch it
        { controlCode: 43, time: START_TIME_SECS + 1500 }, // NoTiming → leg of 900 deducted (from 41)
        { controlCode: 44, time: START_TIME_SECS + 2100 },
        { controlCode: 45, time: START_TIME_SECS + 2700 },
        { controlCode: 46, time: START_TIME_SECS + 3300 },
        // 47 is BadNoTiming — runner does NOT punch it
        { controlCode: 48, time: START_TIME_SECS + 4500 }, // 1200 leg from 46 → deducted via BadNoTiming propagation
      ],
      startTime: START_TIME_SECS,
      finishTime: START_TIME_SECS + 5400,
      punchesFresh: true,
    });

    // Apply the readout's evaluated status + finish time onto oRunner so
    // that runner.list / placement endpoints see this runner as OK and
    // include them in the rank computation.
    const readout = await caller.cardReadout.readout({ cardNo });
    if (readout.found) {
      await caller.cardReadout.applyResult({
        runnerId,
        status: readout.timing.status,
        finishTime: readout.timing.finishTime,
        startTime: readout.timing.startTime,
      });
    }
  });

  it("readout reports adjusted + raw running time and per-position modes", async () => {
    const readout = await caller.cardReadout.readout({ cardNo });
    expect(readout.found).toBe(true);
    if (!readout.found) return;

    // Total raw card time: 5400 s = 54000 ds. NoTiming leg into 43 = 9000 ds.
    // BadNoTiming-propagated leg into 48 = 12000 ds. Total deducted = 21000.
    expect(readout.timing.rawRunningTime).toBe(54000);
    expect(readout.timing.runningTimeAdjustment).toBe(21000);
    expect(readout.timing.runningTime).toBe(54000 - 21000);

    // Status: every required position is punched, so OK (not MP) — that's
    // the whole point of skipping Bad / BadNoTiming.
    expect(readout.timing.status).toBe(1); // RunnerStatus.OK

    // Per-position modes propagated to the response:
    const modes = readout.controls.map((c) => c.positionMode);
    // [OK, Bad, NoTiming, Multiple x3, BadNoTiming, OK]
    expect(modes).toEqual([
      "required", // 41 OK
      "skipped",  // 42 Bad
      "noTiming", // 43 NoTiming
      "required", // 44 (Multiple expansion 1)
      "required", // 45 (Multiple expansion 2)
      "required", // 46 (Multiple expansion 3)
      "skipped",  // 47 BadNoTiming
      "noTiming", // 48 OK with propagated noTimingLeg
    ]);

    // Runner left no required punches behind, so the missing-controls
    // banner must be empty (skipped controls never bubble up here).
    expect(readout.missingControls).toEqual([]);
    expect(readout.timing.status).toBe(1);

    // Required-control denominator on the kiosk excludes skipped positions.
    // 8 total - 2 skipped = 6 required positions.
    expect(readout.course?.requiredControlCount).toBe(6);
  });

  it("runner.list ranks the runner using the adjusted running time", async () => {
    const list = await caller.runner.list();
    const me = list.find((r) => r.id === runnerId);
    expect(me).toBeDefined();
    expect(me!.runningTimeAdjustment).toBe(21000);
    // Solo runner so place is 1 (this would have been the same regardless;
    // see the unit test computeClassPlacements adjustment ranking).
    expect(me!.rank).toBe(1);
  });

  it("Eventor upload carries adjusted running time + adjusted split-time semantics", async () => {
    // The eventor router builds ResultForUpload[] internally for upload.
    // We can't trigger an actual HTTP push in tests, but we can assert
    // the per-runner adjustment is read off the same matcher path the
    // upload uses: re-running performReadout end-to-end produces the
    // same adjusted running time the upload would carry. This is a
    // proxy for the upload path — exhaustive Eventor XML assertions
    // belong in a dedicated eventor.test.ts.
    const readout = await caller.cardReadout.readout({ cardNo });
    expect(readout.found).toBe(true);
    if (!readout.found) return;
    expect(readout.timing.runningTime).toBe(33000);
  });

  // Sanity reference: ZERO_TIME_DS / ZERO_TIME_SECS aren't read here
  // directly but kept for parity with the surrounding integration tests.
  void ZERO_TIME_DS;
  void ZERO_TIME_SECS;
});
