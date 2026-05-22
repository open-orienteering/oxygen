/**
 * Integration tests for the registrationTrends router.
 *
 * Covers ownTimeline (driven from the event's runner roster +
 * entry_date/entry_time columns) and the Eventor-cache lookups
 * (lookupEventorEvent, findComparableEvents, fetchComparison).
 *
 * The Eventor cache is the only globally-scoped state these tests
 * touch; each test seeds its own meta rows and tears them down so the
 * suites stay independent.
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
  ctx = await createTestEvent("regtrends");
  caller = makeCaller(ctx.event);
  const cls = await caller.class.create({ name: "H21" });
  classSeq = cls.id;
});

afterAll(async () => {
  // Clean any Eventor cache rows the tests left behind.
  await ctx.db.eventorEventMeta.deleteMany({
    where: { eventorEventId: { in: [9000001, 9000002, 9000003] } },
  });
  await ctx.cleanup();
  await disconnect();
});

describe("registrationTrends.ownTimeline", () => {
  it("returns empty entries when no runners have entry_date set", async () => {
    const r = await caller.registrationTrends.ownTimeline();
    expect(r.totalRunners).toBe(0);
    expect(r.datedCount).toBe(0);
    expect(r.entries).toEqual([]);
    expect(r.event.name).toMatch(/Test Event/);
  });

  it("includes runners whose entry_date is populated", async () => {
    // Create runners. `runner.create` stamps nowMeosDate / nowMeosTime,
    // so they'll have an entryDate by default.
    await caller.runner.create({
      name: "Trend A",
      classId: classSeq,
      cardNo: 81001,
    });
    await caller.runner.create({
      name: "Trend B",
      classId: classSeq,
      cardNo: 81002,
    });

    const r = await caller.registrationTrends.ownTimeline();
    expect(r.totalRunners).toBe(2);
    expect(r.datedCount).toBe(2);
    expect(r.classes.length).toBeGreaterThanOrEqual(1);
    // Entries sorted ascending by ISO timestamp.
    const isoTimestamps = r.entries.map((e) => e.at);
    expect([...isoTimestamps].sort()).toEqual(isoTimestamps);
  });
});

describe("registrationTrends.lookupEventorEvent", () => {
  it("throws when the event isn't in the Eventor cache", async () => {
    const publicCaller = makeCaller(null);
    await expect(
      publicCaller.registrationTrends.lookupEventorEvent({
        eventIdOrUrl: "9999999",
      }),
    ).rejects.toThrow();
  });

  it("returns the cached event for both bare id and full URL inputs", async () => {
    // Seed a cache row.
    await ctx.db.eventorEventMeta.upsert({
      where: { eventorEventId: 9000001 },
      create: {
        eventorEventId: 9000001,
        name: "Cached Event 1",
        startDate: new Date("2026-04-15"),
        organiser: "OK Cache",
        classificationId: 3,
        entryCount: 42,
        fetchedAt: new Date(),
      },
      update: {},
    });

    const publicCaller = makeCaller(null);
    const fromId = await publicCaller.registrationTrends.lookupEventorEvent({
      eventIdOrUrl: "9000001",
    });
    expect(fromId.id).toBe(9000001);
    expect(fromId.name).toBe("Cached Event 1");
    expect(fromId.entryCount).toBe(42);

    const fromUrl = await publicCaller.registrationTrends.lookupEventorEvent({
      eventIdOrUrl: "https://eventor.orientering.se/Events/Show/9000001",
    });
    expect(fromUrl.id).toBe(9000001);
  });

  it("rejects garbage input that doesn't parse to an integer", async () => {
    const publicCaller = makeCaller(null);
    await expect(
      publicCaller.registrationTrends.lookupEventorEvent({
        eventIdOrUrl: "not-a-number",
      }),
    ).rejects.toThrow();
  });
});

describe("registrationTrends.findComparableEvents", () => {
  it("returns events from the cache within the given window + classification filter", async () => {
    // findComparableEvents centers its window on `now`, so seed dates
    // close to wall-clock instead of an arbitrary target.
    const today = new Date();
    const yesterday = new Date(today);
    yesterday.setDate(today.getDate() - 1);
    await ctx.db.eventorEventMeta.upsert({
      where: { eventorEventId: 9000002 },
      create: {
        eventorEventId: 9000002,
        name: "Comparable Same Type",
        startDate: yesterday,
        organiser: "Org A",
        classificationId: 3,
        entryCount: 100,
        fetchedAt: new Date(),
      },
      update: {},
    });
    await ctx.db.eventorEventMeta.upsert({
      where: { eventorEventId: 9000003 },
      create: {
        eventorEventId: 9000003,
        name: "Different Type",
        startDate: yesterday,
        organiser: "Org B",
        classificationId: 1,
        entryCount: 200,
        fetchedAt: new Date(),
      },
      update: {},
    });

    const publicCaller = makeCaller(null);
    const res = await publicCaller.registrationTrends.findComparableEvents({
      classificationIds: [3],
      daysAround: 7,
    });
    const ids = res.events.map((e) => e.id);
    expect(ids).toContain(9000002);
    expect(ids).not.toContain(9000003); // wrong classification
  });
});
