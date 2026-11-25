/**
 * The merge rules of the Eventor sync (review package 5, EVT-01..04, API-10).
 * Pure: no database. docs/system/eventor-sync.md.
 */
import { describe, it, expect } from "vitest";
import {
  mergeField,
  hasLocalActivity,
  planClassSync,
  planRunnerSync,
  runnerEventorDiff,
  type ExistingRunner,
  type ExistingClass,
  type EntryInput,
  type ResultInput,
  type RunnerSnapshot,
} from "../eventor-merge.js";

describe("mergeField", () => {
  it("never writes when Eventor has no opinion", () => {
    expect(mergeField(777, 5, undefined)).toEqual({ write: false, differs: false, kept: false });
  });
  it("writes nothing without a snapshot and reports the difference", () => {
    expect(mergeField(777, undefined, 5)).toEqual({ write: false, differs: true, kept: true });
    expect(mergeField(5, undefined, 5)).toEqual({ write: false, differs: false, kept: false });
  });
  it("applies Eventor's change while the local value is untouched", () => {
    expect(mergeField("A", "A", "B")).toEqual({ write: true, differs: false, kept: false });
    expect(mergeField("A", "A", "A")).toEqual({ write: false, differs: false, kept: false });
  });
  it("keeps a local edit and reports it", () => {
    expect(mergeField("Mine", "A", "B")).toEqual({ write: false, differs: true, kept: true });
    // Eventor did not change it since the snapshot: a difference, but nothing to report as kept.
    expect(mergeField("Mine", "A", "A")).toEqual({ write: false, differs: true, kept: false });
    expect(mergeField("B", "A", "B")).toEqual({ write: false, differs: false, kept: false });
  });
  it("treats null as a value (no card locally and in the snapshot)", () => {
    expect(mergeField<number | null>(null, null, 5)).toEqual({ write: true, differs: false, kept: false });
  });
});

describe("hasLocalActivity", () => {
  const base = { cardId: null, finishTime: 0, status: "unknown" };
  it("is false for a plain entry and for the sync's own states", () => {
    expect(hasLocalActivity(base)).toBe(false);
    expect(hasLocalActivity({ ...base, status: "no_timing" })).toBe(false);
    expect(hasLocalActivity({ ...base, status: "cancel" })).toBe(false);
  });
  it("is true after a readout, a finish time or a result status", () => {
    expect(hasLocalActivity({ ...base, cardId: "c" })).toBe(true);
    expect(hasLocalActivity({ ...base, finishTime: 10 })).toBe(true);
    expect(hasLocalActivity({ ...base, status: "ok" })).toBe(true);
    expect(hasLocalActivity({ ...base, status: "dns" })).toBe(true);
  });
});

function entry(personId: number, over: Partial<EntryInput> = {}): EntryInput {
  return {
    personName: `Person ${personId}`,
    personId,
    birthYear: 1990,
    sex: "M",
    nationality: "SWE",
    organisationId: 0,
    organisationName: "",
    classId: 10,
    cardNo: 0,
    eventorEntryId: personId,
    entryDate: 0,
    entryTime: 0,
    fee: 0,
    paid: 0,
    taxable: 0,
    rankingScore: 0,
    noTiming: false,
    ...over,
  };
}

function runner(personId: number, over: Partial<ExistingRunner> = {}): ExistingRunner {
  return {
    id: `r${personId}`,
    eventorPersonId: personId,
    eventorEntryId: null,
    removed: false,
    name: `Person ${personId}`,
    cardNo: null,
    cardId: null,
    classEventorId: 10,
    eventorClubId: null,
    clubName: "",
    birthYear: 1990,
    sex: "M",
    nationality: "SWE",
    startTime: 0,
    finishTime: 0,
    status: "unknown",
    entrySource: 1,
    entryDate: 0,
    entryTime: 0,
    feeCents: 0,
    paidCents: 0,
    taxableCents: 0,
    rank: 0,
    snapshot: null,
    ...over,
  };
}

