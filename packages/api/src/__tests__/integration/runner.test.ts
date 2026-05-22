/**
 * Integration tests for the runner tRPC router.
 *
 * Covers the CRUD surface plus the duplicate-card guard and the
 * bulk-DNS shortcut. Soft-delete (`removed = true`) is tested
 * explicitly because list / find queries must respect it.
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
let classSeq: number;

beforeAll(async () => {
  ctx = await createTestEvent("runner");
  caller = makeCaller(ctx.event);
  const cls = await ctx.db.class.create({
    data: { eventId: ctx.eventId, name: "H21" },
    select: { seq: true },
  });
  classSeq = cls.seq;
});

afterAll(async () => {
  await ctx.cleanup();
  await disconnect();
});

describe("runner.create", () => {
  it("creates a runner and assigns a sequential public id", async () => {
    const r1 = await caller.runner.create({
      name: "Alice",
      classId: classSeq,
      cardNo: 11111,
      clubName: "OK Test",
    });
    expect(r1.id).toBe(1);

    const r2 = await caller.runner.create({
      name: "Bob",
      classId: classSeq,
      cardNo: 22222,
    });
    expect(r2.id).toBe(2);
  });

  it("rejects a duplicate card number with CONFLICT", async () => {
    await caller.runner.create({
      name: "Carol",
      classId: classSeq,
      cardNo: 33333,
    });
    await expect(
      caller.runner.create({
        name: "Carol-Clone",
        classId: classSeq,
        cardNo: 33333,
      }),
    ).rejects.toThrow(/already assigned/i);
  });

  it("allows cardNo = 0 (unassigned) on multiple runners", async () => {
    await caller.runner.create({ name: "Dave", classId: classSeq });
    await caller.runner.create({ name: "Eve", classId: classSeq });
    // No throw.
  });

  it("rejects an unknown class id with NOT_FOUND", async () => {
    await expect(
      caller.runner.create({
        name: "Ghost",
        classId: 99999,
        cardNo: 44444,
      }),
    ).rejects.toThrow(/Class 99999 not found/i);
  });
});

describe("runner.update", () => {
  it("updates a runner via the flat shape", async () => {
    const created = await caller.runner.create({
      name: "Update Me",
      classId: classSeq,
      cardNo: 55555,
    });
    await caller.runner.update({ id: created.id, name: "Updated" });
    const detail = await caller.runner.getById({ id: created.id });
    expect(detail.name).toBe("Updated");
  });

  it("updates a runner via the legacy { data: … } wrapper", async () => {
    const created = await caller.runner.create({
      name: "Wrapper Me",
      classId: classSeq,
      cardNo: 66666,
    });
    await caller.runner.update({
      id: created.id,
      data: { name: "Wrapped", clubName: "OK Wrapper" },
    });
    const detail = await caller.runner.getById({ id: created.id });
    expect(detail.name).toBe("Wrapped");
    expect(detail.clubName).toBe("OK Wrapper");
  });

  it("rejects updating cardNo to one already in use", async () => {
    const a = await caller.runner.create({
      name: "Holder A",
      classId: classSeq,
      cardNo: 70000,
    });
    const b = await caller.runner.create({
      name: "Holder B",
      classId: classSeq,
      cardNo: 70001,
    });
    void a;
    await expect(
      caller.runner.update({ id: b.id, cardNo: 70000 }),
    ).rejects.toThrow(/already assigned/i);
  });

  it("permits updating cardNo to the runner's own current card (no-op)", async () => {
    const created = await caller.runner.create({
      name: "Self Card",
      classId: classSeq,
      cardNo: 77777,
    });
    await caller.runner.update({ id: created.id, cardNo: 77777 });
    const detail = await caller.runner.getById({ id: created.id });
    expect(detail.cardNo).toBe(77777);
  });
});

describe("runner.delete (soft)", () => {
  it("removes a runner from list+getById but keeps the row", async () => {
    const created = await caller.runner.create({
      name: "Soft Delete",
      classId: classSeq,
      cardNo: 88888,
    });
    await caller.runner.delete({ id: created.id });

    await expect(caller.runner.getById({ id: created.id })).rejects.toThrow(
      /not found/i,
    );

    // The DB row still exists with removed=true (audit trail).
    const row = await ctx.db.runner.findFirst({
      where: { eventId: ctx.eventId, cardNo: 88888 },
      select: { removed: true },
    });
    expect(row?.removed).toBe(true);
  });

  it("frees up the card number after a soft delete", async () => {
    await caller.runner.create({
      name: "Freed Card Holder",
      classId: classSeq,
      cardNo: 90000,
    });
    const list = await caller.runner.list({});
    const existing = list.find((r) => r.cardNo === 90000)!;
    await caller.runner.delete({ id: existing.id });
    // New runner with the same card number should now succeed.
    await caller.runner.create({
      name: "Reuser",
      classId: classSeq,
      cardNo: 90000,
    });
  });
});

describe("runner.findByCard", () => {
  it("returns null for an unknown card", async () => {
    const found = await caller.runner.findByCard({ cardNo: 12121212 });
    expect(found).toBeNull();
  });

  it("returns null for cardNo = 0", async () => {
    const found = await caller.runner.findByCard({ cardNo: 0 });
    expect(found).toBeNull();
  });

  it("finds a runner by their card number", async () => {
    await caller.runner.create({
      name: "Findable",
      classId: classSeq,
      cardNo: 13131313,
    });
    const found = await caller.runner.findByCard({ cardNo: 13131313 });
    expect(found?.name).toBe("Findable");
  });
});

describe("runner.bulkDns", () => {
  it("marks several runners DNS in a single call", async () => {
    const a = await caller.runner.create({
      name: "DNS A",
      classId: classSeq,
      cardNo: 14000,
    });
    const b = await caller.runner.create({
      name: "DNS B",
      classId: classSeq,
      cardNo: 14001,
    });
    await caller.runner.bulkDns({ ids: [a.id, b.id] });
    const det = await caller.runner.getById({ id: a.id });
    // 20 is the legacy numeric code for "DNS" in valueToRunnerStatus.
    expect(det.status).toBe(20);
  });
});
