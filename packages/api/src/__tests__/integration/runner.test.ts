/**
 * Integration tests for the runner tRPC router.
 *
 * Tests runner CRUD operations against a real MySQL database.
 * Replaces the basic CRUD scenarios currently tested via E2E browser tests.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestDb, type TestDbContext } from "../helpers/test-db.js";
import { makeCaller } from "../helpers/caller.js";

let ctx: TestDbContext;

beforeAll(async () => {
  ctx = await createTestDb("runner");
}, 60000);

afterAll(async () => {
  await ctx.cleanup();
}, 30000);

// ─── Fixtures ────────────────────────────────────────────────

async function seedClass(client: TestDbContext["client"]) {
  return client.oClass.create({
    data: {
      Name: "Test Class",
      Course: 0,
      FirstStart: 0,
      StartInterval: 0,
      SortIndex: 1,
      Removed: false,
      Counter: 0,
      FreeStart: 0,
    },
  });
}

async function seedClub(client: TestDbContext["client"]) {
  return client.oClub.create({
    data: { Name: "Test Club", Removed: false, Counter: 0 },
  });
}

// ─── runner.create ────────────────────────────────────────────

describe("runner.create", () => {
  it("creates a runner and it appears in the list", async () => {
    const cls = await seedClass(ctx.client);
    const caller = makeCaller({ dbName: ctx.dbName });

    await caller.runner.create({ name: "Alice Smith", classId: cls.Id });

    const list = await caller.runner.list({ classId: cls.Id });
    const alice = list.find((r) => r.name === "Alice Smith");
    expect(alice).toBeDefined();
  });

  it("assigns the given classId", async () => {
    const cls = await seedClass(ctx.client);
    const caller = makeCaller({ dbName: ctx.dbName });

    await caller.runner.create({ name: "Bob Jones", classId: cls.Id });

    const list = await caller.runner.list({ classId: cls.Id });
    const bob = list.find((r) => r.name === "Bob Jones");
    expect(bob?.classId).toBe(cls.Id);
  });

  it("assigns an optional cardNo", async () => {
    const cls = await seedClass(ctx.client);
    const caller = makeCaller({ dbName: ctx.dbName });

    await caller.runner.create({ name: "Carol", classId: cls.Id, cardNo: 9999 });

    const list = await caller.runner.list({ classId: cls.Id });
    const carol = list.find((r) => r.name === "Carol");
    expect(carol?.cardNo).toBe(9999);
  });

  it("assigns an optional clubId", async () => {
    const cls = await seedClass(ctx.client);
    const club = await seedClub(ctx.client);
    const caller = makeCaller({ dbName: ctx.dbName });

    await caller.runner.create({
      name: "Dave",
      classId: cls.Id,
      clubId: club.Id,
    });

    const list = await caller.runner.list({ classId: cls.Id });
    const dave = list.find((r) => r.name === "Dave");
    expect(dave?.clubId).toBe(club.Id);
  });
});

// ─── runner.update ────────────────────────────────────────────

describe("runner.update", () => {
  it("updates the runner name", async () => {
    const cls = await seedClass(ctx.client);
    const caller = makeCaller({ dbName: ctx.dbName });

    const created = await caller.runner.create({
      name: "Original Name",
      classId: cls.Id,
    });

    await caller.runner.update({ id: created.id, data: { name: "Updated Name" } });

    const updated = await caller.runner.getById({ id: created.id });
    expect(updated.name).toBe("Updated Name");
  });

  it("updates cardNo without touching other fields", async () => {
    const cls = await seedClass(ctx.client);
    const caller = makeCaller({ dbName: ctx.dbName });

    const created = await caller.runner.create({
      name: "Stable Name",
      classId: cls.Id,
      cardNo: 1234,
    });

    await caller.runner.update({ id: created.id, data: { cardNo: 5678 } });

    const updated = await caller.runner.getById({ id: created.id });
    expect(updated.name).toBe("Stable Name"); // unchanged
    expect(updated.cardNo).toBe(5678); // updated
  });
});

// ─── runner.delete ────────────────────────────────────────────

describe("runner.delete", () => {
  it("removes the runner from the list", async () => {
    const cls = await seedClass(ctx.client);
    const caller = makeCaller({ dbName: ctx.dbName });

    const created = await caller.runner.create({
      name: "To Be Deleted",
      classId: cls.Id,
    });

    await caller.runner.delete({ id: created.id });

    const list = await caller.runner.list({ classId: cls.Id });
    const found = list.find((r) => r.id === created.id);
    expect(found).toBeUndefined();
  });
});

// ─── runner.list ─────────────────────────────────────────────

describe("runner.list", () => {
  it("filters by classId", async () => {
    const cls1 = await seedClass(ctx.client);
    const cls2 = await seedClass(ctx.client);
    const caller = makeCaller({ dbName: ctx.dbName });

    await caller.runner.create({ name: "In Class 1", classId: cls1.Id });
    await caller.runner.create({ name: "In Class 2", classId: cls2.Id });

    const list1 = await caller.runner.list({ classId: cls1.Id });
    expect(list1.every((r) => r.classId === cls1.Id)).toBe(true);
    expect(list1.some((r) => r.name === "In Class 1")).toBe(true);
    expect(list1.some((r) => r.name === "In Class 2")).toBe(false);
  });
});