const SNAP: RunnerSnapshot = {
  name: "Person 1",
  card_no: null,
  class_eventor_id: 10,
  club_eventor_id: null,
  club_name: "",
  birth_year: 1990,
  sex: "M",
  nationality: "SWE",
  present: true,
};

function plan(
  existing: ExistingRunner[],
  entries: EntryInput[],
  results: ResultInput[] = [],
  cards: Array<{ ownerKey: string; cardNo: number | null }> = existing.map((r) => ({ ownerKey: r.id, cardNo: r.cardNo })),
) {
  return planRunnerSync({
    eventorEventId: 99,
    existing,
    cardOwners: cards,
    entries,
    results,
    knownClassEventorIds: new Set([10, 11]),
    clubNameByEventorId: new Map(),
  });
}

describe("planRunnerSync: card", () => {
  it("keeps a rental card the desk gave (EVT-02)", () => {
    const p = plan([runner(1, { cardNo: 777, snapshot: SNAP })], [entry(1, { cardNo: 5 })]);
    expect(p.updates.find((u) => u.id === "r1")?.data.cardNo).toBeUndefined();
    expect(p.counts.keptLocal).toBe(1);
  });
  it("never blanks a local card when Eventor has none (raw 0)", () => {
    const p = plan([runner(1, { cardNo: 777, snapshot: { ...SNAP, card_no: 777 } })], [entry(1, { cardNo: 0 })]);
    expect(p.updates).toEqual([]);
  });
  it("applies Eventor's card when the local one is untouched", () => {
    const p = plan([runner(1, { cardNo: null, snapshot: SNAP })], [entry(1, { cardNo: 5 })]);
    expect(p.updates[0].data.cardNo).toBe(5);
    expect(p.updates[0].snapshot?.card_no).toBe(5);
  });
  it("keeps the card of a runner that has been read out", () => {
    const p = plan(
      [runner(1, { cardNo: 4, cardId: "card", snapshot: { ...SNAP, card_no: 4 } })],
      [entry(1, { cardNo: 5 })],
    );
    expect(p.updates[0]?.data.cardNo).toBeUndefined();
    expect(p.counts.keptLocal).toBe(1);
  });
  it("keeps the local card but records Eventor's card when another runner holds it", () => {
    const p = plan(
      [runner(1, { cardNo: null, snapshot: SNAP })],
      [entry(1, { cardNo: 5 })],
      [],
      [{ ownerKey: "other", cardNo: 5 }],
    );
    expect(p.counts.cardConflicts).toBe(1);
    // Eventor's card is in the snapshot, so the runner shows as differing.
    expect(p.updates.find((u) => u.id === "r1")?.snapshot?.card_no).toBe(5);
    expect(p.updates.find((u) => u.id === "r1")?.data.cardNo).toBeUndefined();
  });
  it("claims cards per entry id on create and drops the second owner (EVT-09)", () => {
    const p = plan([], [entry(1, { cardNo: 5 }), entry(2, { cardNo: 5 })]);
    expect(p.creates.map((c) => c.cardNo)).toEqual([5, null]);
    // The loser keeps Eventor's card in the snapshot (shown as a difference) and is counted.
    expect(p.creates[1].snapshot.card_no).toBe(5);
    expect(p.counts.cardConflicts).toBe(1);
  });
});

