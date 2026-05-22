/**
 * Integration regression for the cross-cutting "Cancel (status=21)
 * doesn't mean finished" rule. Cancelled (withdrawn) entries must be
 * excluded from:
 *
 *   - dashboard `totalRunners` / `totalClubs` / `statusCounts.finished`
 *   - draw runner counts
 *   - class list runnerCount
 *   - course runner counts (via the class group-by)
 *
 * This corresponds to the bugfix documented in
 * docs/bugfix-cancellation-handling.md (originally numeric `Status > 0`
 * coalesced Cancel with "has a result"). The PG schema now uses an
 * ENUM (`cancel`), so the bug can only re-appear if a status filter
 * forgets to add `cancel` to the withdrawn set.
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
  ctx = await createTestEvent("cancel");
  caller = makeCaller(ctx.event);
  const cls = await caller.class.create({ name: "H21" });
  classSeq = cls.id;

  // 3 active runners + 2 cancelled (Status = 21).
  await caller.runner.create({
    name: "Active A",
    classId: classSeq,
    cardNo: 70001,
    clubName: "OK Active",
  });
  await caller.runner.create({
    name: "Active B",
    classId: classSeq,
    cardNo: 70002,
    clubName: "OK Active",
  });
  await caller.runner.create({
    name: "Active C",
    classId: classSeq,
    cardNo: 70003,
    clubName: "OK Other",
  });
  const c1 = await caller.runner.create({
    name: "Cancel One",
    classId: classSeq,
    cardNo: 70004,
    clubName: "OK Cancelled",
  });
  const c2 = await caller.runner.create({
    name: "Cancel Two",
    classId: classSeq,
    cardNo: 70005,
    clubName: "OK Cancelled",
  });
  await caller.runner.update({ id: c1.id, status: 21 });
  await caller.runner.update({ id: c2.id, status: 21 });
});

afterAll(async () => {
  await ctx.cleanup();
  await disconnect();
});

describe("Cancel (status=21) exclusions", () => {
  it("dashboard totalRunners + totalClubs exclude cancelled entries", async () => {
    const d = await caller.event.dashboard();
    expect(d.totalRunners).toBe(3);
    expect(d.totalClubs).toBe(2); // OK Active + OK Other, not OK Cancelled
    expect(d.statusCounts.cancelled).toBe(2);
  });

  it("dashboard finished counter does not bucket cancelled rows", async () => {
    const d = await caller.event.dashboard();
    // No actual finishes — the bug used to count Cancel as finished.
    expect(d.statusCounts.finished).toBe(0);
  });

  it("class.list runnerCount excludes cancelled entries", async () => {
    const list = await caller.class.list();
    const cls = list.find((c) => c.id === classSeq);
    expect(cls?.runnerCount).toBe(3);
  });

  it("draw.defaults runnerCount excludes cancelled entries", async () => {
    const d = await caller.draw.defaults();
    const cls = d.classes.find((c) => c.id === classSeq);
    expect(cls?.runnerCount).toBe(3);
  });

  it("unwithdrawing a runner brings them back into the active counts", async () => {
    const cancelled = await ctx.db.runner.findFirst({
      where: { eventId: ctx.eventId, name: "Cancel One" },
      select: { seq: true },
    });
    // status 1 = OK (active).
    await caller.runner.update({ id: cancelled!.seq, status: 1 });
    const d = await caller.event.dashboard();
    expect(d.totalRunners).toBe(4);
    expect(d.statusCounts.cancelled).toBe(1);
  });
});
