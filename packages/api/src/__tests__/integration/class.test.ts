/**
 * Integration tests for the class tRPC router.
 *
 * Covers list / create / update / delete / bulkUpdate / reorder plus
 * the runner-count surfacing that drives the dashboard.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  createTestEvent,
  disconnect,
  type TestEventContext,
} from "../helpers/test-db.js";
import { makeCaller } from "../helpers/caller.js";

let ctx: TestEventContext;
let caller: ReturnType<typeof makeCaller>;

beforeAll(async () => {
  ctx = await createTestEvent("class");
  caller = makeCaller(ctx.event);
});

afterAll(async () => {
  await ctx.cleanup();
  await disconnect();
});

describe("class.create + list", () => {
  it("returns sequential ids and lists them in sortIndex order", async () => {
    const a = await caller.class.create({ name: "H21", sortIndex: 10 });
    const b = await caller.class.create({ name: "D21", sortIndex: 1 });
    const c = await caller.class.create({ name: "H50", sortIndex: 5 });
    expect(a.id).toBe(1);
    expect(b.id).toBe(2);
    expect(c.id).toBe(3);

    const list = await caller.class.list();
    expect(list.map((c) => c.name)).toEqual(["D21", "H50", "H21"]);
  });

  it("persists class type, no-timing, and free-start settings", async () => {
    const created = await caller.class.create({
      name: "Configured",
      classType: "Open",
      noTiming: true,
      freeStart: true,
    });
    const detail = await caller.class.getById({ id: created.id });
    expect(detail).toMatchObject({
      classType: "Open",
      noTiming: true,
      freeStart: true,
    });
  });
});

describe("class.update", () => {
  it("patches individual fields without clobbering the rest", async () => {
    const created = await caller.class.create({
      name: "Patch Me",
      lowAge: 10,
      highAge: 20,
    });
    await caller.class.update({ id: created.id, highAge: 25 });
    const detail = await caller.class.getById({ id: created.id });
    expect(detail.lowAge).toBe(10);
    expect(detail.highAge).toBe(25);
  });

  it("rejects an unknown class id", async () => {
    await expect(
      caller.class.update({ id: 9999, name: "Ghost" }),
    ).rejects.toThrow(/not found/i);
  });

  it("persists freeStart updates", async () => {
    const created = await caller.class.create({ name: "Free-start patch" });
    await caller.class.update({ id: created.id, freeStart: true });
    expect((await caller.class.getById({ id: created.id })).freeStart).toBe(true);
  });
});

describe("class.bulkUpdate", () => {
  it("applies the same patch to multiple classes", async () => {
    const a = await caller.class.create({ name: "Bulk A" });
    const b = await caller.class.create({ name: "Bulk B" });
    const res = await caller.class.bulkUpdate({
      ids: [a.id, b.id],
      classFee: 150_00,
    });
    expect(res.count).toBe(2);
    const detA = await caller.class.getById({ id: a.id });
    const detB = await caller.class.getById({ id: b.id });
    expect(detA.classFee).toBe(15000);
    expect(detB.classFee).toBe(15000);
  });

  it("persists freeStart and noTiming bulk updates", async () => {
    const a = await caller.class.create({ name: "Bulk flags A" });
    const b = await caller.class.create({ name: "Bulk flags B" });
    await caller.class.bulkUpdate({
      ids: [a.id, b.id],
      freeStart: true,
      noTiming: true,
    });
    for (const id of [a.id, b.id]) {
      expect(await caller.class.getById({ id })).toMatchObject({
        freeStart: true,
        noTiming: true,
      });
    }
  });
});

describe("class.delete (soft)", () => {
  it("hides deleted classes from list but keeps the row", async () => {
    const created = await caller.class.create({ name: "Doomed" });
    await caller.class.delete({ id: created.id });
    const list = await caller.class.list();
    expect(list.find((c) => c.name === "Doomed")).toBeUndefined();

    const row = await ctx.db.class.findFirst({
      where: { eventId: ctx.eventId, name: "Doomed" },
      select: { removed: true },
    });
    expect(row?.removed).toBe(true);
  });
});

describe("class.reorder", () => {
  it("rewrites sortIndex in the order given", async () => {
    const a = await caller.class.create({ name: "Reord A" });
    const b = await caller.class.create({ name: "Reord B" });
    const c = await caller.class.create({ name: "Reord C" });

    // Force order C, A, B
    await caller.class.reorder({ orderedIds: [c.id, a.id, b.id] });
    const list = await caller.class.list();
    const reordered = list
      .filter((cl) => cl.name.startsWith("Reord"))
      .sort((x, y) => x.sortIndex - y.sortIndex)
      .map((cl) => cl.name);
    expect(reordered).toEqual(["Reord C", "Reord A", "Reord B"]);
  });
});

describe("class.list runner counts", () => {
  it("counts only non-withdrawn runners assigned to each class", async () => {
    const cls = await caller.class.create({ name: "Counted" });
    await caller.runner.create({
      name: "Counted A",
      classId: cls.id,
      cardNo: 1001,
    });
    await caller.runner.create({
      name: "Counted B",
      classId: cls.id,
      cardNo: 1002,
    });
    // Cancel one — must not be counted as a participant.
    const cancelled = await caller.runner.create({
      name: "Counted C",
      classId: cls.id,
      cardNo: 1003,
    });
    // status 21 = Cancel (withdrawn) in the numeric enum mapping.
    await caller.runner.update({ id: cancelled.id, status: 21 });

    const list = await caller.class.list();
    const item = list.find((c) => c.id === cls.id);
    expect(item?.runnerCount).toBe(2);
  });
});
