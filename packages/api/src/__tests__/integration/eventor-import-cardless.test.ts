/**
 * Regression test: Eventor import with cardless / duplicate-card runners.
 *
 * The `runners` table enforces one card per event via a partial unique
 * index on (event_id, card_no) WHERE removed = false, and uses NULL
 * (not 0) for "no card". The Eventor import used to write
 * `clampInt32(cardNo)` — i.e. `0` — for every runner without a card,
 * so the second cardless runner blew up the whole import with
 * "Unique constraint failed on the fields: (event_id, card_no)".
 *
 * Seen in the wild importing "Ungdomsserien, regionfinal SO" (youth
 * events have many runners without their own SI card).
 *
 * Eventor HTTP fetches are mocked at the module level; the test
 * exercises routers/eventor.ts against the real test DB.
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
  type EventorResult,
} from "../../eventor.js";
import { prisma, setSetting } from "../../db.js";
import { createTestEvent, disconnect } from "../helpers/test-db.js";
import { makeCaller } from "../helpers/caller.js";
import { eventorKeyStore } from "../../eventorKeyStore.js";

const EVENTOR_EVENT_ID = 99_100;
const CLASS_ID = 31_000;
const PERSON_BASE = 81_000;

beforeAll(async () => {
  await setSetting("eventor_api_key", "test-key");
  eventorKeyStore._resetForTests();
}, 30_000);

afterAll(async () => {
  await setSetting("eventor_api_key", null);
  eventorKeyStore._resetForTests();
  await disconnect();
}, 30_000);

function makeClass(classId: number, name: string): EventorEventClass {
  return {
    classId,
    name,
    shortName: name,
    sex: "M",
    lowAge: 0,
    highAge: 0,
    sequence: 1,
    classType: "",
    noTiming: false,
  };
}

function makeEntry(
  personId: number,
  personName: string,
  cardNo: number,
): EventorEntry {
  return {
    personName,
    personId,
    birthYear: 2012,
    sex: "M",
    nationality: "SWE",
    organisationId: 0,
    organisationName: "",
    organisationShortName: "",
    organisationCountry: "SWE",
    classId: CLASS_ID,
    className: "H14",
    cardNo,
    eventorEntryId: personId,
    entryDate: 0,
    entryTime: 0,
    fee: 0,
    paid: 0,
    taxable: 0,
    rankingScore: 0,
    noTiming: false,
  };
}

function makeResult(
  personId: number,
  personName: string,
  cardNo: number,
): EventorResult {
  return {
    personId,
    personName,
    birthYear: 2012,
    sex: "M",
    nationality: "SWE",
    organisationId: 0,
    organisationName: "",
    organisationShortName: "",
    organisationCountry: "SWE",
    classId: CLASS_ID,
    cardNo,
    startTime: 0,
    finishTime: 0,
    status: 0,
    startNo: 0,
    bib: "",
  };
}

async function importMockedEvent(label: string) {
  const caller = makeCaller();
  const res = await caller.eventor.importEvent({
    eventId: EVENTOR_EVENT_ID,
    eventName: `oxygen_test_evimport_${label}_${Date.now()}`,
    eventDate: "2026-08-11",
  });
  const cleanup = async () => {
    try {
      await prisma().event.delete({ where: { id: BigInt(res.eventId) } });
    } catch {
      // Already gone — fine.
    }
  };
  return { res, cleanup };
}

describe("eventor.importEvent card number handling", () => {
  it("imports multiple cardless runners as cardNo NULL without violating the unique index", async () => {
    vi.mocked(fetchEventClasses).mockResolvedValue([
      makeClass(CLASS_ID, "H14"),
    ]);
    vi.mocked(fetchEntries).mockResolvedValue([
      makeEntry(PERSON_BASE + 1, "Cardless One", 0),
      makeEntry(PERSON_BASE + 2, "Cardless Two", 0),
      makeEntry(PERSON_BASE + 3, "Carded Three", 812_345),
    ]);
    vi.mocked(fetchResults).mockResolvedValue([]);

    const { res, cleanup } = await importMockedEvent("cardless");
    try {
      expect(res.runnerCount).toBe(3);
      const runners = await prisma().runner.findMany({
        where: { eventId: BigInt(res.eventId) },
        select: { name: true, cardNo: true },
        orderBy: { name: "asc" },
      });
      expect(runners).toEqual([
        { name: "Carded Three", cardNo: 812_345 },
        { name: "Cardless One", cardNo: null },
        { name: "Cardless Two", cardNo: null },
      ]);
    } finally {
      await cleanup();
    }
  });

  it("keeps the first claim when two entries share the same card number", async () => {
    vi.mocked(fetchEventClasses).mockResolvedValue([
      makeClass(CLASS_ID, "H14"),
    ]);
    vi.mocked(fetchEntries).mockResolvedValue([
      makeEntry(PERSON_BASE + 11, "Shared First", 820_000),
      makeEntry(PERSON_BASE + 12, "Shared Second", 820_000),
    ]);
    vi.mocked(fetchResults).mockResolvedValue([]);

    const { res, cleanup } = await importMockedEvent("dupcard");
    try {
      expect(res.runnerCount).toBe(2);
      const runners = await prisma().runner.findMany({
        where: { eventId: BigInt(res.eventId) },
        select: { name: true, cardNo: true },
        orderBy: { name: "asc" },
      });
      expect(runners).toEqual([
        { name: "Shared First", cardNo: 820_000 },
        { name: "Shared Second", cardNo: null },
      ]);
    } finally {
      await cleanup();
    }
  });

  it("imports cardless results-only late entries as NULL too", async () => {
    vi.mocked(fetchEventClasses).mockResolvedValue([
      makeClass(CLASS_ID, "H14"),
    ]);
    vi.mocked(fetchEntries).mockResolvedValue([
      makeEntry(PERSON_BASE + 21, "Entry Cardless", 0),
    ]);
    vi.mocked(fetchResults).mockResolvedValue([
      makeResult(PERSON_BASE + 22, "Late Cardless", 0),
    ]);

    const { res, cleanup } = await importMockedEvent("lateentry");
    try {
      expect(res.runnerCount).toBe(2);
      const runners = await prisma().runner.findMany({
        where: { eventId: BigInt(res.eventId) },
        select: { cardNo: true },
      });
      expect(runners.map((r) => r.cardNo)).toEqual([null, null]);
    } finally {
      await cleanup();
    }
  });
});

describe("eventor.sync card number handling", () => {
  it("adds new cardless runners alongside an existing cardless runner", async () => {
    const ctx = await createTestEvent("evsync-cardless");
    try {
      await ctx.db.event.update({
        where: { id: ctx.eventId },
        data: { eventorEventId: BigInt(EVENTOR_EVENT_ID), eventorEnv: "prod" },
      });
      // Pre-existing cardless runner (as the fixed import would create).
      await ctx.db.runner.create({
        data: {
          eventId: ctx.eventId,
          name: "Already Here",
          cardNo: null,
          eventorPersonId: BigInt(PERSON_BASE + 31),
          entrySource: EVENTOR_EVENT_ID,
        },
      });

      vi.mocked(fetchEventClasses).mockResolvedValue([
        makeClass(CLASS_ID, "H14"),
      ]);
      vi.mocked(fetchEntries).mockResolvedValue([
        makeEntry(PERSON_BASE + 31, "Already Here", 0),
        makeEntry(PERSON_BASE + 32, "New Cardless A", 0),
        makeEntry(PERSON_BASE + 33, "New Cardless B", 0),
      ]);
      vi.mocked(fetchResults).mockResolvedValue([]);

      const caller = makeCaller(ctx.event);
      await caller.eventor.sync();

      const runners = await ctx.db.runner.findMany({
        where: { eventId: ctx.eventId },
        select: { name: true, cardNo: true },
        orderBy: { name: "asc" },
      });
      expect(runners).toEqual([
        { name: "Already Here", cardNo: null },
        { name: "New Cardless A", cardNo: null },
        { name: "New Cardless B", cardNo: null },
      ]);
    } finally {
      await ctx.cleanup();
    }
  });

  it("does not steal a card already held by another runner in the event", async () => {
    const ctx = await createTestEvent("evsync-dupcard");
    try {
      await ctx.db.event.update({
        where: { id: ctx.eventId },
        data: { eventorEventId: BigInt(EVENTOR_EVENT_ID), eventorEnv: "prod" },
      });
      // Locally-registered runner (no eventorPersonId) already holds the card.
      await ctx.db.runner.create({
        data: {
          eventId: ctx.eventId,
          name: "Local Holder",
          cardNo: 830_000,
        },
      });

      vi.mocked(fetchEventClasses).mockResolvedValue([
        makeClass(CLASS_ID, "H14"),
      ]);
      vi.mocked(fetchEntries).mockResolvedValue([
        makeEntry(PERSON_BASE + 41, "Eventor Claimer", 830_000),
      ]);
      vi.mocked(fetchResults).mockResolvedValue([]);

      const caller = makeCaller(ctx.event);
      await caller.eventor.sync();

      const runners = await ctx.db.runner.findMany({
        where: { eventId: ctx.eventId },
        select: { name: true, cardNo: true },
        orderBy: { name: "asc" },
      });
      expect(runners).toEqual([
        { name: "Eventor Claimer", cardNo: null },
        { name: "Local Holder", cardNo: 830_000 },
      ]);
    } finally {
      await ctx.cleanup();
    }
  });
});
