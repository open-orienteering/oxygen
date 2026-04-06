/**
 * Integration tests for the events tRPC router.
 *
 * Tests the event push endpoint against a real MySQL database:
 * - Idempotency (same event ID applied once)
 * - Finish recording via event
 * - Result application via event
 * - Conflict handling (two finishes for same runner)
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestDb, type TestDbContext } from "../helpers/test-db.js";
import { makeCaller } from "../helpers/caller.js";
import { RunnerStatus } from "@oxygen/shared";

let ctx: TestDbContext;
// ZeroTime: 09:00:00 = 324000 deciseconds. All absolute times must be > this.
const ZERO_TIME = 324000;

beforeAll(async () => {
  ctx = await createTestDb("events");
  // Set ZeroTime in oEvent (MeOS stores this as the race base time)
  await ctx.client.oEvent.updateMany({ data: { ZeroTime: ZERO_TIME } });
}, 60000);

afterAll(async () => {
  await ctx.cleanup();
}, 30000);

// ─── Fixtures ────────────────────────────────────────────────

async function seedClassAndCourse() {
  const course = await ctx.client.oCourse.create({
    data: { Name: "Course A", Controls: "31;32;33;", Length: 3200, Removed: false, Counter: 0 },
  });
  const cls = await ctx.client.oClass.create({
    data: { Name: "H21", Course: course.Id, FirstStart: 0, StartInterval: 0, SortIndex: 1, Removed: false, Counter: 0, FreeStart: 0 },
  });
  return { cls, course };
}

// startTimeRel is ZeroTime-relative (how MeOS stores it)
async function seedRunner(name: string, classId: number, cardNo: number, startTimeRel = 6000) {
  return ctx.client.oRunner.create({
    data: {
      Name: name,
      Class: classId,
      CardNo: cardNo,
      StartTime: startTimeRel, // ZeroTime-relative: 6000 = 10 min after ZeroTime
      FinishTime: 0,
      Status: 0,
      Removed: false,
      Counter: 0,
    },
  });
}

// Absolute times used in event payloads (these will be converted by toRelative on the server)
// ZeroTime=324000 (09:00), so 09:10 = 330000, 09:50 = 354000, etc.
const ABS_START = ZERO_TIME + 6000;   // 09:10:00 absolute
const ABS_FINISH = ZERO_TIME + 24000; // 09:40:00 absolute

function makeEvent(overrides: Partial<{
  id: string;
  type: string;
  payload: Record<string, unknown>;
}> = {}) {
  return {
    id: overrides.id ?? crypto.randomUUID(),
    type: overrides.type ?? "finish.recorded",
    competitionId: ctx.dbName,
    stationId: "test-station-1",
    timestamp: Date.now(),
    payload: overrides.payload ?? {},
  };
}

// ─── Tests ───────────────────────────────────────────────────

describe("events.push", () => {
  it("applies a finish.recorded event to a runner", async () => {
    const { cls } = await seedClassAndCourse();
    const runner = await seedRunner("Alice", cls.Id, 1001);
    const caller = makeCaller({ dbName: ctx.dbName });

    const result = await caller.events.push({
      events: [makeEvent({
        type: "finish.recorded",
        payload: { runnerId: runner.Id, finishTime: ABS_FINISH, cardNo: 1001 },
      })],
    });

    expect(result.synced).toHaveLength(1);
    expect(result.failed).toHaveLength(0);

    // Verify runner was updated
    const updated = await ctx.client.oRunner.findUnique({ where: { Id: runner.Id } });
    expect(updated!.FinishTime).toBeGreaterThan(0);
    expect(updated!.Status).toBe(RunnerStatus.OK);
  });

  it("is idempotent — same event ID applied only once", async () => {
    const { cls } = await seedClassAndCourse();
    const runner = await seedRunner("Bob", cls.Id, 1002);
    const caller = makeCaller({ dbName: ctx.dbName });

    const eventId = crypto.randomUUID();
    const event = makeEvent({
      id: eventId,
      type: "finish.recorded",
      payload: { runnerId: runner.Id, finishTime: ABS_FINISH, cardNo: 1002 },
    });

    // Push twice
    const result1 = await caller.events.push({ events: [event] });
    const result2 = await caller.events.push({ events: [event] });

    expect(result1.synced).toContain(eventId);
    expect(result2.synced).toContain(eventId);

    // Runner should only have one finish time applied
    const updated = await ctx.client.oRunner.findUnique({ where: { Id: runner.Id } });
    expect(updated!.FinishTime).toBeGreaterThan(0);
  });

  it("applies result.applied event with status and times", async () => {
    const { cls } = await seedClassAndCourse();
    const runner = await seedRunner("Charlie", cls.Id, 1003);
    const caller = makeCaller({ dbName: ctx.dbName });

    await caller.events.push({
      events: [makeEvent({
        type: "result.applied",
        payload: {
          runnerId: runner.Id,
          status: RunnerStatus.MissingPunch,
          finishTime: ABS_FINISH + 500,
          startTime: ABS_START,
        },
      })],
    });

    const updated = await ctx.client.oRunner.findUnique({ where: { Id: runner.Id } });
    expect(updated!.Status).toBe(RunnerStatus.MissingPunch);
    expect(updated!.FinishTime).toBeGreaterThan(0);
    expect(updated!.StartTime).toBeGreaterThan(0);
  });

  it("does not overwrite an existing finish time (conflict)", async () => {
    const { cls } = await seedClassAndCourse();
    const runner = await seedRunner("Diana", cls.Id, 1004);
    const caller = makeCaller({ dbName: ctx.dbName });

    // First finish
    await caller.events.push({
      events: [makeEvent({
        type: "finish.recorded",
        payload: { runnerId: runner.Id, finishTime: ABS_FINISH - 2000, cardNo: 1004 },
      })],
    });

    const afterFirst = await ctx.client.oRunner.findUnique({ where: { Id: runner.Id } });
    const firstFinishTime = afterFirst!.FinishTime;

    // Second finish (from another station) — should NOT overwrite
    await caller.events.push({
      events: [makeEvent({
        type: "finish.recorded",
        payload: { runnerId: runner.Id, finishTime: ABS_FINISH, cardNo: 1004 },
      })],
    });

    const afterSecond = await ctx.client.oRunner.findUnique({ where: { Id: runner.Id } });
    expect(afterSecond!.FinishTime).toBe(firstFinishTime);
  });

  it("applies start.recorded event", async () => {
    const { cls } = await seedClassAndCourse();
    const runner = await seedRunner("Eve", cls.Id, 1005, 0); // no start time
    const caller = makeCaller({ dbName: ctx.dbName });

    await caller.events.push({
      events: [makeEvent({
        type: "start.recorded",
        payload: { runnerId: runner.Id, startTime: ABS_START + 1000 },
      })],
    });

    const updated = await ctx.client.oRunner.findUnique({ where: { Id: runner.Id } });
    expect(updated!.StartTime).toBeGreaterThan(0);
  });

  it("applies runner.registered event (skips if card taken)", async () => {
    const { cls } = await seedClassAndCourse();
    const club = await ctx.client.oClub.create({
      data: { Name: "Test Club", Removed: false, Counter: 0 },
    });
    const caller = makeCaller({ dbName: ctx.dbName });

    // Register a new runner via event
    const result = await caller.events.push({
      events: [makeEvent({
        type: "runner.registered",
        payload: {
          tempId: crypto.randomUUID(),
          name: "Frank",
          classId: cls.Id,
          clubId: club.Id,
          cardNo: 2001,
        },
      })],
    });

    expect(result.synced).toHaveLength(1);

    // Verify runner was created
    const runners = await ctx.client.oRunner.findMany({ where: { CardNo: 2001, Removed: false } });
    expect(runners).toHaveLength(1);
    expect(runners[0].Name).toBe("Frank");

    // Try to register another runner with the same card — should be skipped (no error)
    const result2 = await caller.events.push({
      events: [makeEvent({
        type: "runner.registered",
        payload: {
          tempId: crypto.randomUUID(),
          name: "Frank Duplicate",
          classId: cls.Id,
          clubId: club.Id,
          cardNo: 2001,
        },
      })],
    });

    expect(result2.synced).toHaveLength(1);
    // Still only one runner with this card
    const runners2 = await ctx.client.oRunner.findMany({ where: { CardNo: 2001, Removed: false } });
    expect(runners2).toHaveLength(1);
  });

  it("handles batch of multiple events in order", async () => {
    const { cls } = await seedClassAndCourse();
    const runner = await seedRunner("Grace", cls.Id, 1006);
    const caller = makeCaller({ dbName: ctx.dbName });

    const result = await caller.events.push({
      events: [
        makeEvent({
          type: "finish.recorded",
          payload: { runnerId: runner.Id, finishTime: ABS_FINISH + 500, cardNo: 1006 },
        }),
        makeEvent({
          type: "result.applied",
          payload: {
            runnerId: runner.Id,
            status: RunnerStatus.OK,
            finishTime: ABS_FINISH + 500,
            startTime: ABS_START,
          },
        }),
      ],
    });

    expect(result.synced).toHaveLength(2);
    expect(result.failed).toHaveLength(0);

    const updated = await ctx.client.oRunner.findUnique({ where: { Id: runner.Id } });
    expect(updated!.Status).toBe(RunnerStatus.OK);
  });
});
