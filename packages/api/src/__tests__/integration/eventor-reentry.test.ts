/**
 * Integration test for the Eventor re-entry status reset.
 *
 * Scenario: a runner was previously stamped Status=Cancel (21) by an
 * earlier sync that detected them as withdrawn. The next Eventor sync
 * snapshot has them back in entries (without a result yet). The sync
 * must reset Status to 0 (or 22 if the class is noTiming) so they
 * show up again as a regular pre-race entry.
 *
 * The Eventor HTTP fetches are mocked at the module level so the test
 * exercises only the routers/eventor.ts merge logic against a real DB.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

vi.mock("../../eventor.js", async () => {
  const actual =
    await vi.importActual<typeof import("../../eventor.js")>(
      "../../eventor.js",
    );
  return {
    ...actual,
    fetchEventClasses: vi.fn(),
    fetchEntries: vi.fn(),
    fetchResults: vi.fn(),
    fetchReferencedClubs: vi.fn(async () => []),
    fetchClubs: vi.fn(async () => []),
    fetchEventOrganiser: vi.fn(async () => null),
    fetchClubLogo: vi.fn(async () => null),
    validateApiKey: vi.fn(async () => ({ id: 1, name: "Mock Org" })),
  };
});

import {
  fetchEventClasses,
  fetchEntries,
  fetchResults,
  type EventorEntry,
  type EventorEventClass,
} from "../../eventor.js";
import { setSetting } from "../../db.js";
import { createTestEvent, disconnect } from "../helpers/test-db.js";
import { makeCaller } from "../helpers/caller.js";
import { eventorKeyStore } from "../../eventorKeyStore.js";

const EVENTOR_EVENT_ID = 99_001;
const CLASS_BASE = 12_345;
const PERSON_BASE = 67_890;

beforeAll(async () => {
  // This suite runs in parallel with eventor-import-cardless, which owns the
  // production key setting. Use the test-environment key so either suite's
  // cleanup cannot invalidate the other's in-flight sync.
  await setSetting("eventor_api_key_test", "test-key");
  eventorKeyStore._resetForTests();
}, 30_000);

afterAll(async () => {
  await setSetting("eventor_api_key_test", null);
  eventorKeyStore._resetForTests();
  await disconnect();
}, 30_000);

function makeClass(
  classId: number,
  name: string,
  noTiming = false,
  courseLengthM?: number,
): EventorEventClass {
  return {
    classId,
    name,
    shortName: name,
    sex: "M",
    lowAge: 0,
    highAge: 0,
    sequence: 1,
    classType: "",
    noTiming,
    courseLengthM,
  };
}

function makeEntry(
  classId: number,
  personId: number,
  personName: string,
  cardNo: number,
  className: string,
  noTiming = false,
): EventorEntry {
  return {
    personName,
    personId,
    birthYear: 1990,
    sex: "M",
    nationality: "SWE",
    organisationId: 0,
    organisationName: "",
    organisationShortName: "",
    organisationCountry: "SWE",
    classId,
    className,
    cardNo,
    eventorEntryId: personId,
    entryDate: 0,
    entryTime: 0,
    fee: 0,
    paid: 0,
    taxable: 0,
    rankingScore: 0,
    noTiming,
  };
}

describe("eventor.sync re-entry status reset", () => {
  it("updates an assigned course from Eventor's published class length", async () => {
    const ctx = await createTestEvent("evr-course-length");
    try {
      await ctx.db.event.update({
        where: { id: ctx.eventId },
        data: { eventorEventId: BigInt(EVENTOR_EVENT_ID), eventorEnv: "test" },
      });
      const course = await ctx.db.course.create({
        data: { eventId: ctx.eventId, name: "U4", lengthM: 1200 },
      });
      await ctx.db.class.create({
        data: {
          eventId: ctx.eventId,
          name: "U4",
          eventorId: BigInt(CLASS_BASE + 10),
          courseId: course.id,
        },
      });

      vi.mocked(fetchEventClasses).mockResolvedValue([
        makeClass(CLASS_BASE + 10, "U4", false, 2480),
      ]);
      vi.mocked(fetchEntries).mockResolvedValue([]);
      vi.mocked(fetchResults).mockResolvedValue([]);

      await makeCaller(ctx.event).eventor.sync();

      const after = await ctx.db.course.findUnique({
        where: { id: course.id },
        select: { lengthM: true },
      });
      expect(after?.lengthM).toBe(2480);
    } finally {
      await ctx.cleanup();
    }
  });

  it("overwrites a 'file' length_source course's length (E6)", async () => {
    const ctx = await createTestEvent("evr-file-course-length");
    try {
      await ctx.db.event.update({
        where: { id: ctx.eventId },
        data: { eventorEventId: BigInt(EVENTOR_EVENT_ID), eventorEnv: "test" },
      });
      const course = await ctx.db.course.create({
        data: { eventId: ctx.eventId, name: "U4 file", lengthM: 1200, lengthSource: "file" },
      });
      await ctx.db.class.create({
        data: { eventId: ctx.eventId, name: "U4", eventorId: BigInt(CLASS_BASE + 12), courseId: course.id },
      });
      vi.mocked(fetchEventClasses).mockResolvedValue([makeClass(CLASS_BASE + 12, "U4", false, 2480)]);
      vi.mocked(fetchEntries).mockResolvedValue([]);
      vi.mocked(fetchResults).mockResolvedValue([]);

      await makeCaller(ctx.event).eventor.sync();

      const after = await ctx.db.course.findUnique({ where: { id: course.id }, select: { lengthM: true } });
      expect(after?.lengthM).toBe(2480);
    } finally {
      await ctx.cleanup();
    }
  });

  it("does not overwrite an editor-owned course with Eventor's old published length", async () => {
    const ctx = await createTestEvent("evr-edited-course-length");
    try {
      await ctx.db.event.update({
        where: { id: ctx.eventId },
        data: { eventorEventId: BigInt(EVENTOR_EVENT_ID), eventorEnv: "test" },
      });
      const course = await ctx.db.course.create({
        data: {
          eventId: ctx.eventId,
          name: "U4 edited",
          lengthM: 2710,
          // E6: the sync reads `length_source`, not `geometry_source`.
          lengthSource: "derived",
        },
      });
      await ctx.db.class.create({
        data: {
          eventId: ctx.eventId,
          name: "U4",
          eventorId: BigInt(CLASS_BASE + 11),
          courseId: course.id,
        },
      });

      vi.mocked(fetchEventClasses).mockResolvedValue([
        makeClass(CLASS_BASE + 11, "U4", false, 2480),
      ]);
      vi.mocked(fetchEntries).mockResolvedValue([]);
      vi.mocked(fetchResults).mockResolvedValue([]);

      await makeCaller(ctx.event).eventor.sync();

      const after = await ctx.db.course.findUnique({
        where: { id: course.id },
        select: { lengthM: true },
      });
      expect(after?.lengthM).toBe(2710);
    } finally {
      await ctx.cleanup();
    }
  });

  it("resets Status from Cancel back to Unknown when a runner reappears in entries (no result)", async () => {
    const ctx = await createTestEvent("evr-reset");
    try {
      // Link the event to an Eventor event so the sync mutation finds it.
      await ctx.db.event.update({
        where: { id: ctx.eventId },
        data: { eventorEventId: BigInt(EVENTOR_EVENT_ID), eventorEnv: "test" },
      });

      // Seed a previously-cancelled runner. The sync looks up by
      // `eventorPersonId`, so the row must carry it.
      const cls = await ctx.db.class.create({
        data: {
          eventId: ctx.eventId,
          name: "H21",
          eventorId: BigInt(CLASS_BASE),
        },
      });
      const runner = await ctx.db.runner.create({
        data: {
          eventId: ctx.eventId,
          name: "Reinstated Runner",
          cardNo: 700_001,
          classId: cls.id,
          status: "cancel",
          eventorPersonId: BigInt(PERSON_BASE),
          entrySource: EVENTOR_EVENT_ID,
        },
      });

      vi.mocked(fetchEventClasses).mockResolvedValue([
        makeClass(CLASS_BASE, "H21"),
      ]);
      vi.mocked(fetchEntries).mockResolvedValue([
        makeEntry(CLASS_BASE, PERSON_BASE, "Reinstated Runner", 700_001, "H21"),
      ]);
      vi.mocked(fetchResults).mockResolvedValue([]);

      const caller = makeCaller(ctx.event);
      await caller.eventor.sync();

      const after = await ctx.db.runner.findUnique({
        where: { id: runner.id },
        select: { status: true },
      });
      // unknown (0) — they're back in the start list as a normal entry.
      expect(after?.status).toBe("unknown");
    } finally {
      await ctx.cleanup();
    }
  });

  it("uses NoTiming when the reinstated entry's class is no-timing", async () => {
    const ctx = await createTestEvent("evr-notiming");
    try {
      await ctx.db.event.update({
        where: { id: ctx.eventId },
        data: { eventorEventId: BigInt(EVENTOR_EVENT_ID), eventorEnv: "test" },
      });

      const cls = await ctx.db.class.create({
        data: {
          eventId: ctx.eventId,
          name: "Open No-Timing",
          eventorId: BigInt(CLASS_BASE + 1),
          noTiming: true,
        },
      });
      const runner = await ctx.db.runner.create({
        data: {
          eventId: ctx.eventId,
          name: "Reinstated NoTiming",
          cardNo: 700_002,
          classId: cls.id,
          status: "cancel",
          eventorPersonId: BigInt(PERSON_BASE + 1),
          entrySource: EVENTOR_EVENT_ID,
        },
      });

      vi.mocked(fetchEventClasses).mockResolvedValue([
        makeClass(CLASS_BASE + 1, "Open No-Timing", true),
      ]);
      vi.mocked(fetchEntries).mockResolvedValue([
        makeEntry(
          CLASS_BASE + 1,
          PERSON_BASE + 1,
          "Reinstated NoTiming",
          700_002,
          "Open No-Timing",
          true,
        ),
      ]);
      vi.mocked(fetchResults).mockResolvedValue([]);

      const caller = makeCaller(ctx.event);
      await caller.eventor.sync();

      const after = await ctx.db.runner.findUnique({
        where: { id: runner.id },
        select: { status: true },
      });
      // Class is no-timing → reinstated status is NoTiming (PG
      // enum `no_timing`, RunnerStatus.NoTiming = 2).
      expect(after?.status).toBe("no_timing");
    } finally {
      await ctx.cleanup();
    }
  });

  it("preserves Cancel for a runner who is still missing from the snapshot", async () => {
    const ctx = await createTestEvent("evr-stay");
    try {
      await ctx.db.event.update({
        where: { id: ctx.eventId },
        data: { eventorEventId: BigInt(EVENTOR_EVENT_ID), eventorEnv: "test" },
      });

      const cls = await ctx.db.class.create({
        data: {
          eventId: ctx.eventId,
          name: "Stays Withdrawn",
          eventorId: BigInt(CLASS_BASE + 2),
        },
      });
      const runner = await ctx.db.runner.create({
        data: {
          eventId: ctx.eventId,
          name: "Stays Withdrawn Runner",
          cardNo: 700_003,
          classId: cls.id,
          status: "cancel",
          eventorPersonId: BigInt(PERSON_BASE + 2),
          entrySource: EVENTOR_EVENT_ID,
        },
      });

      vi.mocked(fetchEventClasses).mockResolvedValue([
        makeClass(CLASS_BASE + 2, "Stays Withdrawn"),
      ]);
      // Snapshot has no entries/results for this person — they're still gone.
      vi.mocked(fetchEntries).mockResolvedValue([]);
      vi.mocked(fetchResults).mockResolvedValue([]);

      const caller = makeCaller(ctx.event);
      await caller.eventor.sync();

      const after = await ctx.db.runner.findUnique({
        where: { id: runner.id },
        select: { status: true },
      });
      expect(after?.status).toBe("cancel");
    } finally {
      await ctx.cleanup();
    }
  });

  it("deals a variant to a new entry in a class on a forked course (F6b)", async () => {
    const ctx = await createTestEvent("evr-variants");
    try {
      await ctx.db.event.update({
        where: { id: ctx.eventId },
        data: { eventorEventId: BigInt(EVENTOR_EVENT_ID), eventorEnv: "test" },
      });
      const caller = makeCaller(ctx.event);
      const S = (await caller.control.create({ status: 4, xpos: 10, ypos: 10 })).id;
      const F = (await caller.control.create({ status: 5, xpos: 90, ypos: 10 })).id;
      const sites: number[] = [];
      for (const [code, x] of [[31, 20], [32, 30], [33, 40]] as const) {
        sites.push((await caller.control.create({ codes: String(code), xpos: x, ypos: 20 })).id);
      }
      const { id: root } = await caller.course.create({ name: "Forked" });
      await caller.course.setStructure({
        courseId: root,
        structure: {
          version: 1,
          id: "x",
          orderMode: "ordered",
          items: [
            { siteId: S },
            { siteId: sites[0] },
            {
              kind: "variation",
              id: "g",
              alternatives: [
                { label: "A", items: [{ siteId: sites[1] }] },
                { label: "B", items: [{ siteId: sites[2] }] },
              ],
            },
            { siteId: F },
          ],
        },
      });
      const { id: classSeq } = await caller.class.create({ name: "H21", courseId: root });
      await ctx.db.class.updateMany({ where: { eventId: ctx.eventId, seq: classSeq }, data: { eventorId: BigInt(CLASS_BASE) } });

      vi.mocked(fetchEventClasses).mockResolvedValue([makeClass(CLASS_BASE, "H21")]);
      vi.mocked(fetchEntries).mockResolvedValue([
        makeEntry(CLASS_BASE, PERSON_BASE + 10, "New One", 700_101, "H21"),
        makeEntry(CLASS_BASE, PERSON_BASE + 11, "New Two", 700_102, "H21"),
      ]);
      vi.mocked(fetchResults).mockResolvedValue([]);
      await caller.eventor.sync();

      const runners = await ctx.db.runner.findMany({
        where: { eventId: ctx.eventId, removed: false },
        select: { course: { select: { variantKey: true } } },
      });
      expect(runners.map((r) => r.course?.variantKey).sort()).toEqual(["A", "B"]);
    } finally {
      await ctx.cleanup();
    }
  });
});
