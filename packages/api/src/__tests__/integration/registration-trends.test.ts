/**
 * Integration tests for the registrationTrends router.
 *
 * Covers:
 *   1. ownTimeline returns one entry per dated runner (manual + Eventor),
 *      with the right isManual flag.
 *   2. The cache table accepts inserts and reads (unit-level test of the
 *      MeOSMain DDL — the actual fetchComparison procedure is exercised
 *      below with a mocked Eventor client).
 *   3. fetchComparison hits Eventor exactly once per event id, then serves
 *      subsequent reads from the cache for past events.
 */

import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from "vitest";
import { createTestDb, type TestDbContext } from "../helpers/test-db.js";
import { makeCaller } from "../helpers/caller.js";
import {
  ensureEventorEntryHistoryTable,
  getMainDbConnection,
  getSetting,
  setSetting,
} from "../../db.js";
import { eventorKeyStore } from "../../eventorKeyStore.js";

let ctx: TestDbContext;
// Snapshot the developer's real prod Eventor key so we can restore it.
// This module shares MeOSMain with the running dev stack, so writing a
// fake key without restoring would silently wipe the developer's
// credentials on every `pnpm test:integration` run.
let savedEventorKey: string | null = null;

beforeAll(async () => {
  savedEventorKey = await getSetting("eventor_api_key");
  ctx = await createTestDb("trends");
}, 60000);

afterAll(async () => {
  // Restore the snapshotted Eventor API key. Use `setSetting(..., null)`
  // to delete the row when the original was empty/absent.
  await setSetting("eventor_api_key", savedEventorKey);
  eventorKeyStore._resetForTests();

  // Clean up cache rows we inserted so we don't leak across runs
  const conn = await getMainDbConnection();
  try {
    await conn.execute(
      "DELETE FROM oxygen_eventor_event_meta WHERE EventorEventId IN (777001, 777002, 777003, 777004, 777005)",
    );
    await conn.execute(
      "DELETE FROM oxygen_eventor_entry_history WHERE EventorEventId IN (777001, 777002, 777003, 777004, 777005)",
    );
  } finally {
    await conn.end();
  }
  await ctx.cleanup();
}, 30000);

async function seedClass(client: TestDbContext["client"], name = "H21") {
  return client.oClass.create({
    data: {
      Name: name,
      Course: 0,
      FirstStart: 0,
      StartInterval: 0,
      SortIndex: 1,
      Removed: false,
      Counter: 0,
      FreeStart: 0,
    },
  });
}

// ─── ownTimeline ────────────────────────────────────────────

describe("registrationTrends.ownTimeline", () => {
  it("returns dated runners as ISO timestamps with isManual flag", async () => {
    const cls = await seedClass(ctx.client, "DamH21");
    const caller = makeCaller({ dbName: ctx.dbName });

    // Manual create — should auto-stamp EntryDate/EntryTime to now and
    // appear with isManual=true.
    await caller.runner.create({ name: "Manual Runner", classId: cls.Id });

    // Eventor-style row inserted directly with EntrySource > 0 and a
    // historical entry timestamp.
    await ctx.client.oRunner.create({
      data: {
        Name: "Synced Runner",
        Class: cls.Id,
        EntrySource: 12345,
        EntryDate: 20260201,
        EntryTime: 360000, // 10:00:00
        InputResult: "",
        Annotation: "",
      },
    });

    // Runner without an EntryDate (legacy import) — should NOT appear in
    // the entries array.
    await ctx.client.oRunner.create({
      data: {
        Name: "Undated Runner",
        Class: cls.Id,
        EntryDate: 0,
        EntryTime: 0,
        InputResult: "",
        Annotation: "",
      },
    });

    const result = await caller.registrationTrends.ownTimeline();
    expect(result.entries.length).toBeGreaterThanOrEqual(2);

    const manual = result.entries.find((e) =>
      e.classId === cls.Id && e.isManual,
    );
    const synced = result.entries.find((e) =>
      e.classId === cls.Id && !e.isManual,
    );
    expect(manual).toBeDefined();
    expect(synced).toBeDefined();
    // Synced runner has a fixed historical timestamp; verify it parses
    expect(new Date(synced!.at).getFullYear()).toBe(2026);
    expect(new Date(synced!.at).getMonth()).toBe(1); // Feb (0-indexed)
  });

  it("exposes the class list and event metadata", async () => {
    const caller = makeCaller({ dbName: ctx.dbName });
    const result = await caller.registrationTrends.ownTimeline();
    expect(result.event.name).toMatch(/Test Competition/);
    expect(result.classes.length).toBeGreaterThan(0);
  });
});

