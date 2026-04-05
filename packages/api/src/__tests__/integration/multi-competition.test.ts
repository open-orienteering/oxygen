/**
 * Multi-competition isolation integration tests.
 *
 * Verifies that tRPC procedures route queries to the correct competition
 * database based on the `dbName` in the request context, so multiple
 * competitions can be served simultaneously without global state interference.
 *
 * These tests are expected to FAIL until the per-request competition routing
 * refactor is complete (Steps 1–3 of the multi-competition plan).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestDb, type TestDbContext } from "../helpers/test-db.js";
import { makeCaller } from "../helpers/caller.js";

let ctx1: TestDbContext;
let ctx2: TestDbContext;
let classId1: number;
let classId2: number;

beforeAll(async () => {
  ctx1 = await createTestDb("mc1");
  ctx2 = await createTestDb("mc2");

  // Seed competition 1 with a class and runner using direct Prisma clients
  // (bypasses global state, ensuring data lands in the right DB)
  const cls1 = await ctx1.client.oClass.create({
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
  classId1 = cls1.Id;

  await ctx1.client.oRunner.create({
    data: {
      Name: "Alice",
      CardNo: 600001,
      Class: classId1,
      StartTime: 0,
      FinishTime: 0,
      InputResult: "",
      Annotation: "",
    },
  });

  // Seed competition 2 with different data
  const cls2 = await ctx2.client.oClass.create({
    data: {
      Name: "D21",
      Course: 0,
      FirstStart: 0,
      StartInterval: 0,
      SortIndex: 1,
      Removed: false,
      Counter: 0,
      FreeStart: 0,
    },
  });
  classId2 = cls2.Id;

  await ctx2.client.oRunner.create({
    data: {
      Name: "Bob",
      CardNo: 600002,
      Class: classId2,
      StartTime: 0,
      FinishTime: 0,
      InputResult: "",
      Annotation: "",
    },
  });
}, 60000);

afterAll(async () => {
  await ctx1.cleanup();
  await ctx2.cleanup();
}, 30000);

describe("multi-competition isolation", () => {
  it("returns only runners from competition 1 when queried with ctx1 dbName", async () => {
    const caller = makeCaller({ dbName: ctx1.dbName });
    const runners = await caller.runner.list();
    const names = runners.map((r) => r.name);
    expect(names).toContain("Alice");
    expect(names).not.toContain("Bob");
  });

  it("returns only runners from competition 2 when queried with ctx2 dbName", async () => {
    const caller = makeCaller({ dbName: ctx2.dbName });
    const runners = await caller.runner.list();
    const names = runners.map((r) => r.name);
    expect(names).toContain("Bob");
    expect(names).not.toContain("Alice");
  });

  it("does not mix data when both competitions are queried simultaneously", async () => {
    const caller1 = makeCaller({ dbName: ctx1.dbName });
    const caller2 = makeCaller({ dbName: ctx2.dbName });

    const [runners1, runners2] = await Promise.all([
      caller1.runner.list(),
      caller2.runner.list(),
    ]);

    const names1 = runners1.map((r) => r.name);
    const names2 = runners2.map((r) => r.name);

    expect(names1).toContain("Alice");
    expect(names1).not.toContain("Bob");

    expect(names2).toContain("Bob");
    expect(names2).not.toContain("Alice");
  });

  it("returns runners from competition 1 even after competition 2 is queried", async () => {
    // This specifically exercises the regression where the second query would
    // switch global state and break the first competition's subsequent queries.
    const caller1 = makeCaller({ dbName: ctx1.dbName });
    const caller2 = makeCaller({ dbName: ctx2.dbName });

    await caller2.runner.list(); // triggers ctx2 query first
    const runners1 = await caller1.runner.list(); // should still return ctx1 data

    const names1 = runners1.map((r) => r.name);
    expect(names1).toContain("Alice");
    expect(names1).not.toContain("Bob");
  });
});
