import { describe, it, expect } from "vitest";
import { applyFilters } from "../filter";
import { createClassAnchors } from "../anchors/class-anchors";
import { createCourseAnchors } from "../anchors/course-anchors";
import { createControlAnchors } from "../anchors/control-anchors";
import { createCardAnchors, type CardListItem } from "../anchors/card-anchors";
import { createTrackAnchors, type TrackRow } from "../anchors/track-anchors";
import { createClubAnchors } from "../anchors/club-anchors";
import { createBackupPunchAnchors, type BackupPunchRow } from "../anchors/backup-punch-anchors";
import { createStartListAnchors } from "../anchors/start-list-anchors";
import { createResultAnchors } from "../anchors/result-anchors";
import type { AnchorDef } from "../types";
import type {
  ClassSummary,
  CourseSummary,
  ControlInfo,
  ClubSummary,
  StartListEntry,
  ResultEntry,
} from "@oxygen/shared";
import { ControlStatus, RunnerStatus } from "@oxygen/shared";

const lbl = (k: string) => k;

// ─── Class anchors ─────────────────────────────────────────
describe("class anchors", () => {
  const anchors = createClassAnchors(lbl) as AnchorDef<ClassSummary>[];
  const classes: ClassSummary[] = [
    {
      id: 1, name: "H21", courseId: 1, courseName: "Lång", courseIds: [1],
      courseNames: ["Lång"], runnerCount: 30, sortIndex: 10, sex: "M",
      lowAge: 0, highAge: 0, freeStart: false, noTiming: false,
      allowQuickEntry: true, classType: "Elite", classFee: 200, maxTime: 0,
    },
    {
      id: 2, name: "D21", courseId: 2, courseName: "Medel", courseIds: [2, 3],
      courseNames: ["Medel-A", "Medel-B"], runnerCount: 18, sortIndex: 20, sex: "F",
      lowAge: 0, highAge: 0, freeStart: true, noTiming: false,
      allowQuickEntry: false, classType: "", classFee: 200, maxTime: 6000,
    },
    {
      id: 3, name: "Öppen 1", courseId: 0, courseName: "", courseIds: [],
      courseNames: [], runnerCount: 0, sortIndex: 30, sex: "",
      lowAge: 0, highAge: 0, freeStart: true, noTiming: true,
      allowQuickEntry: true, classType: "Open", classFee: 0, maxTime: 0,
    },
  ];

  it("filters by name contains", () => {
    const tokens = [{ id: "1", anchor: "name", operator: "contains" as const, value: "21" }];
    expect(applyFilters(classes, tokens, anchors).map((c) => c.id)).toEqual([1, 2]);
  });

  it("filters by sex", () => {
    const tokens = [{ id: "1", anchor: "sex", operator: "eq" as const, value: "men" }];
    expect(applyFilters(classes, tokens, anchors).map((c) => c.id)).toEqual([1]);
  });

  it("filters by runners gte", () => {
    const tokens = [{ id: "1", anchor: "runners", operator: "gte" as const, value: "20" }];
    expect(applyFilters(classes, tokens, anchors).map((c) => c.id)).toEqual([1]);
  });

  it("filters by forked yes", () => {
    const tokens = [{ id: "1", anchor: "forked", operator: "eq" as const, value: "yes" }];
    expect(applyFilters(classes, tokens, anchors).map((c) => c.id)).toEqual([2]);
  });

  it("filters by quickEntry no", () => {
    const tokens = [{ id: "1", anchor: "quickEntry", operator: "eq" as const, value: "no" }];
    expect(applyFilters(classes, tokens, anchors).map((c) => c.id)).toEqual([2]);
  });
});