// ─── Cache table DDL ────────────────────────────────────────

describe("oxygen_eventor_entry_history cache", () => {
  it("creates the schema and accepts upserts", async () => {
    const conn = await getMainDbConnection();
    try {
      await ensureEventorEntryHistoryTable(conn);
      // Insert
      await conn.execute(
        `INSERT INTO oxygen_eventor_event_meta
         (EventorEventId, Name, StartDate, ClassificationId, Organiser, EntryCount, FetchedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE Name = VALUES(Name), EntryCount = VALUES(EntryCount), FetchedAt = VALUES(FetchedAt)`,
        [777001, "Test Cache Event", "2026-04-12", 2, "Test Organisers", 3, new Date()],
      );
      await conn.execute(
        `INSERT INTO oxygen_eventor_entry_history
         (EventorEventId, RowSeq, EntryClassId, EntryAt) VALUES
         (?, ?, ?, ?), (?, ?, ?, ?), (?, ?, ?, ?)`,
        [
          777001, 0, 100, new Date(2026, 3, 1, 10, 0, 0),
          777001, 1, 100, new Date(2026, 3, 5, 14, 30, 0),
          777001, 2, 101, new Date(2026, 3, 11, 23, 15, 0),
        ],
      );

      // Read back
      const [rows] = await conn.execute(
        `SELECT COUNT(*) as cnt FROM oxygen_eventor_entry_history WHERE EventorEventId = ?`,
        [777001],
      );
      expect((rows as { cnt: number }[])[0].cnt).toBe(3);
    } finally {
      await conn.end();
    }
  });
});

// ─── fetchComparison with mocked Eventor ────────────────────

vi.mock("../../eventor.js", async () => {
  const actual = await vi.importActual<typeof import("../../eventor.js")>(
    "../../eventor.js",
  );
  return {
    ...actual,
    fetchEntries: vi.fn(),
    fetchEventsBroad: vi.fn(),
    fetchEventMeta: vi.fn(),
    validateApiKey: vi.fn().mockResolvedValue({
      id: 12345,
      name: "Test Organisation",
    }),
  };
});

import { fetchEntries, fetchEventsBroad } from "../../eventor.js";

// Use the same placeholder string the e2e suite uses for `validateKey`
// fixtures. The e2e snapshot logic recognises it as test-pollution so
// even if the afterAll restore is skipped (e.g. interrupted run), the
// next e2e setup won't capture this value as if it were a real key.
const FAKE_API_KEY = "df34af90a0c64ca4abfe9492be057e9c";

