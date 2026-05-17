/**
 * Integration test for the Eventor re-entry status reset.
 *
 * Scenario: a runner was previously stamped Status=Cancel (21) by an
 * earlier sync that detected them as withdrawn. The next Eventor sync
 * snapshot has them back in entries (without a result yet). The sync
 * must reset Status to 0 (or 22 if entry.noTiming) so they show up
 * again as a regular pre-race entry.
 *
 * The Eventor HTTP fetches are mocked at the module level so the test
 * exercises only the routers/eventor.ts merge logic against a real DB.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

vi.mock("../../eventor.js", async () => {
  const actual =
    await vi.importActual<typeof import("../../eventor.js")>("../../eventor.js");
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
} from "../../eventor.js";
import { getSetting, setSetting } from "../../db.js";
import { createTestDb, type TestDbContext } from "../helpers/test-db.js";
import { makeCaller } from "../helpers/caller.js";
import { eventorKeyStore } from "../../eventorKeyStore.js";

let ctx: TestDbContext;
const EVENTOR_EVENT_ID = 99001;
const EVENTOR_CLASS_ID = 12345;
const EVENTOR_PERSON_ID = 67890;

// Snapshot the developer's real prod Eventor key so we can restore it.
// This file shares MeOSMain with the running dev stack, so writing a
// fake key without restoring would silently wipe the developer's
// credentials on every integration run. (Mirrors the pattern in
// registration-trends.test.ts.)
let savedEventorKey: string | null = null;

beforeAll(async () => {
  savedEventorKey = await getSetting("eventor_api_key");

  ctx = await createTestDb("eventor_reentry");

  // Stamp the test competition with an Eventor event ID so the sync
  // mutation will find it.
  await ctx.client.oEvent.updateMany({
    where: { Removed: false },
    data: { ExtId: BigInt(EVENTOR_EVENT_ID) },
  });

  // Configure a fake API key so requireApiKey() doesn't throw. The
  // store caches per-process; reset its in-memory state so the new
  // setting is read on the next call.
  await setSetting("eventor_api_key", "test-key");
  eventorKeyStore._resetForTests();
}, 60000);

afterAll(async () => {
  // Restore the snapshotted Eventor API key. `setSetting(..., null)`
  // deletes the row when the original was empty/absent. Reset the
  // in-memory keystore so the restored value is read next time.
  await setSetting("eventor_api_key", savedEventorKey);
  eventorKeyStore._resetForTests();
  await ctx.cleanup();
}, 30000);

describe("eventor.sync re-entry status reset", () => {
  it("resets a previously-cancelled runner back to Status=0 when they reappear in entries (no result)", async () => {
    // Arrange: a runner that was withdrawn last sync. They have ExtId
    // pointing at an Eventor person ID and Status=21 (Cancel).
    const cls = await ctx.client.oClass.create({
      data: {
        Name: "H21",
        Course: 0,
        FirstStart: 0,
        StartInterval: 0,
        SortIndex: 1,
        Removed: false,
        Counter: 0,
        FreeStart: 0,
        ExtId: BigInt(EVENTOR_CLASS_ID),
      },
    });

    const runner = await ctx.client.oRunner.create({
      data: {
        Name: "Reinstated Runner",
        CardNo: 700001,
        Class: cls.Id,
        Club: 0,
        Status: 21, // Cancel — set by a prior withdrawn-detection sync
        ExtId: BigInt(EVENTOR_PERSON_ID),
        EntrySource: EVENTOR_EVENT_ID,
        Removed: false,
        Counter: 0,
      },
    });

    // Mock Eventor responses: classes unchanged, entries contain the
    // runner again (no result yet).
    vi.mocked(fetchEventClasses).mockResolvedValue([
      {
        classId: EVENTOR_CLASS_ID,
        name: "H21",
        shortName: "H21",
        sex: "M",
        lowAge: 0,
        highAge: 0,
        sequence: 1,
        classType: "",
        noTiming: false,
      },
    ]);
    vi.mocked(fetchEntries).mockResolvedValue([
      {
        personName: "Reinstated Runner",
        personId: EVENTOR_PERSON_ID,
        birthYear: 1990,
        sex: "M",
        nationality: "SWE",
        organisationId: 0,
        organisationName: "",
        organisationShortName: "",
        organisationCountry: "SWE",
        classId: EVENTOR_CLASS_ID,
        className: "H21",
        cardNo: 700001,
        eventorEntryId: 1,
        entryDate: 0,
        entryTime: 0,
        fee: 0,
        paid: 0,
        taxable: 0,
        rankingScore: 0,
        noTiming: false,
      },
    ]);
    vi.mocked(fetchResults).mockResolvedValue([]);

    // Act: run the sync mutation.
    const caller = makeCaller({ dbName: ctx.dbName });
    await caller.eventor.sync();

    // Assert: the runner's status was reset back to 0.
    const updated = await ctx.client.oRunner.findUnique({
      where: { Id: runner.Id },
    });
    expect(updated?.Status).toBe(0);
  });

  it("uses NoTiming (22) when the entry's class is no-timing", async () => {
    const cls = await ctx.client.oClass.create({
      data: {
        Name: "Open No-Timing",
        Course: 0,
        FirstStart: 0,
        StartInterval: 0,
        SortIndex: 2,
        Removed: false,
        Counter: 0,
        FreeStart: 0,
        ExtId: BigInt(EVENTOR_CLASS_ID + 1),
        NoTiming: 1,
      },
    });

    const runner = await ctx.client.oRunner.create({
      data: {
        Name: "Reinstated NoTiming",
        CardNo: 700002,
        Class: cls.Id,
        Club: 0,
        Status: 21,
        ExtId: BigInt(EVENTOR_PERSON_ID + 1),
        EntrySource: EVENTOR_EVENT_ID,
        Removed: false,
        Counter: 0,
      },
    });

    vi.mocked(fetchEventClasses).mockResolvedValue([
      {
        classId: EVENTOR_CLASS_ID + 1,
        name: "Open No-Timing",
        shortName: "OnT",
        sex: "B",
        lowAge: 0,
        highAge: 0,
        sequence: 1,
        classType: "",
        noTiming: true,
      },
    ]);
    vi.mocked(fetchEntries).mockResolvedValue([
      {
        personName: "Reinstated NoTiming",
        personId: EVENTOR_PERSON_ID + 1,
        birthYear: 1990,
        sex: "M",
        nationality: "SWE",
        organisationId: 0,
        organisationName: "",
        organisationShortName: "",
        organisationCountry: "SWE",
        classId: EVENTOR_CLASS_ID + 1,
        className: "Open No-Timing",
        cardNo: 700002,
        eventorEntryId: 2,
        entryDate: 0,
        entryTime: 0,
        fee: 0,
        paid: 0,
        taxable: 0,
        rankingScore: 0,
        noTiming: true,
      },
    ]);
    vi.mocked(fetchResults).mockResolvedValue([]);

    const caller = makeCaller({ dbName: ctx.dbName });
    await caller.eventor.sync();

    const updated = await ctx.client.oRunner.findUnique({
      where: { Id: runner.Id },
    });
    expect(updated?.Status).toBe(22);
  });

  it("preserves Cancel for a runner who is still missing from the snapshot", async () => {
    const cls = await ctx.client.oClass.create({
      data: {
        Name: "Stays Withdrawn",
        Course: 0,
        FirstStart: 0,
        StartInterval: 0,
        SortIndex: 3,
        Removed: false,
        Counter: 0,
        FreeStart: 0,
        ExtId: BigInt(EVENTOR_CLASS_ID + 2),
      },
    });

    const runner = await ctx.client.oRunner.create({
      data: {
        Name: "Stays Withdrawn Runner",
        CardNo: 700003,
        Class: cls.Id,
        Club: 0,
        Status: 21,
        ExtId: BigInt(EVENTOR_PERSON_ID + 2),
        EntrySource: EVENTOR_EVENT_ID,
        Removed: false,
        Counter: 0,
      },
    });

    vi.mocked(fetchEventClasses).mockResolvedValue([
      {
        classId: EVENTOR_CLASS_ID + 2,
        name: "Stays Withdrawn",
        shortName: "SW",
        sex: "M",
        lowAge: 0,
        highAge: 0,
        sequence: 1,
        classType: "",
        noTiming: false,
      },
    ]);
    // Snapshot has no entries / results for this person — they're still gone.
    vi.mocked(fetchEntries).mockResolvedValue([]);
    vi.mocked(fetchResults).mockResolvedValue([]);

    const caller = makeCaller({ dbName: ctx.dbName });
    await caller.eventor.sync();

    const updated = await ctx.client.oRunner.findUnique({
      where: { Id: runner.Id },
    });
    expect(updated?.Status).toBe(21);
  });
});