// ─── Course anchors ────────────────────────────────────────
describe("course anchors", () => {
  const anchors = createCourseAnchors(lbl) as AnchorDef<CourseSummary>[];
  const courses: CourseSummary[] = [
    { id: 1, name: "Lång", controls: "31;42;55", controlCount: 3, length: 5200, climb: 100, numberOfMaps: 30, firstAsStart: false, lastAsFinish: true },
    { id: 2, name: "Medel", controls: "31;42", controlCount: 2, length: 3200, climb: 50, numberOfMaps: 20, firstAsStart: true, lastAsFinish: false },
    { id: 3, name: "Kort", controls: "31", controlCount: 1, length: 1500, climb: 20, numberOfMaps: 5, firstAsStart: true, lastAsFinish: true },
  ];

  it("filters by length in km", () => {
    const tokens = [{ id: "1", anchor: "length", operator: "gte" as const, value: "3" }];
    expect(applyFilters(courses, tokens, anchors).map((c) => c.id)).toEqual([1, 2]);
  });

  it("filters by length in meters", () => {
    const tokens = [{ id: "1", anchor: "length", operator: "lt" as const, value: "2000" }];
    expect(applyFilters(courses, tokens, anchors).map((c) => c.id)).toEqual([3]);
  });

  it("filters by start (firstAsStart) yes", () => {
    const tokens = [{ id: "1", anchor: "start", operator: "eq" as const, value: "yes" }];
    expect(applyFilters(courses, tokens, anchors).map((c) => c.id)).toEqual([2, 3]);
  });

  it("filters by controls eq", () => {
    const tokens = [{ id: "1", anchor: "controls", operator: "eq" as const, value: "2" }];
    expect(applyFilters(courses, tokens, anchors).map((c) => c.id)).toEqual([2]);
  });
});

// ─── Control anchors ───────────────────────────────────────
describe("control anchors", () => {
  const anchors = createControlAnchors(lbl) as AnchorDef<ControlInfo>[];
  const ctrls: ControlInfo[] = [
    {
      id: 31, name: "", codes: "31", status: ControlStatus.OK, timeAdjust: 0, minTime: 0,
      runnerCount: 12,
      config: { radioType: "internal_radio", airPlus: "default", batteryVoltage: 2.6, batteryLow: false, checkedAt: "2026-04-01T10:00:00Z", memoryClearedAt: null },
      units: [],
    },
    {
      id: 42, name: "Radio 1", codes: "42", status: ControlStatus.OK, timeAdjust: 0, minTime: 0,
      runnerCount: 5,
      config: { radioType: "public_radio", airPlus: "default", batteryVoltage: 2.4, batteryLow: true, checkedAt: null, memoryClearedAt: null },
      units: [],
    },
    {
      id: 55, name: "Mål", codes: "55", status: ControlStatus.Finish, timeAdjust: 0, minTime: 0,
      runnerCount: 0, config: null, units: [],
    },
    {
      id: 60, name: "", codes: "60", status: ControlStatus.OK, timeAdjust: 0, minTime: 0,
      runnerCount: 8,
      config: { radioType: "normal", airPlus: "default", batteryVoltage: 3.0, batteryLow: false, checkedAt: "2026-04-02T10:00:00Z", memoryClearedAt: null },
      units: [],
    },
  ];

  it("filters by code eq matches id or codes", () => {
    const tokens = [{ id: "1", anchor: "code", operator: "eq" as const, value: "42" }];
    expect(applyFilters(ctrls, tokens, anchors).map((c) => c.id)).toEqual([42]);
  });

  it("filters by status finish", () => {
    const tokens = [{ id: "1", anchor: "status", operator: "eq" as const, value: "finish" }];
    expect(applyFilters(ctrls, tokens, anchors).map((c) => c.id)).toEqual([55]);
  });

  it("filters by radio internal", () => {
    const tokens = [{ id: "1", anchor: "radio", operator: "eq" as const, value: "internal" }];
    expect(applyFilters(ctrls, tokens, anchors).map((c) => c.id)).toEqual([31]);
  });

  it("filters by battery low", () => {
    const tokens = [{ id: "1", anchor: "battery", operator: "eq" as const, value: "low" }];
    expect(applyFilters(ctrls, tokens, anchors).map((c) => c.id)).toEqual([42]);
  });

  it("filters by battery ok", () => {
    const tokens = [{ id: "1", anchor: "battery", operator: "eq" as const, value: "ok" }];
    expect(applyFilters(ctrls, tokens, anchors).map((c) => c.id)).toEqual([60]);
  });

  it("filters by checked yes", () => {
    const tokens = [{ id: "1", anchor: "checked", operator: "eq" as const, value: "yes" }];
    expect(applyFilters(ctrls, tokens, anchors).map((c) => c.id)).toEqual([31, 60]);
  });
});