describe("registrationTrends.fetchComparison", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    // Plant a fake API key directly in MeOSMain.oxygen_settings, then
    // reset the in-memory keystore so the next call reloads from DB.
    await setSetting("eventor_api_key", FAKE_API_KEY);
    eventorKeyStore._resetForTests();
  });

  it("fetches once on cache miss, then serves from cache for past events", async () => {
    const eventId = 777002;

    vi.mocked(fetchEntries).mockResolvedValue([
      makeFakeEntry({ entryDate: 20260101, entryTime: 360000, classId: 1 }),
      makeFakeEntry({ entryDate: 20260105, entryTime: 360000, classId: 1 }),
      makeFakeEntry({ entryDate: 20260110, entryTime: 360000, classId: 2 }),
    ]);

    const caller = makeCaller({ dbName: ctx.dbName });

    const r1 = await caller.registrationTrends.fetchComparison({
      eventIds: [eventId],
      eventMeta: [
        { id: eventId, startDate: "2026-01-15", name: "Past Event" },
      ],
    });
    expect(fetchEntries).toHaveBeenCalledTimes(1);
    expect(r1.events).toHaveLength(1);
    expect(r1.events[0].entries.length).toBe(3);
    expect(r1.events[0].fromCache).toBe(false);

    // Second call → past event, cached → no extra fetch
    vi.mocked(fetchEntries).mockClear();
    const r2 = await caller.registrationTrends.fetchComparison({
      eventIds: [eventId],
      eventMeta: [
        { id: eventId, startDate: "2026-01-15", name: "Past Event" },
      ],
    });
    expect(fetchEntries).not.toHaveBeenCalled();
    expect(r2.events[0].fromCache).toBe(true);
    expect(r2.events[0].entries.length).toBe(3);
  });

  it("force=true bypasses the cache", async () => {
    const eventId = 777003;

    vi.mocked(fetchEntries).mockResolvedValue([
      makeFakeEntry({ entryDate: 20260301, entryTime: 100000, classId: 5 }),
    ]);

    const caller = makeCaller({ dbName: ctx.dbName });
    await caller.registrationTrends.fetchComparison({
      eventIds: [eventId],
      eventMeta: [
        { id: eventId, startDate: "2026-03-15", name: "Bypass Test" },
      ],
    });
    expect(fetchEntries).toHaveBeenCalledTimes(1);

    vi.mocked(fetchEntries).mockClear();
    await caller.registrationTrends.fetchComparison({
      eventIds: [eventId],
      eventMeta: [
        { id: eventId, startDate: "2026-03-15", name: "Bypass Test" },
      ],
      force: true,
    });
    expect(fetchEntries).toHaveBeenCalledTimes(1);
  });

  it("treats legacy cache rows (empty Name) as a miss", async () => {
    const eventId = 777005;

    // Plant a "legacy" cache row directly: empty Name, bogus startDate
    // (= what the old buggy writeCache stored before eventMeta existed).
    const conn = await getMainDbConnection();
    try {
      await conn.execute(
        `INSERT INTO oxygen_eventor_event_meta
           (EventorEventId, Name, StartDate, ClassificationId, Organiser, EntryCount, FetchedAt)
         VALUES (?, '', '2026-01-15', 0, '', 1, NOW())`,
        [eventId],
      );
      await conn.execute(
        `INSERT INTO oxygen_eventor_entry_history
           (EventorEventId, RowSeq, EntryClassId, EntryAt) VALUES (?, 0, 1, NOW())`,
        [eventId],
      );
    } finally {
      await conn.end();
    }

    vi.mocked(fetchEntries).mockResolvedValue([
      makeFakeEntry({ entryDate: 20260301, entryTime: 100000, classId: 1 }),
    ]);

    const caller = makeCaller({ dbName: ctx.dbName });
    const r = await caller.registrationTrends.fetchComparison({
      eventIds: [eventId],
      eventMeta: [
        { id: eventId, startDate: "2026-04-15", name: "Now With Real Date" },
      ],
    });
    // Legacy row should have been treated as a miss → fetchEntries called.
    expect(fetchEntries).toHaveBeenCalledTimes(1);
    expect(r.events[0].fromCache).toBe(false);
    expect(r.events[0].meta?.name).toBe("Now With Real Date");
    expect(r.events[0].meta?.startDate).toBe("2026-04-15");

    // Cleanup
    const cleanupConn = await getMainDbConnection();
    try {
      await cleanupConn.execute(
        "DELETE FROM oxygen_eventor_event_meta WHERE EventorEventId = ?",
        [eventId],
      );
      await cleanupConn.execute(
        "DELETE FROM oxygen_eventor_entry_history WHERE EventorEventId = ?",
        [eventId],
      );
    } finally {
      await cleanupConn.end();
    }
  });

  it("stores the caller-provided race date, not the first entry timestamp", async () => {
    const eventId = 777004;
    const realRaceDate = "2026-05-16";

    vi.mocked(fetchEntries).mockResolvedValue([
      // First entry is months before the race
      makeFakeEntry({ entryDate: 20260201, entryTime: 360000, classId: 1 }),
      makeFakeEntry({ entryDate: 20260415, entryTime: 360000, classId: 1 }),
    ]);

    const caller = makeCaller({ dbName: ctx.dbName });
    const r = await caller.registrationTrends.fetchComparison({
      eventIds: [eventId],
      eventMeta: [
        {
          id: eventId,
          startDate: realRaceDate,
          name: "Spring National",
          organiserName: "Some Club",
        },
      ],
    });
    expect(r.events[0].meta?.startDate).toBe(realRaceDate);
    expect(r.events[0].meta?.name).toBe("Spring National");
    expect(r.events[0].meta?.organiser).toBe("Some Club");

    // Also ensure the cleanup `afterAll` removes this row.
    const conn = await getMainDbConnection();
    try {
      await conn.execute(
        "DELETE FROM oxygen_eventor_event_meta WHERE EventorEventId = ?",
        [eventId],
      );
      await conn.execute(
        "DELETE FROM oxygen_eventor_entry_history WHERE EventorEventId = ?",
        [eventId],
      );
    } finally {
      await conn.end();
    }
  });

  it("findComparableEvents excludes the linked own event", async () => {
    vi.mocked(fetchEventsBroad).mockResolvedValue([
      {
        eventId: 88888,
        name: "Other Race",
        date: "2026-01-15",
        classification: "National",
        classificationId: 2,
        organiserName: "Some Club",
        organiserId: 1,
      },
    ]);

    const caller = makeCaller({ dbName: ctx.dbName });
    const r = await caller.registrationTrends.findComparableEvents({});
    expect(fetchEventsBroad).toHaveBeenCalled();
    expect(r.events.find((e) => e.id === 88888)).toBeDefined();
    // No organisationIds passed by default — we want events from any club
    // in the date range, not just the user's own organisation.
    const args = vi.mocked(fetchEventsBroad).mock.calls[0];
    expect(args[1].organisationIds).toBeUndefined();
  });

  it("findComparableEvents surfaces auth errors as a clear message", async () => {
    const { EventorAuthError } = await import("../../eventor.js");
    vi.mocked(fetchEventsBroad).mockRejectedValue(new EventorAuthError());

    const caller = makeCaller({ dbName: ctx.dbName });
    await expect(
      caller.registrationTrends.findComparableEvents({}),
    ).rejects.toThrow(/Eventor refused/);
  });
});

