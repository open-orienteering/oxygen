/**
 * Integration tests for the draw tRPC router.
 *
 * Tests draw.preview and draw.execute against a real MySQL database.
 * Replaces the E2E scenarios in draw.spec.ts that test algorithm
 * correctness (start time assignment, DB persistence, idempotency).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestDb, type TestDbContext } from "../helpers/test-db.js";
import { makeCaller } from "../helpers/caller.js";

let ctx: TestDbContext;

// ─── Fixtures ────────────────────────────────────────────────

async function seedFixture(ctx: TestDbContext) {
  const { client } = ctx;
  const caller = makeCaller({ dbName: ctx.dbName });

  // Create two clubs
  const clubA = await client.oClub.create({
    data: { Name: "Club A", Removed: false, Counter: 0 },
  });
  const clubB = await client.oClub.create({
    data: { Name: "Club B", Removed: false, Counter: 0 },
  });

  // Create two courses
  const courseA = await client.oCourse.create({
    data: {
      Name: "Course A",
      Length: 5000,
      Climb: 100,
      Controls: "",
      Removed: false,
      Counter: 0,
    },
  });
  const courseB = await client.oCourse.create({
    data: {
      Name: "Course B",
      Length: 4000,
      Climb: 80,
      Controls: "",
      Removed: false,
      Counter: 0,
    },
  });

  // Create two classes
  const classA = await client.oClass.create({
    data: {
      Name: "Men Elite",
      Course: courseA.Id,
      FirstStart: 0,
      StartInterval: 0,
      SortIndex: 1,
      Removed: false,
      Counter: 0,
      FreeStart: 0,
    },
  });
  const classB = await client.oClass.create({
    data: {
      Name: "Women Elite",
      Course: courseB.Id,
      FirstStart: 0,
      StartInterval: 0,
      SortIndex: 2,
      Removed: false,
      Counter: 0,
      FreeStart: 0,
    },
  });

  // Create 5 runners in classA via tRPC (alternating clubs)
  const clubABClubs = [clubA.Id, clubB.Id, clubA.Id, clubB.Id, clubA.Id];
  const runnersA = await Promise.all(
    clubABClubs.map((clubId, i) =>
      caller.runner.create({ name: `Runner A${i + 1}`, classId: classA.Id, clubId }),
    ),
  );

  // Create 4 runners in classB via tRPC (alternating clubs)
  const clubBAClubs = [clubA.Id, clubB.Id, clubA.Id, clubB.Id];
  const runnersB = await Promise.all(
    clubBAClubs.map((clubId, i) =>
      caller.runner.create({ name: `Runner B${i + 1}`, classId: classB.Id, clubId }),
    ),
  );

  return { clubA, clubB, courseA, courseB, classA, classB, runnersA, runnersB };
}

// ─── Tests ───────────────────────────────────────────────────

beforeAll(async () => {
  ctx = await createTestDb("draw");
}, 60000);

afterAll(async () => {
  await ctx.cleanup();
}, 30000);

describe("draw.defaults", () => {
  it("returns the classes with correct runner counts", async () => {
    const { classA, classB } = await seedFixture(ctx);
    const caller = makeCaller({ dbName: ctx.dbName });

    const result = await caller.draw.defaults();

    const a = result.classes.find((c) => c.id === classA.Id)!;
    const b = result.classes.find((c) => c.id === classB.Id)!;

    expect(a.runnerCount).toBe(5);
    expect(b.runnerCount).toBe(4);
  });

  it("includes the event ZeroTime", async () => {
    const caller = makeCaller({ dbName: ctx.dbName });
    const result = await caller.draw.defaults();
    // createCompetitionDatabase sets ZeroTime to 324000 (09:00:00)
    expect(result.zeroTime).toBe(324000);
  });
});

describe("draw.preview", () => {
  it("returns all runner IDs in the preview", async () => {
    const { classA, runnersA } = await seedFixture(ctx);
    const caller = makeCaller({ dbName: ctx.dbName });

    const preview = await caller.draw.preview({
      classes: [
        {
          classId: classA.Id,
          method: "random",
          interval: 20,
        },
      ],
      settings: {
        firstStart: 324000,
        baseInterval: 20,
        maxParallelStarts: 1,
        detectCourseOverlap: false,
      },
    });

    const cls = preview.classes.find((c) => c.classId === classA.Id)!;
    expect(cls.entries).toHaveLength(runnersA.length);

    const previewIds = cls.entries.map((e) => e.runnerId).sort((a, b) => a - b);
    const expectedIds = runnersA.map((r) => r.id).sort((a, b) => a - b);
    expect(previewIds).toEqual(expectedIds);
  });

  it("assigns sequential start times with the given interval", async () => {
    const { classA } = await seedFixture(ctx);
    const caller = makeCaller({ dbName: ctx.dbName });
    const FIRST_START = 324000;
    const INTERVAL = 20;

    const preview = await caller.draw.preview({
      classes: [{ classId: classA.Id, method: "random", interval: INTERVAL }],
      settings: {
        firstStart: FIRST_START,
        baseInterval: 20,
        maxParallelStarts: 1,
        detectCourseOverlap: false,
      },
    });

    const cls = preview.classes.find((c) => c.classId === classA.Id)!;
    const sorted = [...cls.entries].sort((a, b) => a.startTime - b.startTime);

    // Each start time should be exactly INTERVAL apart
    for (let i = 1; i < sorted.length; i++) {
      expect(sorted[i].startTime - sorted[i - 1].startTime).toBe(INTERVAL);
    }
    // First start time matches the setting
    expect(sorted[0].startTime).toBe(FIRST_START);
  });

  it("does not modify the database (preview only)", async () => {
    const { classA, runnersA } = await seedFixture(ctx);
    const caller = makeCaller({ dbName: ctx.dbName });

    await caller.draw.preview({
      classes: [{ classId: classA.Id, method: "random", interval: 20 }],
      settings: {
        firstStart: 324000,
        baseInterval: 20,
        maxParallelStarts: 1,
        detectCourseOverlap: false,
      },
    });

    // Runners should still have StartTime=0 (preview doesn't persist)
    const first = await ctx.client.oRunner.findUnique({
      where: { Id: runnersA[0].id },
    });
    expect(first?.StartTime).toBe(0);
  });

  it("clubSeparation method returns valid preview with all runner IDs", async () => {
    // Integration smoke-test: the clubSeparation method is accepted and returns data.
    // Statistical quality is tested by unit tests in algorithms.test.ts.
    const { classA, runnersA } = await seedFixture(ctx);
    const caller = makeCaller({ dbName: ctx.dbName });

    const preview = await caller.draw.preview({
      classes: [{ classId: classA.Id, method: "clubSeparation", interval: 20 }],
      settings: { firstStart: 324000, baseInterval: 20, maxParallelStarts: 1, detectCourseOverlap: false },
    });

    const cls = preview.classes.find((c) => c.classId === classA.Id)!;
    expect(cls.entries).toHaveLength(runnersA.length);
    const returnedIds = cls.entries.map((e) => e.runnerId).sort((a, b) => a - b);
    const expectedIds = runnersA.map((r) => r.id).sort((a, b) => a - b);
    expect(returnedIds).toEqual(expectedIds);
  });
});

describe("draw.execute", () => {
  it("persists start times and start numbers to oRunner", async () => {
    const { classA, runnersA } = await seedFixture(ctx);
    const caller = makeCaller({ dbName: ctx.dbName });

    await caller.draw.execute({
      classes: [{ classId: classA.Id, method: "random", interval: 20 }],
      settings: {
        firstStart: 324000,
        baseInterval: 20,
        maxParallelStarts: 1,
        detectCourseOverlap: false,
      },
    });

    // All runners should now have a non-zero StartTime and StartNo
    // DB stores ZeroTime-relative: firstStart 324000 - ZeroTime 324000 = 0 for first runner
    // Subsequent runners have interval offsets > 0
    const updatedRunners = await ctx.client.oRunner.findMany({
      where: { Id: { in: runnersA.map((r) => r.id) } },
    });
    for (const r of updatedRunners) {
      expect(r.StartTime).toBeGreaterThanOrEqual(0);
      expect(r.StartNo).toBeGreaterThan(0);
    }
    // At least one runner should have a non-zero relative start (interval offset)
    expect(updatedRunners.some((r) => r.StartTime > 0)).toBe(true);
  });

  it("persists FirstStart and StartInterval to oClass", async () => {
    const { classA } = await seedFixture(ctx);
    const caller = makeCaller({ dbName: ctx.dbName });
    const FIRST_START = 324000;
    const INTERVAL = 30;

    await caller.draw.execute({
      classes: [{ classId: classA.Id, method: "random", interval: INTERVAL }],
      settings: {
        firstStart: FIRST_START,
        baseInterval: 20,
        maxParallelStarts: 1,
        detectCourseOverlap: false,
      },
    });

    const updatedClass = await ctx.client.oClass.findUnique({
      where: { Id: classA.Id },
    });
    // DB stores ZeroTime-relative: 324000 - 324000 = 0
    expect(updatedClass?.FirstStart).toBe(0);
    expect(updatedClass?.StartInterval).toBe(INTERVAL);
  });

  it("returns correct totalDrawn count", async () => {
    const { classA, runnersA } = await seedFixture(ctx);
    const caller = makeCaller({ dbName: ctx.dbName });

    const result = await caller.draw.execute({
      classes: [{ classId: classA.Id, method: "random", interval: 20 }],
      settings: {
        firstStart: 324000,
        baseInterval: 20,
        maxParallelStarts: 1,
        detectCourseOverlap: false,
      },
    });

    expect(result.totalDrawn).toBe(runnersA.length);
    expect(result.success).toBe(true);
  });

  it("start numbers are unique within the drawn class", async () => {
    const { classA } = await seedFixture(ctx);
    const caller = makeCaller({ dbName: ctx.dbName });

    await caller.draw.execute({
      classes: [{ classId: classA.Id, method: "random", interval: 20 }],
      settings: {
        firstStart: 324000,
        baseInterval: 20,
        maxParallelStarts: 1,
        detectCourseOverlap: false,
      },
    });

    const runners = await ctx.client.oRunner.findMany({
      where: { Class: classA.Id },
    });
    const startNos = runners.map((r) => r.StartNo);
    expect(new Set(startNos).size).toBe(startNos.length);
  });
});