// ─── Card anchors ──────────────────────────────────────────
describe("card anchors", () => {
  const anchors = createCardAnchors(lbl) as AnchorDef<CardListItem>[];
  const cards: CardListItem[] = [
    {
      id: 1, cardNo: 8001234, cardType: "SIAC", voltage: 200, batteryVoltage: 2.45,
      punchCount: 12, hasPunches: true, modified: "2026-04-25",
      runner: { id: 1, name: "A", clubName: "Skog", clubId: 1, className: "H21", status: 1, isRentalCard: true, cardReturned: false },
    },
    {
      id: 2, cardNo: 500123, cardType: "SI6", voltage: 0, batteryVoltage: null,
      punchCount: 0, hasPunches: false, modified: "2026-04-25",
      runner: null,
    },
    {
      id: 3, cardNo: 2345678, cardType: "SI8", voltage: 0, batteryVoltage: null,
      punchCount: 5, hasPunches: true, modified: "2026-04-25",
      runner: { id: 3, name: "C", clubName: "OK", clubId: 2, className: "D21", status: 0, isRentalCard: true, cardReturned: true },
    },
  ];

  it("filters by type SIAC", () => {
    const tokens = [{ id: "1", anchor: "type", operator: "eq" as const, value: "siac" }];
    expect(applyFilters(cards, tokens, anchors).map((c) => c.id)).toEqual([1]);
  });

  it("filters by linked no", () => {
    const tokens = [{ id: "1", anchor: "linked", operator: "eq" as const, value: "no" }];
    expect(applyFilters(cards, tokens, anchors).map((c) => c.id)).toEqual([2]);
  });

  it("filters by rental yes", () => {
    const tokens = [{ id: "1", anchor: "rental", operator: "eq" as const, value: "yes" }];
    expect(applyFilters(cards, tokens, anchors).map((c) => c.id)).toEqual([1, 3]);
  });

  it("filters by returned no (only rentals)", () => {
    const tokens = [{ id: "1", anchor: "returned", operator: "eq" as const, value: "no" }];
    expect(applyFilters(cards, tokens, anchors).map((c) => c.id)).toEqual([1]);
  });

  it("filters by punches > 0", () => {
    const tokens = [{ id: "1", anchor: "punches", operator: "gt" as const, value: "0" }];
    expect(applyFilters(cards, tokens, anchors).map((c) => c.id)).toEqual([1, 3]);
  });

  it("filters by battery low (siac)", () => {
    const tokens = [{ id: "1", anchor: "battery", operator: "eq" as const, value: "low" }];
    expect(applyFilters(cards, tokens, anchors).map((c) => c.id)).toEqual([1]);
  });

  it("filters by battery missing", () => {
    const tokens = [{ id: "1", anchor: "battery", operator: "eq" as const, value: "missing" }];
    expect(applyFilters(cards, tokens, anchors).map((c) => c.id)).toEqual([2, 3]);
  });
});

// ─── Track anchors ─────────────────────────────────────────
describe("track anchors", () => {
  const anchors = createTrackAnchors(lbl) as AnchorDef<TrackRow>[];
  const rows: TrackRow[] = [
    {
      id: 1, runnerId: 1, runnerName: "Anna", organisation: "OK Skog", classId: 1, className: "H21",
      liveloxClassId: 100, color: "#e6194b", raceStartMs: 0,
      result: { status: "ok", timeMs: 1800000 }, syncedAt: "2026-04-25",
    },
    {
      id: 2, runnerId: 2, runnerName: "Erik", organisation: "IF Linné", classId: 2, className: "D21",
      liveloxClassId: 101, color: "#ff0", raceStartMs: 0,
      result: { status: "mp", timeMs: 2400000 }, syncedAt: "2026-04-25",
    },
    {
      id: 3, runnerId: 3, runnerName: "Lisa", organisation: "OK Skog", classId: 1, className: "H21",
      liveloxClassId: 100, color: "#0f0", raceStartMs: 0,
      result: null, syncedAt: "2026-04-25",
    },
  ];

  it("filters by status ok", () => {
    const tokens = [{ id: "1", anchor: "status", operator: "eq" as const, value: "ok" }];
    expect(applyFilters(rows, tokens, anchors).map((r) => r.id)).toEqual([1]);
  });

  it("filters by class H21", () => {
    const tokens = [{ id: "1", anchor: "class", operator: "eq" as const, value: "H21" }];
    expect(applyFilters(rows, tokens, anchors).map((r) => r.id)).toEqual([1, 3]);
  });

  it("filters by time lt 35:00", () => {
    const tokens = [{ id: "1", anchor: "time", operator: "lt" as const, value: "35:00" }];
    expect(applyFilters(rows, tokens, anchors).map((r) => r.id)).toEqual([1]);
  });

  it("filters by club contains", () => {
    const tokens = [{ id: "1", anchor: "club", operator: "contains" as const, value: "Skog" }];
    expect(applyFilters(rows, tokens, anchors).map((r) => r.id)).toEqual([1, 3]);
  });
});

