/**
 * Integration tests for the registration re-scan flow.
 *
 * Verifies that after a runner is created with a card number:
 * 1. runner.findByCard returns the runner (not null)
 * 2. cardReadout.readout returns found: true
 * 3. race.lookupByCard returns runner info including classFreeStart
 *
 * These are the server-side queries that DeviceManager and KioskPage
 * rely on to determine card action ("pre-start" vs "register").
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestDb, type TestDbContext } from "../helpers/test-db.js";
import { makeCaller } from "../helpers/caller.js";

let ctx: TestDbContext;
let classId: number;
let freeStartClassId: number;

beforeAll(async () => {
  ctx = await createTestDb("rescan");

  // Normal class (no free start)
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

  // Free start class
  const freeCls = await ctx.client.oClass.create({
    data: {
      Name: "Öppen",
      Course: 0,
      FirstStart: 0,
      StartInterval: 0,
      SortIndex: 2,
      Removed: false,
      Counter: 0,
      FreeStart: 1,
    },
  });
  freeStartClassId = freeCls.Id;
}, 60000);

afterAll(async () => {
  await ctx.cleanup();
}, 30000);

// ─── Re-scan: findByCard after registration ──────────────────

describe("re-scan after registration", () => {
  it("runner.findByCard returns runner after creation", async () => {
    const caller = makeCaller();
    await caller.runner.create({ name: "Alice Rescan", classId, cardNo: 500001 });

    const found = await caller.runner.findByCard({ cardNo: 500001 });
    expect(found).not.toBeNull();
    expect(found!.name).toBe("Alice Rescan");
    expect(found!.classId).toBe(classId);
    expect(found!.className).toBe("H21");
  });

  it("cardReadout.readout returns found: true after creation", async () => {
    const caller = makeCaller();
    await caller.runner.create({ name: "Bob Rescan", classId, cardNo: 500002 });

    const result = await caller.cardReadout.readout({ cardNo: 500002 });
    expect(result.found).toBe(true);
    if (result.found) {
      expect(result.runner.name).toBe("Bob Rescan");
    }
  });

  it("cardReadout.readout returns found: false for unknown card", async () => {
    const caller = makeCaller();
    const result = await caller.cardReadout.readout({ cardNo: 999888 });
    expect(result.found).toBe(false);
  });
});

// ─── lookupByCard: freeStart flag ────────────────────────────

describe("race.lookupByCard with freeStart", () => {
  it("returns classFreeStart: false for normal class", async () => {
    const caller = makeCaller();
    await caller.runner.create({ name: "Carol Normal", classId, cardNo: 500003 });

    const result = await caller.race.lookupByCard({ cardNo: 500003 });
    expect(result.found).toBe(true);
    if (result.found) {
      expect(result.runner.name).toBe("Carol Normal");
      expect(result.runner.classFreeStart).toBe(false);
    }
  });

  it("returns classFreeStart: true for free start class", async () => {
    const caller = makeCaller();
    await caller.runner.create({ name: "Dave FreeStart", classId: freeStartClassId, cardNo: 500004 });

    const result = await caller.race.lookupByCard({ cardNo: 500004 });
    expect(result.found).toBe(true);
    if (result.found) {
      expect(result.runner.name).toBe("Dave FreeStart");
      expect(result.runner.classFreeStart).toBe(true);
    }
  });

  it("returns found: false for unknown card", async () => {
    const result = await makeCaller().race.lookupByCard({ cardNo: 999777 });
    expect(result.found).toBe(false);
  });
});
