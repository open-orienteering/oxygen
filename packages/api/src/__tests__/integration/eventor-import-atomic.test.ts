/**
 * Eventor import is all-or-nothing and stores the right values (review
 * package 5: RES-02, EVT-04, MC-13, EVT-09, EVT-11).
 *
 * Each header says what the import did BEFORE the fix
 * (docs/bugfixes/eventor-import-atomic.md). The Eventor fetches are mocked;
 * everything else runs against the real test database.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach, vi } from "vitest";

vi.mock("../../eventor.js", async () => {
  const actual = await vi.importActual<typeof import("../../eventor.js")>("../../eventor.js");
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
import { disconnect } from "../helpers/test-db.js";
import { makeCaller } from "../helpers/caller.js";
import { eventorKeyStore } from "../../eventorKeyStore.js";

const EVENTOR_EVENT_ID = 99_300;
const CLASS_ID = 61_000;
const P = 71_000;
let label = 0;

beforeAll(async () => {
  await setSetting("eventor_api_key_test", "test-key");
  eventorKeyStore._resetForTests();
}, 30_000);

afterAll(async () => {
  await setSetting("eventor_api_key_test", null);
  eventorKeyStore._resetForTests();
  await disconnect();
}, 30_000);

const createdNameIds: string[] = [];
beforeEach(() => {
  vi.mocked(fetchEventClasses).mockReset();
  vi.mocked(fetchEntries).mockReset();
  vi.mocked(fetchResults).mockReset();
});
afterEach(async () => {
  await prisma().event.deleteMany({ where: { nameId: { in: createdNameIds.splice(0) } } });
  await prisma().event.deleteMany({ where: { eventorEventId: BigInt(EVENTOR_EVENT_ID) } });
  await prisma().eventorEventMeta.deleteMany({ where: { eventorEventId: EVENTOR_EVENT_ID } });
});

const cls = (): EventorEventClass => ({
  classId: CLASS_ID, name: "H21", shortName: "H21", sex: "M", lowAge: 0, highAge: 0,
  sequence: 1, classType: "", noTiming: false,
});

function entry(personId: number, name: string, over: Partial<EventorEntry> = {}): EventorEntry {
  return {
    personName: name, personId, birthYear: 1990, sex: "M", nationality: "SWE",
    organisationId: 0, organisationName: "", organisationShortName: "", organisationCountry: "SWE",
    classId: CLASS_ID, className: "H21", cardNo: 0, eventorEntryId: personId,
    entryDate: 0, entryTime: 0, fee: 0, paid: 0, taxable: 0, rankingScore: 0, noTiming: false,
    ...over,
  };
}

function result(personId: number, over: Partial<EventorResult> = {}): EventorResult {
  return {
    personId, personName: `Result ${personId}`, birthYear: 1990, sex: "M", nationality: "SWE",
    organisationId: 0, organisationName: "", organisationShortName: "", organisationCountry: "SWE",
    classId: CLASS_ID, cardNo: 0, startTime: 0, finishTime: 0, status: 0, bib: "",
    ...over,
  };
}

function mockEventor(entries: EventorEntry[], results: EventorResult[] = []) {
  vi.mocked(fetchEventClasses).mockResolvedValue([cls()]);
  vi.mocked(fetchEntries).mockResolvedValue(entries);
  vi.mocked(fetchResults).mockResolvedValue(results);
}

function importAs(name: string, eventDate = "2026-08-11") {
  return makeCaller().eventor.importEvent({
    eventId: EVENTOR_EVENT_ID,
    eventName: name,
    eventDate,
    classificationId: 3,
    env: "test",
  });
}

const uniqueName = (what: string) => `oxygen_test_import_${what}_${Date.now()}_${label++}`;

describe("eventor.importEvent", () => {
  it("RES-02 / EVT-04: stores times ZeroTime-relative and no start number (was: absolute times, the finishing place as start number)", async () => {
    mockEventor(
      [entry(P + 1, "Runner One", { cardNo: 200_001 })],
      [result(P + 1, { startTime: 360000, finishTime: 372500, status: 1, bib: "H4", cardNo: 200_001 })],
    );
    const name = uniqueName("times");
    const res = await importAs(name);
    createdNameIds.push(res.nameId);

    const event = await prisma().event.findUniqueOrThrow({ where: { id: BigInt(res.eventId) } });
    const r = await prisma().runner.findFirstOrThrow({ where: { eventId: event.id } });
    expect(r.startTime).toBe(360000 - event.zeroTime);
    expect(r.finishTime).toBe(372500 - event.zeroTime);
    expect(r.startNo).toBe(0);
    expect(r.bib).toBe("H4");
    expect(r.status).toBe("ok");

    // Read back through the API: a 10:00 start reads as 10:00 (was 19:00).
    const caller = makeCaller({
      id: event.id, nameId: event.nameId, zeroTime: event.zeroTime, date: event.date, kioskKey: event.kioskKey,
    });
    const [listed] = await caller.runner.list();
    expect(listed.startTime).toBe(360000);
    expect(listed.finishTime).toBe(372500);
  });

  it("writes classes and runners with a snapshot, and runner seqs 1..n from the trigger", async () => {
    mockEventor([entry(P + 1, "A"), entry(P + 2, "B"), entry(P + 3, "C")]);
    const res = await importAs(uniqueName("seq"));
    createdNameIds.push(res.nameId);
    expect(res).toMatchObject({ classCount: 1, runnerCount: 3 });
    const runners = await prisma().runner.findMany({
      where: { eventId: BigInt(res.eventId) },
      orderBy: { seq: "asc" },
    });
    expect(runners.map((r) => r.seq)).toEqual([1, 2, 3]);
    expect(runners[0].eventorSnapshot).toMatchObject({ name: "A", class_eventor_id: CLASS_ID, present: true });
    const c = await prisma().class.findFirstOrThrow({ where: { eventId: BigInt(res.eventId) } });
    expect(c.eventorSnapshot).toMatchObject({ name: "H21", no_timing: false });
  });

  it("MC-13: a failure at runner N leaves no event behind (was: a half-imported event that blocked the retry)", async () => {
    // A birth year outside SMALLINT fails the insert of the third runner.
    mockEventor([entry(P + 1, "A"), entry(P + 2, "B"), entry(P + 3, "Bad", { birthYear: 999_999 })]);
    const name = uniqueName("atomic");
    await expect(importAs(name)).rejects.toThrow();
    const slug = name.replace(/[^a-zA-Z0-9_-]/g, "_");
    expect(await prisma().event.count({ where: { nameId: slug } })).toBe(0);
    expect(await prisma().event.count({ where: { eventorEventId: BigInt(EVENTOR_EVENT_ID) } })).toBe(0);

    // The retry with sound data works under the same name.
    mockEventor([entry(P + 1, "A"), entry(P + 2, "B")]);
    const res = await importAs(name);
    createdNameIds.push(res.nameId);
    expect(res.nameId).toBe(slug);
    expect(res.runnerCount).toBe(2);
  });

  it("MC-13 / EVT-11: import, soft-delete, re-import succeeds under a year-suffixed slug (was: raw unique violation)", async () => {
    mockEventor([entry(P + 1, "A")]);
    const name = uniqueName("reimport");
    const first = await importAs(name);
    createdNameIds.push(first.nameId);
    await prisma().event.update({ where: { id: BigInt(first.eventId) }, data: { removed: true } });

    const second = await importAs(name);
    createdNameIds.push(second.nameId);
    expect(second.nameId).toBe(`${first.nameId}-2026`);
    expect(second.eventId).not.toBe(first.eventId);
  });

  it("MC-13: the same Eventor event twice is a CONFLICT before anything is fetched", async () => {
    mockEventor([entry(P + 1, "A")]);
    const first = await importAs(uniqueName("dup1"));
    createdNameIds.push(first.nameId);

    vi.mocked(fetchEventClasses).mockClear();
    vi.mocked(fetchEntries).mockClear();
    vi.mocked(fetchResults).mockClear();
    await expect(importAs(uniqueName("dup2"))).rejects.toMatchObject({ code: "CONFLICT" });
    expect(fetchEventClasses).not.toHaveBeenCalled();
    expect(fetchEntries).not.toHaveBeenCalled();
    expect(fetchResults).not.toHaveBeenCalled();
  });

  it("EVT-09: a duplicate person and a duplicate card do not abort the import", async () => {
    mockEventor([
      entry(P + 1, "Shared Card One", { cardNo: 300_001 }),
      entry(P + 2, "Shared Card Two", { cardNo: 300_001, eventorEntryId: P + 22 }),
      entry(P + 1, "Entered Twice", { cardNo: 300_009, eventorEntryId: P + 99 }),
    ]);
    const res = await importAs(uniqueName("dups"));
    createdNameIds.push(res.nameId);
    expect(res.runnerCount).toBe(2);
    const rows = await prisma().runner.findMany({
      where: { eventId: BigInt(res.eventId) },
      orderBy: { name: "asc" },
      select: { name: true, cardNo: true },
    });
    expect(rows).toEqual([
      { name: "Shared Card One", cardNo: 300_001 },
      { name: "Shared Card Two", cardNo: null },
    ]);
  });
});

describe("eventor.importEvent: times of any hour (RES-02)", () => {
  const timed = (personId: number, start: number, finish: number) =>
    result(personId, { startTime: start, finishTime: finish, status: 1 });

  async function readBack(res: { eventId: number; nameId: string }) {
    const event = await prisma().event.findUniqueOrThrow({ where: { id: BigInt(res.eventId) } });
    const caller = makeCaller({
      id: event.id, nameId: event.nameId, zeroTime: event.zeroTime, date: event.date, kioskKey: event.kioskKey,
    });
    return { event, list: await caller.runner.list() };
  }

  it("an early start (before the 09:00 default) reads back as it was (was: negative relative time)", async () => {
    mockEventor([entry(P + 1, "Early")], [timed(P + 1, 270000, 285000)]); // 07:30 - 07:55
    const res = await importAs(uniqueName("early"));
    createdNameIds.push(res.nameId);
    const { event, list } = await readBack(res);
    expect(event.zeroTime).toBe(216000); // 06:00: the hour of the earliest start (07:30), minus one
    expect(list[0].startTime).toBe(270000);
    expect(list[0].finishTime).toBe(285000);
  });

  it("a start exactly at the default ZeroTime is not 'no time' (was: stored as 0)", async () => {
    mockEventor([entry(P + 1, "Nine")], [timed(P + 1, 324000, 340000)]);
    const res = await importAs(uniqueName("nine"));
    createdNameIds.push(res.nameId);
    const { list } = await readBack(res);
    expect(list[0].startTime).toBe(324000);
    const row = await prisma().runner.findFirstOrThrow({ where: { eventId: BigInt(res.eventId) } });
    expect(row.startTime).toBeGreaterThan(0);
  });

  it("a finish after midnight reads back and stays after the start", async () => {
    mockEventor([entry(P + 1, "Night")], [timed(P + 1, 828000, 18000)]); // 23:00 - 00:30
    const res = await importAs(uniqueName("night"));
    createdNameIds.push(res.nameId);
    const { list } = await readBack(res);
    expect(list[0].startTime).toBe(828000);
    expect(list[0].finishTime).toBe(18000);
    const row = await prisma().runner.findFirstOrThrow({ where: { eventId: BigInt(res.eventId) } });
    expect(row.finishTime).toBeGreaterThan(row.startTime);
  });

  it("an entry without a person id is imported (was: dropped)", async () => {
    mockEventor([entry(0, "No Person Id", { eventorEntryId: 123_456 })]);
    const res = await importAs(uniqueName("nopid"));
    createdNameIds.push(res.nameId);
    expect(res.runnerCount).toBe(1);
    const row = await prisma().runner.findFirstOrThrow({ where: { eventId: BigInt(res.eventId) } });
    expect(row).toMatchObject({ eventorPersonId: null, eventorEntryId: 123_456n });
  });
});

describe("event.create", () => {
  it("EVT-11: a name only a deleted event holds gets a year suffix (was: raw unique violation)", async () => {
    const name = uniqueName("create");
    const caller = makeCaller();
    const first = await caller.event.create({ name, date: "2026-05-01", kind: "competition" });
    createdNameIds.push(first.nameId);
    await prisma().event.update({ where: { id: BigInt(first.eventId) }, data: { removed: true } });
    const second = await caller.event.create({ name, date: "2026-05-01", kind: "competition" });
    createdNameIds.push(second.nameId);
    expect(second.nameId).toBe(`${first.nameId}-2026`);
    // A slug a live event holds still gives CONFLICT.
    await expect(
      caller.event.create({ name, nameId: second.nameId, date: "2026-05-01", kind: "competition" }),
    ).rejects.toMatchObject({
      code: "CONFLICT",
    });
  });
});
