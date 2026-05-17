/**
 * Integration tests for cancellation (Status=21) handling.
 *
 * Withdrawn entries (Cancel) must:
 * - not contribute to dashboard totalRunners / per-class / per-club counts
 * - appear in their own statusCounts.cancelled bucket
 * - be excluded from the result list, the start list, and the draw
 * - still be returned by runner.list (entries view)
 *
 * DNS (Status=20) is a real result and must keep being counted as
 * "finished" in the dashboard and visible on the result list.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestDb, type TestDbContext } from "../helpers/test-db.js";
import { makeCaller } from "../helpers/caller.js";
import { RunnerStatus } from "@oxygen/shared";

let ctx: TestDbContext;
let classId: number;
let courseId: number;
let controlId: number;
let clubId: number;
let cancelledClubId: number;

const ZERO_TIME = 324000; // 09:00:00, default from createCompetitionDatabase
const FINISH_TIME = ZERO_TIME + 36000; // +1h00m, used for OK/DNS finish times

async function seedRunner(
  client: TestDbContext["client"],
  opts: {
    name: string;
    status: number;
    cardNo: number;
    classId: number;
    clubId: number;
    finishTime?: number;
    startTime?: number;
  },
) {
  return client.oRunner.create({
    data: {
      Name: opts.name,
      CardNo: opts.cardNo,
      Class: opts.classId,
      Club: opts.clubId,
      Status: opts.status,
      StartTime: opts.startTime ?? 0,
      FinishTime: opts.finishTime ?? 0,
      Removed: false,
      Counter: 0,
    },
  });
}

beforeAll(async () => {
  ctx = await createTestDb("cancellation");

  // Set up a course with a single intermediate control so the
  // control.list / control.detail runner counts can be exercised
  // alongside the dashboard / list assertions below.
  const ctrl = await ctx.client.oControl.create({
    data: { Id: 50, Name: "", Numbers: "50", Status: 0 },
  });
  controlId = ctrl.Id;

  const course = await ctx.client.oCourse.create({
    data: {
      Name: "Cancel Course",
      Controls: `${controlId};`,
      Length: 3000,
      Legs: "600;600;",
    },
  });
  courseId = course.Id;

  // Set up classes / clubs (one club exists only for cancelled runners,
  // to verify it's filtered out of competition.clubs).
  const cls = await ctx.client.oClass.create({
    data: {
      Name: "H21",
      Course: courseId,
      FirstStart: 0,
      StartInterval: 0,
      SortIndex: 1,
      Removed: false,
      Counter: 0,
      FreeStart: 0,
    },
  });
  classId = cls.Id;

  const club = await ctx.client.oClub.create({
    data: { Name: "Active Club", Removed: false, Counter: 0 },
  });
  clubId = club.Id;

  const cancelledClub = await ctx.client.oClub.create({
    data: { Name: "All Withdrew Club", Removed: false, Counter: 0 },
  });
  cancelledClubId = cancelledClub.Id;

  // 5 OK runners (with start + finish times so the dashboard counts them as finished)
  for (let i = 0; i < 5; i++) {
    await seedRunner(ctx.client, {
      name: `OK Runner ${i + 1}`,
      cardNo: 600000 + i,
      classId,
      clubId,
      status: RunnerStatus.OK,
      startTime: 1000,
      finishTime: FINISH_TIME - ZERO_TIME, // ZeroTime-relative
    });
  }

  // 1 DNS runner — paid no-show, real result, must count as finished
  await seedRunner(ctx.client, {
    name: "DNS Runner",
    cardNo: 600100,
    classId,
    clubId,
    status: RunnerStatus.DNS,
  });

  // 2 cancelled runners — must be excluded from all counts/lists
  await seedRunner(ctx.client, {
    name: "Cancelled In Active Club",
    cardNo: 600200,
    classId,
    clubId,
    status: RunnerStatus.Cancel,
  });
  await seedRunner(ctx.client, {
    name: "Cancelled Sole Member",
    cardNo: 600201,
    classId,
    clubId: cancelledClubId,
    status: RunnerStatus.Cancel,
  });

  // 1 unstarted runner (Status=Unknown, no start, no finish)
  await seedRunner(ctx.client, {
    name: "Not Yet Started",
    cardNo: 600300,
    classId,
    clubId,
    status: RunnerStatus.Unknown,
  });
}, 60000);

afterAll(async () => {
  await ctx.cleanup();
}, 30000);

// ─── Dashboard counts ─────────────────────────────────────────

describe("competition.dashboard with cancelled runners", () => {
  it("excludes cancelled runners from totalRunners", async () => {
    const caller = makeCaller({ dbName: ctx.dbName });
    const dash = await caller.competition.dashboard();
    // 5 OK + 1 DNS + 1 unstarted = 7 participants. 2 cancelled excluded.
    expect(dash.totalRunners).toBe(7);
  });

  it("counts cancelled runners in statusCounts.cancelled", async () => {
    const caller = makeCaller({ dbName: ctx.dbName });
    const dash = await caller.competition.dashboard();
    expect(dash.statusCounts.cancelled).toBe(2);
  });

  it("counts DNS as finished but not Cancel", async () => {
    const caller = makeCaller({ dbName: ctx.dbName });
    const dash = await caller.competition.dashboard();
    // 5 OK + 1 DNS = 6 finished
    expect(dash.statusCounts.finished).toBe(6);
  });

  it("does not bump notStarted for cancelled runners", async () => {
    const caller = makeCaller({ dbName: ctx.dbName });
    const dash = await caller.competition.dashboard();
    // Only the genuinely-unstarted runner counts here.
    expect(dash.statusCounts.notStarted).toBe(1);
  });

  it("excludes a club whose only runners are all cancelled", async () => {
    const caller = makeCaller({ dbName: ctx.dbName });
    const dash = await caller.competition.dashboard();
    expect(dash.totalClubs).toBe(1);
  });

  it("excludes cancelled runners from per-class runnerCount", async () => {
    const caller = makeCaller({ dbName: ctx.dbName });
    const dash = await caller.competition.dashboard();
    const cls = dash.classes.find((c) => c.id === classId);
    expect(cls?.runnerCount).toBe(7);
  });
});

// ─── Result list ──────────────────────────────────────────────

describe("lists.resultList with cancelled runners", () => {
  it("excludes cancelled runners", async () => {
    const caller = makeCaller({ dbName: ctx.dbName });
    const results = await caller.lists.resultList();
    expect(results.find((r) => r.name === "Cancelled In Active Club")).toBeUndefined();
    expect(results.find((r) => r.name === "Cancelled Sole Member")).toBeUndefined();
  });

  it("includes DNS runners", async () => {
    const caller = makeCaller({ dbName: ctx.dbName });
    const results = await caller.lists.resultList();
    expect(results.find((r) => r.name === "DNS Runner")).toBeDefined();
  });

  it("includes OK runners", async () => {
    const caller = makeCaller({ dbName: ctx.dbName });
    const results = await caller.lists.resultList();
    const okRunners = results.filter((r) => r.status === RunnerStatus.OK);
    expect(okRunners).toHaveLength(5);
  });
});

// ─── Start list ───────────────────────────────────────────────

describe("lists.startList with cancelled runners", () => {
  it("excludes cancelled runners", async () => {
    const caller = makeCaller({ dbName: ctx.dbName });
    const startList = await caller.lists.startList();
    expect(startList.find((r) => r.name === "Cancelled In Active Club")).toBeUndefined();
    expect(startList.find((r) => r.name === "Cancelled Sole Member")).toBeUndefined();
  });
});

// ─── Class list ──────────────────────────────────────────────

describe("lists.classes runnerCount with cancelled runners", () => {
  it("excludes cancelled runners from per-class count", async () => {
    const caller = makeCaller({ dbName: ctx.dbName });
    const classes = await caller.lists.classes();
    const cls = classes.find((c) => c.id === classId);
    expect(cls?.runnerCount).toBe(7);
  });
});

// ─── Club list ───────────────────────────────────────────────

describe("club.list with cancelled runners", () => {
  it("excludes cancelled runners from per-club count", async () => {
    const caller = makeCaller({ dbName: ctx.dbName });
    const clubs = await caller.club.list();
    // Active Club has 5 OK + 1 DNS + 1 unstarted + 1 cancelled = 8 rows.
    // Cancel is excluded from runnerCount so we expect 7.
    const active = clubs.find((c) => c.id === clubId);
    expect(active?.runnerCount).toBe(7);
  });

  it("hides a club whose only runners are all cancelled (default list filter)", async () => {
    const caller = makeCaller({ dbName: ctx.dbName });
    const clubs = await caller.club.list();
    const cancelledOnly = clubs.find((c) => c.id === cancelledClubId);
    expect(cancelledOnly).toBeUndefined();
  });
});

// ─── Runner list (entries view) ──────────────────────────────

describe("runner.list with cancelled runners", () => {
  it("returns cancelled runners (entries view)", async () => {
    const caller = makeCaller({ dbName: ctx.dbName });
    const list = await caller.runner.list();
    expect(list.find((r) => r.name === "Cancelled In Active Club")).toBeDefined();
    expect(list.find((r) => r.name === "Cancelled Sole Member")).toBeDefined();
  });

  it("status:finished filter excludes cancelled runners", async () => {
    const caller = makeCaller({ dbName: ctx.dbName });
    const list = await caller.runner.list({ statusFilter: "finished" });
    expect(list.find((r) => r.status === RunnerStatus.Cancel)).toBeUndefined();
  });

  it("status:finished filter still includes DNS", async () => {
    const caller = makeCaller({ dbName: ctx.dbName });
    const list = await caller.runner.list({ statusFilter: "finished" });
    expect(list.find((r) => r.status === RunnerStatus.DNS)).toBeDefined();
  });
});

// ─── Control runner counts ───────────────────────────────────

describe("control runner counts with cancelled runners", () => {
  it("control.list excludes cancelled runners from runnerCount", async () => {
    const caller = makeCaller({ dbName: ctx.dbName });
    const controls = await caller.control.list();
    const ctrl = controls.find((c) => c.id === controlId);
    // 5 OK + 1 DNS + 1 unstarted = 7 participants. 2 cancelled excluded.
    expect(ctrl?.runnerCount).toBe(7);
  });

  it("control.detail excludes cancelled runners from per-course runner count", async () => {
    const caller = makeCaller({ dbName: ctx.dbName });
    const detail = await caller.control.detail({ id: controlId });
    expect(detail).not.toBeNull();
    const usage = detail!.courses.find((c) => c.courseId === courseId);
    expect(usage?.runnerCount).toBe(7);
    expect(detail!.runnerCount).toBe(7);
  });
});
