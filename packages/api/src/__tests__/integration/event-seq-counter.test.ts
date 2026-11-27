/**
 * `allocate_event_seq()` must keep `event_seqs` ahead of any explicit `seq`
 * (review DB-01 / SYNC-02): a checkout snapshot inserts rows with the
 * cloud's seq values, and the counter must follow, or the next local create
 * collides with the unique (event_id, seq) index.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestEvent, disconnect, type TestEventContext } from "../helpers/test-db.js";
import { makeCaller } from "../helpers/caller.js";

let ctx: TestEventContext;
let caller: ReturnType<typeof makeCaller>;

beforeAll(async () => {
  ctx = await createTestEvent("seqctr");
  caller = makeCaller(ctx.event);
});

afterAll(async () => {
  await ctx.cleanup();
  await disconnect();
});

describe("event_seqs follows explicit seq values", () => {
  it("runner: an explicit seq 7 is followed by seq 8", async () => {
    const cls = await caller.class.create({ name: "Seq" });
    const clsRow = await ctx.db.class.findFirstOrThrow({ where: { eventId: ctx.eventId, name: "Seq" } });
    await ctx.db.runner.create({
      data: { eventId: ctx.eventId, seq: 7, name: "Explicit", classId: clsRow.id, cardNo: 810007 },
    });
    const next = await caller.runner.create({ name: "Auto", classId: cls.id, cardNo: 810008 });
    const row = await ctx.db.runner.findFirstOrThrow({ where: { eventId: ctx.eventId, cardNo: 810008 } });
    expect(row.seq).toBe(8);
    expect(next).toBeDefined();
  });

  it("class: explicit seq 20 is followed by 21", async () => {
    await ctx.db.class.create({ data: { eventId: ctx.eventId, seq: 20, name: "Explicit" } });
    const auto = await ctx.db.class.create({ data: { eventId: ctx.eventId, name: "Auto2" } });
    expect(auto.seq).toBe(21);
  });

  it("course: explicit seq 5 is followed by 6", async () => {
    await ctx.db.course.create({ data: { eventId: ctx.eventId, seq: 5, name: "Explicit" } });
    const auto = await ctx.db.course.create({ data: { eventId: ctx.eventId, name: "Auto" } });
    expect(auto.seq).toBe(6);
  });

  it("control: explicit seq 40 is followed by 41", async () => {
    await ctx.db.control.create({ data: { eventId: ctx.eventId, seq: 40, codes: "40" } });
    const auto = await ctx.db.control.create({ data: { eventId: ctx.eventId, codes: "41" } });
    expect(auto.seq).toBe(41);
  });

  it("a lower explicit seq never moves the counter back", async () => {
    await ctx.db.class.create({ data: { eventId: ctx.eventId, seq: 3, name: "Low" } });
    const auto = await ctx.db.class.create({ data: { eventId: ctx.eventId, name: "AfterLow" } });
    expect(auto.seq).toBe(22);
  });
});
