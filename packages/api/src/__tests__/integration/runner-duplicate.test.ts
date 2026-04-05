/**
 * Integration tests for duplicate card prevention and findByCard query.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestDb, type TestDbContext } from "../helpers/test-db.js";
import { makeCaller } from "../helpers/caller.js";

let ctx: TestDbContext;
let classId: number;

beforeAll(async () => {
  ctx = await createTestDb("dup");
  const cls = await ctx.client.oClass.create({
    data: { Name: "H21", Course: 0, FirstStart: 0, StartInterval: 0, SortIndex: 1, Removed: false, Counter: 0, FreeStart: 0 },
  });
  classId = cls.Id;
}, 60000);

afterAll(async () => {
  await ctx.cleanup();
}, 30000);

// ─── runner.findByCard ────────────────────────────────────────

describe("runner.findByCard", () => {
  it("returns null for unknown card", async () => {
    const caller = makeCaller({ dbName: ctx.dbName });
    const result = await caller.runner.findByCard({ cardNo: 999999 });
    expect(result).toBeNull();
  });

  it("returns null for cardNo <= 0", async () => {
    const caller = makeCaller({ dbName: ctx.dbName });
    expect(await caller.runner.findByCard({ cardNo: 0 })).toBeNull();
    expect(await caller.runner.findByCard({ cardNo: -1 })).toBeNull();
  });

  it("returns runner info for known card", async () => {
    const caller = makeCaller({ dbName: ctx.dbName });
    const created = await caller.runner.create({ name: "FindMe", classId, cardNo: 100001 });
    const found = await caller.runner.findByCard({ cardNo: 100001 });

    expect(found).not.toBeNull();
    expect(found!.id).toBe(created.id);
    expect(found!.name).toBe("FindMe");
    expect(found!.cardNo).toBe(100001);
    expect(found!.className).toBe("H21");
    expect(found!.finishTime).toBe(0);
    expect(found!.status).toBe(0);
  });

  it("returns null for removed runner's card", async () => {
    const caller = makeCaller({ dbName: ctx.dbName });
    const created = await caller.runner.create({ name: "Removed", classId, cardNo: 100002 });
    await caller.runner.delete({ id: created.id });

    const found = await caller.runner.findByCard({ cardNo: 100002 });
    expect(found).toBeNull();
  });
});

// ─── Duplicate card prevention in runner.create ──────────────

describe("runner.create duplicate card prevention", () => {
  it("allows creating runner with unique card", async () => {
    const caller = makeCaller({ dbName: ctx.dbName });
    const result = await caller.runner.create({ name: "Unique Card", classId, cardNo: 200001 });
    expect(result.id).toBeGreaterThan(0);
  });

  it("rejects creating runner with card already assigned", async () => {
    const caller = makeCaller({ dbName: ctx.dbName });
    await caller.runner.create({ name: "First Owner", classId, cardNo: 200002 });

    await expect(
      caller.runner.create({ name: "Second Owner", classId, cardNo: 200002 }),
    ).rejects.toThrow(/Card 200002 is already assigned/);
  });

  it("allows multiple runners with cardNo=0 (unassigned)", async () => {
    const caller = makeCaller({ dbName: ctx.dbName });
    const r1 = await caller.runner.create({ name: "No Card 1", classId, cardNo: 0 });
    const r2 = await caller.runner.create({ name: "No Card 2", classId, cardNo: 0 });
    expect(r1.id).not.toBe(r2.id);
  });

  it("allows reusing card from a removed runner", async () => {
    const caller = makeCaller({ dbName: ctx.dbName });
    const original = await caller.runner.create({ name: "Will Be Removed", classId, cardNo: 200003 });
    await caller.runner.delete({ id: original.id });

    // Card should now be available
    const reuse = await caller.runner.create({ name: "Reuses Card", classId, cardNo: 200003 });
    expect(reuse.id).toBeGreaterThan(0);
  });
});

// ─── Duplicate card prevention in runner.update ──────────────

describe("runner.update duplicate card prevention", () => {
  it("allows updating cardNo to an unused value", async () => {
    const caller = makeCaller({ dbName: ctx.dbName });
    const created = await caller.runner.create({ name: "Update Card", classId, cardNo: 300001 });

    await caller.runner.update({ id: created.id, data: { cardNo: 300099 } });

    const updated = await caller.runner.getById({ id: created.id });
    expect(updated.cardNo).toBe(300099);
  });

  it("rejects updating cardNo to one already taken", async () => {
    const caller = makeCaller({ dbName: ctx.dbName });
    await caller.runner.create({ name: "Card Owner", classId, cardNo: 300002 });
    const other = await caller.runner.create({ name: "Wants Same Card", classId, cardNo: 300003 });

    await expect(
      caller.runner.update({ id: other.id, data: { cardNo: 300002 } }),
    ).rejects.toThrow(/Card 300002 is already assigned/);
  });

  it("allows keeping same cardNo (self-update)", async () => {
    const caller = makeCaller({ dbName: ctx.dbName });
    const created = await caller.runner.create({ name: "Self Update", classId, cardNo: 300004 });

    // Updating name while keeping same cardNo should work
    await caller.runner.update({ id: created.id, data: { cardNo: 300004, name: "Renamed" } });

    const updated = await caller.runner.getById({ id: created.id });
    expect(updated.name).toBe("Renamed");
    expect(updated.cardNo).toBe(300004);
  });
});
