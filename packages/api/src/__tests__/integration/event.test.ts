/**
 * Integration tests for the event tRPC router (lifecycle + dashboard).
 *
 * Covers create / select / delete / purgeDeleted, the dashboard counts
 * that drive CompetitionDashboard, and the change-watermark surface used
 * by the web client to invalidate caches.
 */

import { describe, it, expect, afterAll } from "vitest";
import { disconnect } from "../helpers/test-db.js";
import { makeCaller } from "../helpers/caller.js";
import { resolveEvent, prisma } from "../../db.js";

afterAll(async () => {
  await disconnect();
});

describe("event.create / delete / purgeDeleted", () => {
  it("creates an event with a sanitized nameId", async () => {
    const slug = `oxygen_test_lifecycle_${Math.random()
      .toString(36)
      .slice(2, 8)}`;
    const publicCaller = makeCaller(null);
    const created = await publicCaller.event.create({
      name: "Lifecycle test",
      nameId: slug,
      date: "2026-04-15",
    });
    expect(created.nameId).toBe(slug);

    // Resolve via DB helper to confirm the row landed.
    const ref = await resolveEvent(slug);
    expect(ref?.nameId).toBe(slug);

    // Soft-delete + purge round-trip.
    await publicCaller.event.delete({ nameId: slug });
    const afterDelete = await resolveEvent(slug);
    expect(afterDelete).toBeNull();

    const purge = await publicCaller.event.purgeDeleted();
    expect(purge.purged).toBeGreaterThanOrEqual(1);
    // Row really gone.
    const row = await prisma().event.findUnique({ where: { nameId: slug } });
    expect(row).toBeNull();
  });

  it("event.select returns a 404-ish error for an unknown nameId", async () => {
    const publicCaller = makeCaller(null);
    await expect(
      publicCaller.event.select({ nameId: "oxygen_test_does_not_exist" }),
    ).rejects.toThrow();
  });
});

describe("event.dashboard", () => {
  it("reports counts for an event with classes + runners + punches", async () => {
    const slug = `oxygen_test_dashboard_${Math.random()
      .toString(36)
      .slice(2, 8)}`;
    const publicCaller = makeCaller(null);
    await publicCaller.event.create({
      name: "Dashboard test",
      nameId: slug,
      date: "2026-04-15",
    });
    const ref = (await resolveEvent(slug))!;
    const caller = makeCaller(ref);
    try {
      const cls = await caller.class.create({ name: "H21" });
      await caller.runner.create({
        name: "A",
        classId: cls.id,
        cardNo: 91001,
        clubName: "OK A",
      });
      await caller.runner.create({
        name: "B",
        classId: cls.id,
        cardNo: 91002,
        clubName: "OK A",
      });

      const dash = await caller.event.dashboard();
      expect(dash.totalRunners).toBe(2);
      expect(dash.totalClubs).toBe(1);
      expect(dash.competition.nameId).toBe(slug);
      expect(dash.event.nameId).toBe(slug);

      // Status counts have the right shape.
      expect(typeof dash.statusCounts.notStarted).toBe("number");
      expect(typeof dash.statusCounts.cancelled).toBe("number");
    } finally {
      await publicCaller.event.delete({ nameId: slug });
      await publicCaller.event.purgeDeleted();
    }
  });
});

describe("event.changeWatermarks", () => {
  it("returns a watermark string per entity table", async () => {
    const slug = `oxygen_test_watermark_${Math.random()
      .toString(36)
      .slice(2, 8)}`;
    const publicCaller = makeCaller(null);
    await publicCaller.event.create({
      name: "Watermark test",
      nameId: slug,
      date: "2026-04-15",
    });
    const ref = (await resolveEvent(slug))!;
    const caller = makeCaller(ref);
    try {
      // Create some activity so updated_at columns are populated.
      const cls = await caller.class.create({ name: "H21" });
      await caller.runner.create({
        name: "Watermark A",
        classId: cls.id,
        cardNo: 92001,
      });

      const wm = await caller.event.changeWatermarks();
      // ISO string for tables with rows, "" for empty tables.
      expect(wm.runners).toMatch(/^\d{4}-/);
      expect(wm.classes).toMatch(/^\d{4}-/);
      expect(wm.punches).toBe("");
      expect(wm.controls).toBe("");
    } finally {
      await publicCaller.event.delete({ nameId: slug });
      await publicCaller.event.purgeDeleted();
    }
  });
});

describe("event.list", () => {
  it("returns kind and Eventor classificationId when meta is linked", async () => {
    const slug = `oxygen_test_list_${Math.random().toString(36).slice(2, 8)}`;
    const eventorEventId = 8_000_000 + Math.floor(Math.random() * 100_000);
    const publicCaller = makeCaller(null);
    await publicCaller.event.create({
      name: "List classification test",
      nameId: slug,
      date: "2026-04-15",
    });
    const db = prisma();
    try {
      await db.event.update({
        where: { nameId: slug },
        data: { eventorEventId: BigInt(eventorEventId) },
      });
      await db.eventorEventMeta.create({
        data: {
          eventorEventId,
          name: "List classification test",
          startDate: new Date("2026-04-15"),
          classificationId: 3,
          organiser: "E2E",
          entryCount: 0,
          fetchedAt: new Date(),
        },
      });

      const listed = await publicCaller.event.list();
      const row = listed.find((e) => e.nameId === slug);
      expect(row).toBeDefined();
      expect(row!.kind).toBe("competition");
      expect(row!.classificationId).toBe(3);
    } finally {
      await db.eventorEventMeta.deleteMany({ where: { eventorEventId } });
      await publicCaller.event.delete({ nameId: slug });
      await publicCaller.event.purgeDeleted();
    }
  });

  it("omits classificationId when the event is not linked to Eventor meta", async () => {
    const slug = `oxygen_test_list_plain_${Math.random().toString(36).slice(2, 8)}`;
    const publicCaller = makeCaller(null);
    await publicCaller.event.create({
      name: "Plain list test",
      nameId: slug,
      date: "2026-04-15",
    });
    try {
      const listed = await publicCaller.event.list();
      const row = listed.find((e) => e.nameId === slug);
      expect(row).toBeDefined();
      expect(row!.kind).toBe("competition");
      expect(row!.classificationId).toBeUndefined();
    } finally {
      await publicCaller.event.delete({ nameId: slug });
      await publicCaller.event.purgeDeleted();
    }
  });
});

describe("event.counterState (legacy alias)", () => {
  it("returns numeric ms counters keyed by legacy table names", async () => {
    const slug = `oxygen_test_counter_${Math.random()
      .toString(36)
      .slice(2, 8)}`;
    const publicCaller = makeCaller(null);
    await publicCaller.event.create({
      name: "Counter test",
      nameId: slug,
      date: "2026-04-15",
    });
    const ref = (await resolveEvent(slug))!;
    const caller = makeCaller(ref);
    try {
      await caller.class.create({ name: "H21" });
      const counters = await caller.event.counterState();
      expect(typeof counters.oRunner).toBe("number");
      expect(typeof counters.oClass).toBe("number");
      expect(counters.oClass).toBeGreaterThan(0);
      expect(counters.oPunch).toBe(0);
    } finally {
      await publicCaller.event.delete({ nameId: slug });
      await publicCaller.event.purgeDeleted();
    }
  });
});