describe("planRunnerSync: other fields", () => {
  it("keeps a class move and reports nothing to write (EVT-02)", () => {
    const p = plan([runner(1, { classEventorId: 11, snapshot: SNAP })], [entry(1, { classId: 10 })]);
    expect(p.updates).toEqual([]);
    expect(p.counts.keptLocal).toBe(0); // Eventor did not move her: nothing new was kept
  });
  it("moves an untouched runner when Eventor moved her", () => {
    const p = plan([runner(1, { snapshot: SNAP })], [entry(1, { classId: 11 })]);
    expect(p.updates[0].data.classEventorId).toBe(11);
  });
  it("does not move a runner who has started, but shows the difference", () => {
    const p = plan([runner(1, { snapshot: SNAP, startTime: 100 })], [entry(1, { classId: 11 })]);
    expect(p.updates[0].data.classEventorId).toBeUndefined();
    expect(p.counts.classChangeBlocked).toBe(1);
    expect(p.updates[0].snapshot?.class_eventor_id).toBe(11);
  });
  it("treats an unknown class as no opinion", () => {
    const p = plan([runner(1, { snapshot: SNAP })], [entry(1, { classId: 999 })]);
    expect(p.updates).toEqual([]);
  });
  it("writes nothing without a snapshot, seeds it and counts the difference", () => {
    const p = plan([runner(1, { name: "Corrected Name" })], [entry(1)]);
    expect(p.updates[0].data).toEqual({});
    expect(p.updates[0].snapshot?.name).toBe("Person 1");
    expect(p.counts.keptLocal).toBe(1);
    expect(p.counts.updated).toBe(0);
  });
  it("applies a club as an id and name pair", () => {
    const p = planRunnerSync({
      eventorEventId: 99,
      existing: [runner(1, { snapshot: SNAP })],
      cardOwners: [],
      entries: [entry(1, { organisationId: 7, organisationName: "OK Test" })],
      results: [],
      knownClassEventorIds: new Set([10]),
      clubNameByEventorId: new Map([[7, "OK Test"]]),
    });
    expect(p.updates[0].data).toMatchObject({ eventorClubId: 7, clubName: "OK Test" });
  });
  it("never touches times, status or start number", () => {
    const result = {
      personId: 1, personName: "x", birthYear: 0, sex: "", nationality: "", organisationId: 0,
      organisationName: "", classId: 10, cardNo: 9, startTime: 360000, finishTime: 400000, status: 1, bib: "5",
    } satisfies ResultInput;
    const p = plan([runner(1, { snapshot: SNAP })], [entry(1)], [result]);
    expect(p.updates).toEqual([]);
  });
});

describe("planRunnerSync: presence", () => {
  it("cancels a missing runner without activity and marks the snapshot", () => {
    const p = plan([runner(1, { snapshot: SNAP })], [entry(2)]);
    expect(p.cancels.map((r) => r.id)).toEqual(["r1"]);
    expect(p.cancels[0].snapshot).toMatchObject({ present: false, cancelled_by_sync: true });
  });
  it("holds back a missing runner who has finished (EVT-01)", () => {
    const p = plan([runner(1, { snapshot: SNAP, status: "ok", finishTime: 5 })], [entry(2)]);
    expect(p.cancels).toEqual([]);
    expect(p.heldBack.map((r) => r.id)).toEqual(["r1"]);
    expect(p.counts.heldBack).toBe(1);
  });
  it("holds back a runner whose card was read", () => {
    const p = plan([runner(1, { cardId: "c" })], [entry(2)]);
    expect(p.cancels).toEqual([]);
    expect(p.counts.heldBack).toBe(1);
  });
  it("counts a results-only person as present (API-10)", () => {
    const result = {
      personId: 1, personName: "x", birthYear: 0, sex: "", nationality: "", organisationId: 0,
      organisationName: "", classId: 10, cardNo: 0, startTime: 0, finishTime: 0, status: 1, bib: "",
    } satisfies ResultInput;
    const p = plan([runner(1, { snapshot: SNAP })], [], [result]);
    expect(p.cancels).toEqual([]);
    expect(p.counts.heldBack).toBe(0);
  });
  it("leaves a removed runner alone, and a cancelled one already out", () => {
    const p = plan(
      [runner(1, { removed: true }), runner(2, { status: "cancel" })],
      [entry(1)],
    );
    expect(p.creates).toEqual([]);
    expect(p.cancels).toEqual([]);
    expect(p.updates).toEqual([]);
  });
  it("reinstates only a runner the sync cancelled itself", () => {
    const own = plan([runner(1, { status: "cancel", snapshot: { ...SNAP, present: false, cancelled_by_sync: true } })], [entry(1)]);
    expect(own.updates[0].data.status).toBe("unknown");
    expect(own.updates[0].snapshot?.cancelled_by_sync).toBeUndefined();
    expect(own.counts.reinstated).toBe(1);
    const manual = plan([runner(1, { status: "cancel", snapshot: SNAP })], [entry(1)]);
    expect(manual.updates.find((u) => u.data.status)).toBeUndefined();
    // Held back (present: false, but not cancelled by the sync) and then cancelled by hand.
    const heldThenManual = plan([runner(1, { status: "cancel", snapshot: { ...SNAP, present: false } })], [entry(1)]);
    expect(heldThenManual.updates.find((u) => u.data.status)).toBeUndefined();
    const legacy = plan([runner(1, { status: "cancel" })], [entry(1)]);
    expect(legacy.updates.find((u) => u.data.status)).toBeUndefined();
  });
  it("reinstates into no_timing for a no-timing entry", () => {
    const p = plan(
      [runner(1, { status: "cancel", snapshot: { ...SNAP, present: false, cancelled_by_sync: true } })],
      [entry(1, { noTiming: true })],
    );
    expect(p.updates[0].data.status).toBe("no_timing");
  });
});

