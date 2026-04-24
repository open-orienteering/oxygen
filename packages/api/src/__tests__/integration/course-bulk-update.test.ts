/**
 * Integration tests for course.bulkUpdate.
 *
 * The Courses page lets users select several rows and set the same field
 * (most commonly NumberMaps) on all of them in one request. bulkUpdate is
 * the tRPC endpoint behind that flow — it has to touch only the ids it was
 * given, leave other columns alone, skip already-removed rows, and bump the
 * MeOS Counter on every row it changes.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestDb, type TestDbContext } from "../helpers/test-db.js";
import { makeCaller } from "../helpers/caller.js";

let ctx: TestDbContext;
let caller: ReturnType<typeof makeCaller>;
let courseA: number;
let courseB: number;
let courseC: number;
let removedCourse: number;

beforeAll(async () => {
  ctx = await createTestDb("coursebulk");
  caller = makeCaller({ dbName: ctx.dbName });

  // Three regular courses + one already soft-deleted
  const a = await ctx.client.oCourse.create({
    data: {
      Name: "Bana A",
      Controls: "31;32;33",
      Length: 3100,
      NumberMaps: 1,
      FirstAsStart: 0,
      LastAsFinish: 0,
    },
  });
  courseA = a.Id;

  const b = await ctx.client.oCourse.create({
    data: {
      Name: "Bana B",
      Controls: "41;42;43",
      Length: 4100,
      NumberMaps: 2,
      FirstAsStart: 1,
      LastAsFinish: 0,
    },
  });
  courseB = b.Id;

  const c = await ctx.client.oCourse.create({
    data: {
      Name: "Bana C",
      Controls: "51;52;53",
      Length: 5100,
      NumberMaps: 3,
      FirstAsStart: 0,
      LastAsFinish: 1,
    },
  });
  courseC = c.Id;

  const removed = await ctx.client.oCourse.create({
    data: {
      Name: "Borttagen",
      Controls: "99",
      Length: 0,
      NumberMaps: 7,
      FirstAsStart: 0,
      LastAsFinish: 0,
      Removed: true,
    },
  });
  removedCourse = removed.Id;
});

afterAll(async () => {
  await ctx.cleanup();
});

describe("course.bulkUpdate", () => {
  it("sets NumberMaps on exactly the ids given, leaves siblings alone", async () => {
    const result = await caller.course.bulkUpdate({
      ids: [courseA, courseB],
      numberOfMaps: 4,
    });

    expect(result.updated).toBe(2);

    const a = await ctx.client.oCourse.findUnique({ where: { Id: courseA } });
    const b = await ctx.client.oCourse.findUnique({ where: { Id: courseB } });
    const c = await ctx.client.oCourse.findUnique({ where: { Id: courseC } });

    expect(a?.NumberMaps).toBe(4);
    expect(b?.NumberMaps).toBe(4);
    // Course C was not targeted and must retain its original value
    expect(c?.NumberMaps).toBe(3);
  });

  it("only touches the fields in the input", async () => {
    await caller.course.bulkUpdate({
      ids: [courseB],
      numberOfMaps: 5,
    });

    const b = await ctx.client.oCourse.findUnique({ where: { Id: courseB } });
    // NumberMaps changed, but FirstAsStart (set to 1 in seed) must survive
    expect(b?.NumberMaps).toBe(5);
    expect(b?.FirstAsStart).toBe(1);
    // And Name / Length / Controls must survive too
    expect(b?.Name).toBe("Bana B");
    expect(b?.Length).toBe(4100);
    expect(b?.Controls).toBe("41;42;43");
  });

  it("silently skips already-removed courses", async () => {
    const before = await ctx.client.oCourse.findUnique({ where: { Id: removedCourse } });
    expect(before?.NumberMaps).toBe(7);

    const result = await caller.course.bulkUpdate({
      ids: [courseC, removedCourse],
      numberOfMaps: 9,
    });

    // courseC updates, removedCourse is ignored
    expect(result.updated).toBe(1);

    const c = await ctx.client.oCourse.findUnique({ where: { Id: courseC } });
    const r = await ctx.client.oCourse.findUnique({ where: { Id: removedCourse } });
    expect(c?.NumberMaps).toBe(9);
    expect(r?.NumberMaps).toBe(7);
  });

  it("toggles boolean flags in bulk", async () => {
    await caller.course.bulkUpdate({
      ids: [courseA, courseC],
      firstAsStart: true,
      lastAsFinish: true,
    });

    const a = await ctx.client.oCourse.findUnique({ where: { Id: courseA } });
    const c = await ctx.client.oCourse.findUnique({ where: { Id: courseC } });
    expect(a?.FirstAsStart).toBe(1);
    expect(a?.LastAsFinish).toBe(1);
    expect(c?.FirstAsStart).toBe(1);
    expect(c?.LastAsFinish).toBe(1);
  });

  it("is a no-op when no updatable fields are provided", async () => {
    const beforeA = await ctx.client.oCourse.findUnique({ where: { Id: courseA } });

    const result = await caller.course.bulkUpdate({
      ids: [courseA, courseB, courseC],
    });

    expect(result.updated).toBe(0);

    const afterA = await ctx.client.oCourse.findUnique({ where: { Id: courseA } });
    expect(afterA?.NumberMaps).toBe(beforeA?.NumberMaps);
    expect(afterA?.FirstAsStart).toBe(beforeA?.FirstAsStart);
  });

  it("bumps the MeOS Counter on every touched row", async () => {
    const beforeCounter = await ctx.client.oCourse.findUnique({ where: { Id: courseA } });
    const beforeCounterB = await ctx.client.oCourse.findUnique({ where: { Id: courseB } });

    await caller.course.bulkUpdate({
      ids: [courseA, courseB],
      numberOfMaps: 11,
    });

    const afterA = await ctx.client.oCourse.findUnique({ where: { Id: courseA } });
    const afterB = await ctx.client.oCourse.findUnique({ where: { Id: courseB } });

    // MeOS uses Counter to detect changes; it must strictly increase
    expect(afterA!.Counter).toBeGreaterThan(beforeCounter!.Counter);
    expect(afterB!.Counter).toBeGreaterThan(beforeCounterB!.Counter);
  });
});
