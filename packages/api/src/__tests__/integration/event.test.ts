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
import { RunnerStatus } from "@oxygen/shared";

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

  it("validates and stores curated and custom event types", async () => {
    const caller = makeCaller(null);
    const curatedSlug = `oxygen_test_kind_${Math.random().toString(36).slice(2, 8)}`;
    const customSlug = `oxygen_test_kind_custom_${Math.random().toString(36).slice(2, 8)}`;
    try {
      await caller.event.create({
        name: "District kind",
        nameId: curatedSlug,
        date: "2026-04-15",
        kind: "district",
      });
      await caller.event.create({
        name: "Custom kind",
        nameId: customSlug,
        date: "2026-04-15",
        kind: "other",
        kindCustom: "Night cup",
      });

      const curatedRef = (await resolveEvent(curatedSlug))!;
      const customRef = (await resolveEvent(customSlug))!;
      const updated = await makeCaller(customRef).event.updateType({
        kind: "weekly_course",
      });

      expect(updated).toMatchObject({ kind: "weekly_course", kindCustom: "" });
      expect((await caller.event.list()).find((e) => e.nameId === curatedSlug))
        .toMatchObject({ kind: "district", kindCustom: "" });
      expect((await caller.event.list()).find((e) => e.nameId === customSlug))
        .toMatchObject({ kind: "weekly_course", kindCustom: "" });
      expect((await makeCaller(curatedRef).event.dashboard()).event)
        .toMatchObject({ kind: "district", kindCustom: "" });

      await expect(
        caller.event.create({
          name: "Invalid custom kind",
          date: "2026-04-15",
          kind: "other",
        }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    } finally {
      for (const nameId of [curatedSlug, customSlug]) {
        const row = await prisma().event.findUnique({ where: { nameId } });
        if (row) await prisma().event.delete({ where: { id: row.id } });
      }
    }
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
      expect(dash.contentSignals).toEqual({
        hasMap: false,
        hasClasses: true,
        hasCourses: false,
        hasRunners: true,
        hasResults: false,
      });
      expect(dash.contentSignals).toEqual({
        hasMap: false,
        hasClasses: true,
        hasCourses: false,
        hasRunners: true,
        hasResults: false,
      });
    } finally {
      await publicCaller.event.delete({ nameId: slug });
      await publicCaller.event.purgeDeleted();
    }
  });
});

describe("event.dashboard contentSignals", () => {
  it("is all-false on a fresh event, then reflects map / results", async () => {
    const slug = `oxygen_test_signals_${Math.random().toString(36).slice(2, 8)}`;
    const publicCaller = makeCaller(null);
    await publicCaller.event.create({
      name: "Signals test",
      nameId: slug,
      date: "2026-04-15",
    });
    const ref = (await resolveEvent(slug))!;
    const caller = makeCaller(ref);
    const db = prisma();
    try {
      const empty = await caller.event.dashboard();
      expect(empty.contentSignals).toEqual({
        hasMap: false,
        hasClasses: false,
        hasCourses: false,
        hasRunners: false,
        hasResults: false,
      });

      await db.mapFile.create({
        data: {
          eventId: ref.id,
          fileName: "base.ocd",
          fileData: Buffer.from([0]),
        },
      });
      await caller.course.create({ name: "Bana 1" });
      const cls = await caller.class.create({ name: "H21" });
      await caller.runner.create({
        name: "Finished",
        classId: cls.id,
        cardNo: 93001,
        status: RunnerStatus.OK,
        finishTime: 400000,
      });

      const filled = await caller.event.dashboard();
      expect(filled.contentSignals).toEqual({
        hasMap: true,
        hasClasses: true,
        hasCourses: true,
        hasRunners: true,
        hasResults: true,
      });
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
      expect(row!.kindCustom).toBe("");
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
      expect(row!.kindCustom).toBe("");
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
