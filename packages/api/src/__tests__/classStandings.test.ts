import { describe, it, expect } from "vitest";
import { compareStandings, type StandingRow } from "../classStandings.js";
import { progressFlags } from "../runnerProgress.js";

const row = (over: Partial<StandingRow> & { name: string; classId?: string | null; seq?: number }): StandingRow => ({
  runner: {
    id: over.name,
    seq: over.seq ?? 1,
    name: over.name,
    clubName: "",
    eventorClubId: null,
    startNo: 0,
    cardNo: null,
    startTime: 0,
    classId: over.classId === undefined ? "c1" : over.classId,
  },
  classSeq: 1,
  className: "H21",
  classSortIndex: 0,
  noTiming: false,
  status: 1,
  startAbs: 0,
  finishAbs: 0,
  runningTimeAdjustment: 0,
  runningTime: 0,
  place: 0,
  timeBehind: 0,
  ...over,
});

describe("compareStandings", () => {
  it("orders by class, then placed, timed unplaced, the rest; names break ties", () => {
    const rows = [
      row({ name: "Mp", status: 3 }),
      row({ name: "Nowhere", classId: null, place: 0, runningTime: 100 }),
      row({ name: "Bo", place: 1, runningTime: 500 }),
      row({ name: "Oc", status: 15, runningTime: 400 }),
      row({ name: "Ada", place: 1, runningTime: 500 }),
      row({ name: "Carl", place: 3, runningTime: 600 }),
      row({ name: "D21", className: "D21", classSortIndex: -1, classId: "c0", place: 1, runningTime: 900 }),
    ];
    expect(rows.sort(compareStandings).map((r) => r.runner.name)).toEqual([
      "D21", "Ada", "Bo", "Carl", "Oc", "Mp", "Nowhere",
    ]);
  });
});

describe("progressFlags", () => {
  const zero = 324000;
  it("sets hasPunches for a punched card and hasStarted once the start time passed", () => {
    expect(progressFlags({ cardNo: 5, startTime: 36000 }, new Set([5]), zero, 370000)).toEqual({ hasPunches: true, hasStarted: true });
    expect(progressFlags({ cardNo: 6, startTime: 36000 }, new Set([5]), zero, 350000)).toEqual({});
    expect(progressFlags({ cardNo: null, startTime: 0 }, new Set([5]), zero, 370000)).toEqual({});
  });
});
