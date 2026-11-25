/**
 * Eventor re-sync must not undo the desk's work (review package 5).
 *
 * One `it` per finding. Each header says what the code did BEFORE the fix, so
 * this file doubles as the record of why the sync was rewritten
 * (docs/bugfixes/eventor-resync-data-loss.md, docs/system/eventor-sync.md).
 *
 * The Eventor HTTP fetches are mocked at module level; the merge logic runs
 * against the real test database. Runners are created by a first real sync, so
 * they carry the snapshot a production runner carries.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

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
import { setSetting } from "../../db.js";
import { createTestEvent, disconnect, type TestEventContext } from "../helpers/test-db.js";
import { makeCaller } from "../helpers/caller.js";
import { eventorKeyStore } from "../../eventorKeyStore.js";
import { lockEventLeaseAndSync } from "../../event-locks.js";
import { acquireLease } from "../../sync/lease.js";
import { prisma } from "../../db.js";

const EVENTOR_EVENT_ID = 99_201;
const CLASS_A = 41_001;
const CLASS_B = 41_002;
const P = 51_000;

beforeAll(async () => {
  await setSetting("eventor_api_key_test", "test-key");
  eventorKeyStore._resetForTests();
}, 30_000);

afterAll(async () => {
  await setSetting("eventor_api_key_test", null);
  eventorKeyStore._resetForTests();
  await disconnect();
}, 30_000);

function cls(classId: number, name: string, noTiming = false): EventorEventClass {
  return { classId, name, shortName: name, sex: "M", lowAge: 0, highAge: 0, sequence: 1, classType: "", noTiming };
}

function entry(personId: number, name: string, over: Partial<EventorEntry> = {}): EventorEntry {
  return {
    personName: name, personId, birthYear: 1990, sex: "M", nationality: "SWE",
    organisationId: 0, organisationName: "", organisationShortName: "", organisationCountry: "SWE",
    classId: CLASS_A, className: "H21", cardNo: 0, eventorEntryId: personId,
    entryDate: 0, entryTime: 0, fee: 0, paid: 0, taxable: 0, rankingScore: 0, noTiming: false,
    ...over,
  };
}

function result(personId: number, over: Partial<EventorResult> = {}): EventorResult {
  return {
    personId, personName: `Result ${personId}`, birthYear: 1990, sex: "M", nationality: "SWE",
    organisationId: 0, organisationName: "", organisationShortName: "", organisationCountry: "SWE",
    classId: CLASS_A, cardNo: 0, startTime: 0, finishTime: 0, status: 0, bib: "",
    ...over,
  };
}

function mockEventor(opts: {
  classes?: EventorEventClass[];
  entries?: EventorEntry[];
  results?: EventorResult[];
}) {
  vi.mocked(fetchEventClasses).mockResolvedValue(opts.classes ?? [cls(CLASS_A, "H21"), cls(CLASS_B, "H35")]);
  vi.mocked(fetchEntries).mockResolvedValue(opts.entries ?? []);
  vi.mocked(fetchResults).mockResolvedValue(opts.results ?? []);
}

async function withEvent(label: string, fn: (ctx: TestEventContext) => Promise<void>) {
  const ctx = await createTestEvent(label);
  try {
    await ctx.db.event.update({
      where: { id: ctx.eventId },
      data: { eventorEventId: BigInt(EVENTOR_EVENT_ID), eventorEnv: "test" },
    });
    await fn(ctx);
  } finally {
    await ctx.cleanup();
  }
}

const runnerOf = (ctx: TestEventContext, personId: number) =>
  ctx.db.runner.findFirstOrThrow({ where: { eventId: ctx.eventId, eventorPersonId: BigInt(personId) } });

describe("eventor.sync keeps what the desk did", () => {
  it("EVT-01: a finished runner missing from the entry list keeps her status (was: cancelled)", async () => {
    await withEvent("evt01", async (ctx) => {
      const caller = makeCaller(ctx.event);
      mockEventor({ entries: [entry(P + 1, "Finished Runner"), entry(P + 2, "Other Runner")] });
      await caller.eventor.sync();
      // The club swaps the entry; she still runs and is read out OK.
      await ctx.db.runner.updateMany({
        where: { eventId: ctx.eventId, eventorPersonId: BigInt(P + 1) },
        data: { status: "ok", finishTime: 36000 },
      });
      mockEventor({ entries: [entry(P + 2, "Other Runner")] });
      const res = await caller.eventor.sync();

      const r = await runnerOf(ctx, P + 1);
      expect(r.status).toBe("ok");
      expect(res.runners.wouldCancel).toBe(0);
      expect(res.runners.heldBack).toBe(1);
      expect(res.samples.heldBack).toEqual(["Finished Runner"]);
      expect((r.eventorSnapshot as { present: boolean }).present).toBe(false);
    });
  });

  it("EVT-01: an empty EntryList refuses and cancels nobody (was: cancelled every runner)", async () => {
    await withEvent("evt01-empty", async (ctx) => {
      const caller = makeCaller(ctx.event);
      mockEventor({ entries: [entry(P + 1, "A"), entry(P + 2, "B")] });
      await caller.eventor.sync();
      mockEventor({ entries: [] });
      await expect(caller.eventor.sync()).rejects.toThrow(/EVENTOR_EMPTY_RESPONSE/);
      const statuses = await ctx.db.runner.findMany({ where: { eventId: ctx.eventId }, select: { status: true } });
      expect(statuses.map((s) => s.status)).toEqual(["unknown", "unknown"]);
    });
  });

  it("EVT-01: a runner missing without any activity is still cancelled, and reinstated when she returns", async () => {
    await withEvent("evt01-cancel", async (ctx) => {
      const caller = makeCaller(ctx.event);
      mockEventor({ entries: [entry(P + 1, "Withdrawn"), entry(P + 2, "Stays")] });
      await caller.eventor.sync();
      mockEventor({ entries: [entry(P + 2, "Stays")] });
      const res = await caller.eventor.sync();
      expect(res.runners.wouldCancel).toBe(1);
      expect((await runnerOf(ctx, P + 1)).status).toBe("cancel");
      mockEventor({ entries: [entry(P + 1, "Withdrawn"), entry(P + 2, "Stays")] });
      const back = await caller.eventor.sync();
      expect(back.runners.reinstated).toBe(1);
      expect((await runnerOf(ctx, P + 1)).status).toBe("unknown");
    });
  });

  it("API-10: a results-only runner survives the second sync (was: cancelled on every later sync)", async () => {
    await withEvent("api10", async (ctx) => {
      const caller = makeCaller(ctx.event);
      mockEventor({ entries: [entry(P + 1, "Entered")], results: [result(P + 9, { personName: "Late Entry" })] });
      await caller.eventor.sync();
      expect((await runnerOf(ctx, P + 9)).status).toBe("unknown");
      await caller.eventor.sync();
      const r = await runnerOf(ctx, P + 9);
      expect(r.status).toBe("unknown");
      expect(r.removed).toBe(false);
    });
  });

  it("EVT-02: a rental card given at the desk survives (was: reset to NULL)", async () => {
    await withEvent("evt02-card", async (ctx) => {
      const caller = makeCaller(ctx.event);
      mockEventor({ entries: [entry(P + 1, "No Card", { cardNo: 0 })] });
      await caller.eventor.sync();
      await ctx.db.runner.updateMany({ where: { eventId: ctx.eventId }, data: { cardNo: 888_001 } });
      const res = await caller.eventor.sync();
      expect((await runnerOf(ctx, P + 1)).cardNo).toBe(888_001);
      expect(res.runners.updated).toBe(0);
    });
  });

  it("EVT-02: a card the desk changed survives an Eventor card change, and is shown as a difference", async () => {
    await withEvent("evt02-card-diff", async (ctx) => {
      const caller = makeCaller(ctx.event);
      mockEventor({ entries: [entry(P + 1, "Card Runner", { cardNo: 100_001 })] });
      await caller.eventor.sync();
      await ctx.db.runner.updateMany({ where: { eventId: ctx.eventId }, data: { cardNo: 888_002 } });
      mockEventor({ entries: [entry(P + 1, "Card Runner", { cardNo: 100_002 })] });
      const res = await caller.eventor.sync();
      expect(res.runners.keptLocal).toBe(1);
      const r = await runnerOf(ctx, P + 1);
      expect(r.cardNo).toBe(888_002);
      const detail = await caller.runner.getById({ id: r.seq });
      expect(detail.eventorDiff).toEqual([{ field: "cardNo", local: 888_002, eventor: 100_002 }]);
      const list = await caller.runner.list();
      expect(list.find((x) => x.id === r.seq)?.differsFromEventor).toBe(true);
    });
  });

  it("EVT-02: a class move at the desk survives; an untouched runner follows Eventor's move", async () => {
    await withEvent("evt02-class", async (ctx) => {
      const caller = makeCaller(ctx.event);
      mockEventor({ entries: [entry(P + 1, "Moved Locally"), entry(P + 2, "Moved By Eventor")] });
      await caller.eventor.sync();
      const clsB = await ctx.db.class.findFirstOrThrow({ where: { eventId: ctx.eventId, eventorId: BigInt(CLASS_B) } });
      const clsA = await ctx.db.class.findFirstOrThrow({ where: { eventId: ctx.eventId, eventorId: BigInt(CLASS_A) } });
      await ctx.db.runner.updateMany({
        where: { eventId: ctx.eventId, eventorPersonId: BigInt(P + 1) },
        data: { classId: clsB.id },
      });
      mockEventor({
        entries: [entry(P + 1, "Moved Locally"), entry(P + 2, "Moved By Eventor", { classId: CLASS_B })],
      });
      await caller.eventor.sync();
      expect((await runnerOf(ctx, P + 1)).classId).toBe(clsB.id);
      expect((await runnerOf(ctx, P + 2)).classId).toBe(clsB.id);
      expect(clsA.id).not.toBe(clsB.id);
    });
  });

  it("EVT-02: a runner who has started stays in her class (reported, not applied)", async () => {
    await withEvent("evt02-started", async (ctx) => {
      const caller = makeCaller(ctx.event);
      mockEventor({ entries: [entry(P + 1, "Started")] });
      await caller.eventor.sync();
      const before = await runnerOf(ctx, P + 1);
      await ctx.db.runner.update({ where: { id: before.id }, data: { startTime: 1200 } });
      mockEventor({ entries: [entry(P + 1, "Started", { classId: CLASS_B })] });
      const res = await caller.eventor.sync();
      expect(res.runners.classChangeBlocked).toBe(1);
      expect((await runnerOf(ctx, P + 1)).classId).toBe(before.classId);
    });
  });

  it("EVT-02: an Eventor change applies when nothing was edited locally", async () => {
    await withEvent("evt02-applies", async (ctx) => {
      const caller = makeCaller(ctx.event);
      mockEventor({ entries: [entry(P + 1, "Old Name", { cardNo: 0 })] });
      await caller.eventor.sync();
      mockEventor({ entries: [entry(P + 1, "New Name", { cardNo: 123_456, birthYear: 1985 })] });
      const res = await caller.eventor.sync();
      const r = await runnerOf(ctx, P + 1);
      expect(r).toMatchObject({ name: "New Name", cardNo: 123_456, birthYear: 1985 });
      expect(res.runners.updated).toBe(1);
    });
  });

  it("EVT-02: an empty Eventor card never blanks a local card", async () => {
    await withEvent("evt02-blank", async (ctx) => {
      const caller = makeCaller(ctx.event);
      mockEventor({ entries: [entry(P + 1, "Had Card", { cardNo: 321_000 })] });
      await caller.eventor.sync();
      mockEventor({ entries: [entry(P + 1, "Had Card", { cardNo: 0 })] });
      await caller.eventor.sync();
      expect((await runnerOf(ctx, P + 1)).cardNo).toBe(321_000);
    });
  });

  it("no snapshot (a runner from before the upgrade): nothing is overwritten, the difference is reported and a snapshot seeded", async () => {
    await withEvent("nosnap", async (ctx) => {
      const caller = makeCaller(ctx.event);
      const c = await ctx.db.class.create({
        data: { eventId: ctx.eventId, name: "H21", eventorId: BigInt(CLASS_A) },
      });
      await ctx.db.runner.create({
        data: {
          eventId: ctx.eventId, classId: c.id, name: "Corrected Name", cardNo: 777_001,
          eventorPersonId: BigInt(P + 1), entrySource: EVENTOR_EVENT_ID,
        },
      });
      mockEventor({ entries: [entry(P + 1, "Original Name", { cardNo: 100_005 })] });
      const res = await caller.eventor.sync();
      const r = await runnerOf(ctx, P + 1);
      expect(r).toMatchObject({ name: "Corrected Name", cardNo: 777_001 });
      expect(res.runners.keptLocal).toBe(1);
      expect(r.eventorSnapshot).toMatchObject({ name: "Original Name", card_no: 100_005 });
    });
  });

  it("RES-02 / EVT-04: a re-sync never touches times, status or start number (was: rewrote all from the results)", async () => {
    await withEvent("res02", async (ctx) => {
      const caller = makeCaller(ctx.event);
      mockEventor({ entries: [entry(P + 1, "Timed", { cardNo: 150_001 })] });
      await caller.eventor.sync();
      await ctx.db.runner.updateMany({
        where: { eventId: ctx.eventId },
        data: { startTime: 36000, finishTime: 72000, status: "ok", startNo: 42 },
      });
      // Eventor's copy: absolute clock times, a place where a start number was taken from.
      mockEventor({
        entries: [entry(P + 1, "Timed", { cardNo: 150_001 })],
        results: [result(P + 1, { startTime: 360000, finishTime: 372000, status: 5, bib: "H4", cardNo: 150_001 })],
      });
      const res = await caller.eventor.sync();
      const r = await runnerOf(ctx, P + 1);
      expect(r).toMatchObject({ startTime: 36000, finishTime: 72000, status: "ok", startNo: 42, bib: "" });
      expect(res.runners.updated).toBe(0);
    });
  });

  it("EVT-03: a failed export/classes request keeps a class's noTiming (was: cleared on every class)", async () => {
    await withEvent("evt03", async (ctx) => {
      const caller = makeCaller(ctx.event);
      mockEventor({ classes: [cls(CLASS_A, "Inskolning", true)], entries: [] });
      await caller.eventor.sync();
      expect((await ctx.db.class.findFirstOrThrow({ where: { eventId: ctx.eventId } })).noTiming).toBe(true);
      mockEventor({ classes: [{ ...cls(CLASS_A, "Inskolning"), noTiming: undefined }], entries: [] });
      const res = await caller.eventor.sync();
      expect((await ctx.db.class.findFirstOrThrow({ where: { eventId: ctx.eventId } })).noTiming).toBe(true);
      expect(res.classes.detailsIncomplete).toBe(true);
    });
  });

  it("EVT-03: a class renamed locally keeps its name (was: reset on every successful sync)", async () => {
    await withEvent("evt03-name", async (ctx) => {
      const caller = makeCaller(ctx.event);
      mockEventor({ classes: [cls(CLASS_A, "H21")] });
      await caller.eventor.sync();
      await ctx.db.class.updateMany({ where: { eventId: ctx.eventId }, data: { name: "Elit" } });
      const res = await caller.eventor.sync();
      expect((await ctx.db.class.findFirstOrThrow({ where: { eventId: ctx.eventId } })).name).toBe("Elit");
      expect(res.classes.keptLocal).toBe(0); // Eventor did not change it: nothing to keep
    });
  });
});

describe("eventor.sync preview and lease", () => {
  it("dryRun writes nothing and reports the counts the real sync then produces", async () => {
    await withEvent("dryrun", async (ctx) => {
      const caller = makeCaller(ctx.event);
      mockEventor({ entries: [entry(P + 1, "Gone Soon"), entry(P + 2, "Stays")] });
      await caller.eventor.sync();
      mockEventor({
        entries: [entry(P + 2, "Stays"), entry(P + 3, "New One", { cardNo: 400_001 })],
        classes: [cls(CLASS_A, "H21"), cls(CLASS_B, "H35"), cls(41_003, "D21")],
      });
      const snapshotRows = async () => ({
        runners: await ctx.db.runner.findMany({ where: { eventId: ctx.eventId }, orderBy: { name: "asc" } }),
        classes: await ctx.db.class.count({ where: { eventId: ctx.eventId } }),
        sync: (await ctx.db.event.findUniqueOrThrow({ where: { id: ctx.eventId } })).eventorLastSync,
      });
      const before = await snapshotRows();
      const preview = await caller.eventor.sync({ dryRun: true });
      expect(await snapshotRows()).toEqual(before);
      expect(preview.dryRun).toBe(true);
      expect(preview.runners).toMatchObject({ added: 1, wouldCancel: 1 });
      expect(preview.samples.wouldCancel).toEqual(["Gone Soon"]);
      expect(preview.classes.added).toBe(1);

      const applied = await caller.eventor.sync();
      expect({ ...applied, dryRun: true }).toEqual(preview);
      expect((await ctx.db.runner.count({ where: { eventId: ctx.eventId } }))).toBe(3);
    });
  });

  it("API-08: an active lease refuses the sync and its preview (was: wrote unjournaled), pushStartList stays available", async () => {
    await withEvent("api08", async (ctx) => {
      const caller = makeCaller(ctx.event);
      mockEventor({ entries: [entry(P + 1, "Leased")] });
      await ctx.db.eventLease.create({ data: { eventId: ctx.eventId, holderNodeId: "venue-box" } });
      await expect(caller.eventor.sync()).rejects.toThrow(/EVENT_CHECKED_OUT/);
      await expect(caller.eventor.sync({ dryRun: true })).rejects.toThrow(/EVENT_CHECKED_OUT/);
      expect(await ctx.db.runner.count({ where: { eventId: ctx.eventId } })).toBe(0);
      await expect(caller.eventor.pushStartList({ dryRun: true })).resolves.toEqual({ runnerCount: 0 });
      // Released again: the sync works.
      await ctx.db.eventLease.updateMany({ where: { eventId: ctx.eventId }, data: { releasedAt: new Date() } });
      await expect(caller.eventor.sync()).resolves.toMatchObject({ runners: { added: 1 } });
    });
  });

  it("a runner deleted at the desk is not brought back", async () => {
    await withEvent("deleted", async (ctx) => {
      const caller = makeCaller(ctx.event);
      mockEventor({ entries: [entry(P + 1, "Deleted Locally")] });
      await caller.eventor.sync();
      await ctx.db.runner.updateMany({ where: { eventId: ctx.eventId }, data: { removed: true } });
      await caller.eventor.sync();
      expect(await ctx.db.runner.count({ where: { eventId: ctx.eventId } })).toBe(1);
    });
  });
});

describe("runner.useEventorValue", () => {
  it("sets the field to Eventor's last value as a journaled edit, and refuses a card another runner holds", async () => {
    await withEvent("use-value", async (ctx) => {
      const caller = makeCaller(ctx.event);
      mockEventor({ entries: [entry(P + 1, "Use Mine", { cardNo: 100_010 }), entry(P + 2, "Other", { cardNo: 100_011 })] });
      await caller.eventor.sync();
      const r = await runnerOf(ctx, P + 1);
      await ctx.db.runner.update({ where: { id: r.id }, data: { cardNo: 888_010, name: "Typo Name" } });

      await caller.runner.useEventorValue({ runnerId: r.seq, field: "cardNo" });
      expect((await runnerOf(ctx, P + 1)).cardNo).toBe(100_010);
      expect(
        await ctx.db.journalEntry.count({ where: { eventId: ctx.eventId, type: "runner.updated" } }),
      ).toBe(1);

      // Another runner takes that card at the desk; Eventor's value can no longer be used.
      await ctx.db.runner.updateMany({
        where: { id: r.id },
        data: { cardNo: 888_011 },
      });
      await ctx.db.runner.updateMany({
        where: { eventId: ctx.eventId, eventorPersonId: BigInt(P + 2) },
        data: { cardNo: 100_010 },
      });
      await expect(caller.runner.useEventorValue({ runnerId: r.seq, field: "cardNo" })).rejects.toMatchObject({
        code: "CONFLICT",
      });
      await caller.runner.useEventorValue({ runnerId: r.seq, field: "name" });
      expect((await runnerOf(ctx, P + 1)).name).toBe("Use Mine");
    });
  });
});

describe("eventor.sync: bound to its preview, serialised with checkout, entries without a person id", () => {
  it("apply refuses a runner to cancel that the preview did not show (EVENTOR_PREVIEW_CHANGED), and applies a smaller set", async () => {
    await withEvent("preview-bound", async (ctx) => {
      const caller = makeCaller(ctx.event);
      mockEventor({ entries: [entry(P + 1, "Seen"), entry(P + 2, "Unseen"), entry(P + 3, "Stays")] });
      await caller.eventor.sync();
      mockEventor({ entries: [entry(P + 3, "Stays")] });
      const preview = await caller.eventor.sync({ dryRun: true });
      expect(preview.cancelIds).toHaveLength(2);
      const seen = await runnerOf(ctx, P + 1);

      // Only one of the two was previewed: refused, nothing cancelled.
      await expect(caller.eventor.sync({ confirmCancelIds: [seen.id] })).rejects.toThrow(/EVENTOR_PREVIEW_CHANGED/);
      expect((await runnerOf(ctx, P + 2)).status).toBe("unknown");

      // A previewed set that is larger than what would happen is fine.
      mockEventor({ entries: [entry(P + 2, "Unseen"), entry(P + 3, "Stays")] });
      const res = await caller.eventor.sync({ confirmCancelIds: preview.cancelIds });
      expect(res.runners.wouldCancel).toBe(1);
      expect((await runnerOf(ctx, P + 1)).status).toBe("cancel");
      expect((await runnerOf(ctx, P + 2)).status).toBe("unknown");
    });
  });

  it("a manual cancel of a held-back runner is not undone when she reappears", async () => {
    await withEvent("manual-cancel", async (ctx) => {
      const caller = makeCaller(ctx.event);
      mockEventor({ entries: [entry(P + 1, "Held"), entry(P + 2, "Other")] });
      await caller.eventor.sync();
      await ctx.db.runner.updateMany({
        where: { eventId: ctx.eventId, eventorPersonId: BigInt(P + 1) },
        data: { status: "ok", finishTime: 100 },
      });
      mockEventor({ entries: [entry(P + 2, "Other")] }); // held back: present false
      await caller.eventor.sync();
      await ctx.db.runner.updateMany({
        where: { eventId: ctx.eventId, eventorPersonId: BigInt(P + 1) },
        data: { status: "cancel" }, // the desk cancels her by hand
      });
      mockEventor({ entries: [entry(P + 1, "Held"), entry(P + 2, "Other")] });
      const res = await caller.eventor.sync();
      expect(res.runners.reinstated).toBe(0);
      expect((await runnerOf(ctx, P + 1)).status).toBe("cancel");
    });
  });

  it("a taken card on a new runner is counted, kept out, and shown as a difference", async () => {
    await withEvent("card-conflict-create", async (ctx) => {
      const caller = makeCaller(ctx.event);
      mockEventor({ entries: [entry(P + 1, "Holder", { cardNo: 444_001 })] });
      await caller.eventor.sync();
      mockEventor({ entries: [entry(P + 1, "Holder", { cardNo: 444_001 }), entry(P + 2, "Loser", { cardNo: 444_001 })] });
      const res = await caller.eventor.sync();
      expect(res.runners.cardConflicts).toBe(1);
      const loser = await runnerOf(ctx, P + 2);
      expect(loser.cardNo).toBeNull();
      const detail = await caller.runner.getById({ id: loser.seq });
      expect(detail.eventorDiff).toEqual([{ field: "cardNo", local: null, eventor: 444_001 }]);
    });
  });

  it("EVT-09: an entry without a person id gets a runner, matched by entry id on the next sync (was: dropped)", async () => {
    await withEvent("no-person-id", async (ctx) => {
      const caller = makeCaller(ctx.event);
      mockEventor({ entries: [entry(0, "Guest Runner", { eventorEntryId: 5_001 }), entry(P + 1, "Normal")] });
      const first = await caller.eventor.sync();
      expect(first.runners.added).toBe(2);
      const second = await caller.eventor.sync();
      expect(second.runners).toMatchObject({ added: 0, wouldCancel: 0 });
      expect(await ctx.db.runner.count({ where: { eventId: ctx.eventId } })).toBe(2);
      // Gone from Eventor: cancelled like any other.
      mockEventor({ entries: [entry(P + 1, "Normal")] });
      const third = await caller.eventor.sync();
      expect(third.runners.wouldCancel).toBe(1);
      const guest = await ctx.db.runner.findFirstOrThrow({ where: { eventId: ctx.eventId, eventorEntryId: 5_001n } });
      expect(guest.status).toBe("cancel");
    });
  });

  it("a second entry of one person and an entry with no id at all are counted, not silently dropped", async () => {
    await withEvent("dups-counted", async (ctx) => {
      const caller = makeCaller(ctx.event);
      mockEventor({
        entries: [entry(P + 1, "Twice"), entry(P + 1, "Twice", { eventorEntryId: 9_999 }), entry(0, "Nobody", { eventorEntryId: 0 })],
      });
      const res = await caller.eventor.sync();
      expect(res.runners).toMatchObject({ added: 1, duplicateEntries: 1, skippedNoId: 1 });
    });
  });

  it("a checkout waits for a running sync transaction and the sync sees the lease afterwards (lock order)", async () => {
    await withEvent("lock-order", async (ctx) => {
      let acquired = false;
      let release!: () => void;
      const held = new Promise<void>((r) => (release = r));
      const holder = prisma().$transaction(async (tx) => {
        await lockEventLeaseAndSync(tx, ctx.eventId);
        await held;
      });
      await new Promise((r) => setTimeout(r, 200));
      const acquiring = acquireLease(prisma(), ctx.eventId, "venue-x").then(() => {
        acquired = true;
      });
      await new Promise((r) => setTimeout(r, 400));
      expect(acquired).toBe(false); // waits for the lock
      release();
      await holder;
      await acquiring;
      expect(acquired).toBe(true);
      mockEventor({ entries: [entry(P + 1, "X")] });
      await expect(makeCaller(ctx.event).eventor.sync()).rejects.toThrow(/EVENT_CHECKED_OUT/);
    });
  });
});