// ─── lookupEventorEvent ─────────────────────────────────────

describe("registrationTrends.lookupEventorEvent", () => {
  it("parses bare event IDs", async () => {
    const { parseEventorEventId } = await import(
      "../../routers/registrationTrends.js"
    );
    expect(parseEventorEventId("12345")).toBe(12345);
    expect(parseEventorEventId("  98765  ")).toBe(98765);
  });

  it("parses full Eventor URLs", async () => {
    const { parseEventorEventId } = await import(
      "../../routers/registrationTrends.js"
    );
    expect(
      parseEventorEventId("https://eventor.orientering.se/Events/Show/12345/"),
    ).toBe(12345);
    expect(
      parseEventorEventId(
        "https://eventor-sweden-test.orientering.se/Events/Show/98765",
      ),
    ).toBe(98765);
  });

  it("rejects junk input", async () => {
    const { parseEventorEventId } = await import(
      "../../routers/registrationTrends.js"
    );
    expect(parseEventorEventId("")).toBeNull();
    expect(parseEventorEventId("not a url")).toBeNull();
    expect(parseEventorEventId("0")).toBeNull();
  });
});

// ─── Helper ─────────────────────────────────────────────────

function makeFakeEntry(
  overrides: Partial<import("../../eventor.js").EventorEntry> = {},
): import("../../eventor.js").EventorEntry {
  return {
    personName: "Test Person",
    personId: 0,
    birthYear: 0,
    sex: "",
    nationality: "",
    organisationId: 0,
    organisationName: "",
    organisationShortName: "",
    organisationCountry: "",
    classId: 0,
    className: "",
    cardNo: 0,
    eventorEntryId: 0,
    entryDate: 20260101,
    entryTime: 100000,
    fee: 0,
    paid: 0,
    taxable: 0,
    rankingScore: 0,
    noTiming: false,
    ...overrides,
  };
}