describe("planRunnerSync: entries without a person id and duplicates (EVT-09)", () => {
  it("creates a runner for an entry without a person id, keyed on the entry id", () => {
    const p = plan([], [entry(0, { personName: "No Person", eventorEntryId: 777, cardNo: 9 })]);
    expect(p.creates).toHaveLength(1);
    expect(p.creates[0]).toMatchObject({ personId: 0, eventorEntryId: 777, name: "No Person" });
  });
  it("matches that runner on re-sync by entry id instead of creating it again, and does not cancel her", () => {
    const existing = runner(0, { id: "rx", eventorPersonId: null, eventorEntryId: 777, snapshot: { ...SNAP, name: "No Person" } });
    const p = plan([existing], [entry(0, { personName: "No Person", eventorEntryId: 777 })]);
    expect(p.creates).toEqual([]);
    expect(p.cancels).toEqual([]);
  });
  it("cancels an entry-keyed runner whose entry disappeared", () => {
    const existing = runner(0, { id: "rx", eventorPersonId: null, eventorEntryId: 777 });
    const p = plan([existing], [entry(2)]);
    expect(p.cancels.map((r) => r.id)).toEqual(["rx"]);
  });
  it("counts a second entry of the same person and an entry with neither id", () => {
    const p = plan([], [entry(1), entry(1, { eventorEntryId: 99 }), entry(0, { eventorEntryId: 0 })]);
    expect(p.creates).toHaveLength(1);
    expect(p.counts.duplicateEntries).toBe(1);
    expect(p.counts.skippedNoId).toBe(1);
  });
});

describe("planRunnerSync: club rename", () => {
  it("follows a club renamed in Eventor under the same id while the local name is the snapshot's", () => {
    const base = { ...SNAP, club_eventor_id: 7, club_name: "OK Old" };
    const run = (clubName: string) =>
      planRunnerSync({
        eventorEventId: 99,
        existing: [runner(1, { eventorClubId: 7, clubName, snapshot: base })],
        cardOwners: [],
        entries: [entry(1, { organisationId: 7, organisationName: "OK New" })],
        results: [],
        knownClassEventorIds: new Set([10]),
        clubNameByEventorId: new Map([[7, "OK New"]]),
      });
    expect(run("OK Old").updates[0].data).toMatchObject({ clubName: "OK New" });
    expect(run("My Edit").updates.find((u) => u.data.clubName)).toBeUndefined();
  });
});

describe("planRunnerSync: creates", () => {
  it("creates new persons with a full snapshot and skips duplicate persons", () => {
    const p = plan([], [entry(1, { cardNo: 5 }), entry(1, { cardNo: 6 })]);
    expect(p.creates).toHaveLength(1);
    expect(p.creates[0].snapshot).toMatchObject({ card_no: 5, class_eventor_id: 10, present: true });
    expect(p.counts.added).toBe(1);
  });
  it("keeps the Eventor times as absolute values for the caller to convert", () => {
    const result = {
      personId: 1, personName: "x", birthYear: 0, sex: "", nationality: "", organisationId: 0,
      organisationName: "", classId: 10, cardNo: 0, startTime: 360000, finishTime: 372000, status: 1, bib: "5",
    } satisfies ResultInput;
    const p = plan([], [entry(1)], [result]);
    expect(p.creates[0]).toMatchObject({ startTime: 360000, finishTime: 372000, status: "ok", bib: "5" });
  });
});

