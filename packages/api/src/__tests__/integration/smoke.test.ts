/**
 * Sanity test for the integration harness itself: confirms that the
 * test container, migrations, helper, and the event/cascade cleanup
 * all work together. If this fails, every other integration test will
 * also fail; fix this first.
 */

import { describe, it, expect, afterAll } from "vitest";
import { createTestEvent, disconnect } from "../helpers/test-db.js";
import { makeCaller } from "../helpers/caller.js";

afterAll(async () => {
  await disconnect();
});

describe("integration harness smoke", () => {
  it("connects to the test DB and creates/deletes an isolated event", async () => {
    const ctx = await createTestEvent("smoke");
    try {
      expect(ctx.event.nameId).toMatch(/^oxygen_test_smoke_/);
      expect(typeof ctx.event.id).toBe("bigint");
      expect(ctx.event.zeroTime).toBe(324000); // 09:00:00 default
    } finally {
      await ctx.cleanup();
    }
  });

  it("exposes an event-scoped tRPC caller", async () => {
    const ctx = await createTestEvent("smoke-trpc");
    try {
      const caller = makeCaller(ctx.event);
      const dash = await caller.event.dashboard();
      expect(dash.competition.nameId).toBe(ctx.nameId);
      expect(dash.totalRunners).toBe(0);
      expect(dash.totalClubs).toBe(0);
    } finally {
      await ctx.cleanup();
    }
  });

  it("rejects event procedures without an event context", async () => {
    const caller = makeCaller(null);
    await expect(caller.event.dashboard()).rejects.toThrow(
      /No event selected/i,
    );
  });

  it("cascades delete to event-scoped children", async () => {
    const ctx = await createTestEvent("smoke-cascade");
    const cls = await ctx.db.class.create({
      data: { eventId: ctx.eventId, name: "H21" },
      select: { id: true, seq: true },
    });
    expect(cls.seq).toBe(1);

    await ctx.cleanup();

    // The class row must be gone (cascade).
    const found = await ctx.db.class.findUnique({ where: { id: cls.id } });
    expect(found).toBeNull();
  });
});