// ─── Club anchors ──────────────────────────────────────────
describe("club anchors", () => {
  const anchors = createClubAnchors(lbl) as AnchorDef<ClubSummary>[];
  const clubs: ClubSummary[] = [
    { id: 1, name: "OK Skog", shortName: "Skog", runnerCount: 12, extId: 100 },
    { id: 2, name: "IF Linné", shortName: "Linné", runnerCount: 0, extId: 0 },
    { id: 3, name: "Halmstad SOK", shortName: "HSOK", runnerCount: 4, extId: 250 },
  ];

  it("filters by eventor yes", () => {
    const tokens = [{ id: "1", anchor: "eventor", operator: "eq" as const, value: "yes" }];
    expect(applyFilters(clubs, tokens, anchors).map((c) => c.id)).toEqual([1, 3]);
  });

  it("filters by runners gte 5", () => {
    const tokens = [{ id: "1", anchor: "runners", operator: "gte" as const, value: "5" }];
    expect(applyFilters(clubs, tokens, anchors).map((c) => c.id)).toEqual([1]);
  });

  it("filters by shortName contains", () => {
    const tokens = [{ id: "1", anchor: "shortName", operator: "contains" as const, value: "ok" }];
    expect(applyFilters(clubs, tokens, anchors).map((c) => c.id)).toEqual([3]);
  });
});

// ─── Backup punch anchors ──────────────────────────────────
describe("backup punch anchors", () => {
  const anchors = createBackupPunchAnchors(lbl) as AnchorDef<BackupPunchRow>[];
  const rows: BackupPunchRow[] = [
    {
      id: 1, controlId: 31, controlCodes: "31", controlName: "", cardNo: 12345,
      punchTime: 0, punchDatetime: null, subSecond: null, stationSerial: null,
      importedAt: "2026-04-25", pushedToPunch: false, runnerName: "Anna",
      runnerId: 1, runnerStatus: 0, registeredTime: 36000, matchStatus: "matched",
    },
    {
      id: 2, controlId: 42, controlCodes: "42", controlName: "Radio", cardNo: 67890,
      punchTime: 0, punchDatetime: null, subSecond: null, stationSerial: null,
      importedAt: "2026-04-25", pushedToPunch: false, runnerName: null,
      runnerId: null, runnerStatus: null, registeredTime: null, matchStatus: "no_runner",
    },
    {
      id: 3, controlId: 31, controlCodes: "31", controlName: "", cardNo: 11111,
      punchTime: 0, punchDatetime: null, subSecond: null, stationSerial: null,
      importedAt: "2026-04-25", pushedToPunch: true, runnerName: "Erik",
      runnerId: 2, runnerStatus: 0, registeredTime: null, matchStatus: "time_mismatch",
    },
  ];

  it("filters by match anomalies", () => {
    const tokens = [{ id: "1", anchor: "match", operator: "eq" as const, value: "anomalies" }];
    expect(applyFilters(rows, tokens, anchors).map((r) => r.id)).toEqual([2, 3]);
  });

  it("filters by match matched", () => {
    const tokens = [{ id: "1", anchor: "match", operator: "eq" as const, value: "matched" }];
    expect(applyFilters(rows, tokens, anchors).map((r) => r.id)).toEqual([1]);
  });

  it("filters by control 42", () => {
    const tokens = [{ id: "1", anchor: "control", operator: "eq" as const, value: "42" }];
    expect(applyFilters(rows, tokens, anchors).map((r) => r.id)).toEqual([2]);
  });

  it("filters by pushed yes", () => {
    const tokens = [{ id: "1", anchor: "pushed", operator: "eq" as const, value: "yes" }];
    expect(applyFilters(rows, tokens, anchors).map((r) => r.id)).toEqual([3]);
  });

  it("filters by card eq", () => {
    const tokens = [{ id: "1", anchor: "card", operator: "eq" as const, value: "67890" }];
    expect(applyFilters(rows, tokens, anchors).map((r) => r.id)).toEqual([2]);
  });
});