function cls(over: Partial<ExistingClass> = {}): ExistingClass {
  return {
    id: "c1", name: "H21", eventorId: 10, sortIndex: 1, sex: "M", lowAge: 0, highAge: 0,
    noTiming: true, classType: "", snapshot: null, ...over,
  };
}
const ec = (over = {}) => ({
  classId: 10, name: "H21", sex: "M", lowAge: 0, highAge: 0, sequence: 1, classType: "", noTiming: true as boolean | undefined, ...over,
});

describe("planClassSync", () => {
  it("does not clear noTiming when Eventor gave no answer (EVT-03)", () => {
    const snap = { name: "H21", sex: "M", low_age: 0, high_age: 0, no_timing: true, sort_index: 1, class_type: "" };
    const p = planClassSync({ existing: [cls({ snapshot: snap })], eventor: [ec({ noTiming: undefined })] });
    expect(p.updates).toEqual([]);
    expect(p.detailsIncomplete).toBe(true);
  });
  it("keeps a locally renamed class and applies an untouched one", () => {
    const snap = { name: "H21", sex: "M", low_age: 0, high_age: 0, no_timing: true, sort_index: 1, class_type: "" };
    const kept = planClassSync({ existing: [cls({ name: "Elit", snapshot: snap })], eventor: [ec({ name: "H21 Lång" })] });
    // Nothing written to the class; the snapshot follows Eventor's latest value.
    expect(kept.updates[0].data).toEqual({});
    expect(kept.updates[0].snapshot?.name).toBe("H21 Lång");
    expect(kept.keptLocal).toBe(1);
    const applied = planClassSync({ existing: [cls({ snapshot: snap })], eventor: [ec({ name: "H21 Lång" })] });
    expect(applied.updates[0].data.name).toBe("H21 Lång");
  });
  it("writes nothing to a class without a snapshot but seeds one", () => {
    const p = planClassSync({ existing: [cls({ name: "Elit" })], eventor: [ec()] });
    expect(p.updates[0].data).toEqual({});
    expect(p.updates[0].snapshot?.name).toBe("H21");
  });
  it("creates with noTiming false and a null no-timing snapshot when unknown", () => {
    const p = planClassSync({ existing: [], eventor: [ec({ noTiming: undefined })] });
    expect(p.creates[0].data.noTiming).toBe(false);
    expect(p.creates[0].snapshot.no_timing).toBeNull();
  });
  it("lets a later answer set noTiming on a class created without one", () => {
    const snap = { name: "H21", sex: "M", low_age: 0, high_age: 0, no_timing: null, sort_index: 1, class_type: "" };
    const p = planClassSync({ existing: [cls({ noTiming: false, snapshot: snap })], eventor: [ec({ noTiming: true })] });
    expect(p.updates[0].data.noTiming).toBe(true);
  });
});

describe("runnerEventorDiff", () => {
  const local = {
    name: "Mine", cardNo: 777, classEventorId: 11, eventorClubId: null, clubName: "",
    birthYear: 1990, sex: "M", nationality: "SWE",
  };
  it("lists the fields Eventor last said otherwise", () => {
    const d = runnerEventorDiff(local, { ...SNAP, card_no: 5 });
    expect(d.map((x) => x.field)).toEqual(["name", "cardNo", "classId"]);
  });
  it("ignores fields Eventor had no opinion on and a missing snapshot", () => {
    expect(runnerEventorDiff(local, null)).toEqual([]);
    expect(runnerEventorDiff(local, { ...SNAP, name: "Mine", class_eventor_id: null })).toEqual([]);
  });
});