// ─── Start list anchors ────────────────────────────────────
describe("start list anchors", () => {
  const anchors = createStartListAnchors(lbl) as AnchorDef<StartListEntry>[];
  const entries: StartListEntry[] = [
    {
      id: 1, startNo: 1, name: "Anna", clubId: 1, clubName: "OK Skog",
      className: "H21", classId: 1, startTime: 36000, cardNo: 8001234, bib: "1",
      hasPunches: false, hasStarted: false,
    },
    {
      id: 2, startNo: 2, name: "Erik", clubId: 2, clubName: "IF Linné",
      className: "D21", classId: 2, startTime: 0, cardNo: 0, bib: "2",
      hasPunches: false, hasStarted: false,
    },
    {
      id: 3, startNo: 3, name: "Lisa", clubId: 1, clubName: "OK Skog",
      className: "H21", classId: 1, startTime: 37000, cardNo: 12345, bib: "3",
      hasPunches: true, hasStarted: true,
    },
  ];

  it("filters by club", () => {
    const tokens = [{ id: "1", anchor: "club", operator: "eq" as const, value: "OK Skog" }];
    expect(applyFilters(entries, tokens, anchors).map((e) => e.id)).toEqual([1, 3]);
  });

  it("filters by start assigned", () => {
    const tokens = [{ id: "1", anchor: "start", operator: "eq" as const, value: "assigned" }];
    expect(applyFilters(entries, tokens, anchors).map((e) => e.id)).toEqual([1, 3]);
  });

  it("filters by start in-forest", () => {
    const tokens = [{ id: "1", anchor: "start", operator: "eq" as const, value: "in-forest" }];
    expect(applyFilters(entries, tokens, anchors).map((e) => e.id)).toEqual([3]);
  });
});

// ─── Result anchors ────────────────────────────────────────
describe("result anchors", () => {
  const anchors = createResultAnchors(lbl) as AnchorDef<ResultEntry>[];
  const entries: ResultEntry[] = [
    {
      id: 1, place: 1, name: "Anna", clubId: 1, clubName: "OK Skog",
      className: "H21", classId: 1, startTime: 36000, finishTime: 39600,
      runningTime: 3600, timeBehind: 0, status: RunnerStatus.OK, startNo: 1,
      hasPunches: true, hasStarted: true,
    },
    {
      id: 2, place: 2, name: "Erik", clubId: 2, clubName: "IF Linné",
      className: "H21", classId: 1, startTime: 36100, finishTime: 39900,
      runningTime: 3800, timeBehind: 200, status: RunnerStatus.OK, startNo: 2,
      hasPunches: true, hasStarted: true,
    },
    {
      id: 3, place: 0, name: "Lisa", clubId: 1, clubName: "OK Skog",
      className: "H21", classId: 1, startTime: 36200, finishTime: 0,
      runningTime: 0, timeBehind: 0, status: RunnerStatus.MissingPunch, startNo: 3,
      hasPunches: true, hasStarted: true,
    },
  ];

  it("filters by status mp", () => {
    const tokens = [{ id: "1", anchor: "status", operator: "eq" as const, value: "mp" }];
    expect(applyFilters(entries, tokens, anchors).map((e) => e.id)).toEqual([3]);
  });

  it("filters by status finished", () => {
    const tokens = [{ id: "1", anchor: "status", operator: "eq" as const, value: "finished" }];
    expect(applyFilters(entries, tokens, anchors).map((e) => e.id)).toEqual([1, 2, 3]);
  });

  it("filters by place lte 1", () => {
    const tokens = [{ id: "1", anchor: "place", operator: "lte" as const, value: "1" }];
    expect(applyFilters(entries, tokens, anchors).map((e) => e.id)).toEqual([1]);
  });

  it("filters by time lt 6:10 (m:ss)", () => {
    const tokens = [{ id: "1", anchor: "time", operator: "lt" as const, value: "6:10" }];
    expect(applyFilters(entries, tokens, anchors).map((e) => e.id)).toEqual([1]);
  });
});
