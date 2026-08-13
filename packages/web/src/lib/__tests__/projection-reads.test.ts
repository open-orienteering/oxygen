import { describe, it, expect } from "vitest";
import {
  selectLookupByCard,
  selectRecentActivity,
} from "../offline/projection-reads";
import type { ProjRunner } from "../offline/db";
import type { ClassInfo, CourseInfo } from "@oxygen/shared";

const runner = (p: Partial<ProjRunner> & { id: string; cardNo: number | null }): ProjRunner => ({
  competitionId: "c",
  seq: 1,
  name: "R",
  startNo: 0,
  classId: 1,
  clubName: "",
  eventorClubId: null,
  startTime: 0,
  finishTime: 0,
  status: 0,
  ...p,
});
const cls = (id: number, p: Partial<ClassInfo> = {}): ClassInfo =>
  ({ id, name: `C${id}`, courseId: id, sortIndex: 0, sex: "", lowAge: 0, highAge: 0, ...p }) as ClassInfo;
const course = (id: number, p: Partial<CourseInfo> = {}): CourseInfo =>
  ({ id, name: `Crs${id}`, length: 0, controls: "", controlCount: 0, expectedPositions: [], ...p }) as CourseInfo;

describe("selectLookupByCard", () => {
  it("returns found:false for an unknown card", () => {
    expect(selectLookupByCard(999, [], [], [])).toEqual({ found: false, cardNo: 999 });
  });

  it("joins runner → class → course and carries freeStart/noTiming", () => {
    const runners = [
      runner({ id: "card:100", cardNo: 100, seq: 5, name: "Alice", classId: 2, startNo: 4, startTime: 360000, finishTime: 366000, status: 3 }),
    ];
    const classes = [cls(2, { name: "H21", courseId: 7, freeStart: true, noTiming: false })];
    const courses = [course(7, { name: "Long", length: 5200, controlCount: 12 })];
    const res = selectLookupByCard(100, runners, classes, courses);
    expect(res.found).toBe(true);
    if (!res.found) return;
    expect(res.runner).toMatchObject({
      id: 5,
      name: "Alice",
      className: "H21",
      startNo: 4,
      courseName: "Long",
      courseControlCount: 12,
      freeStart: true,
      classFreeStart: true,
      noTiming: false,
      status: 3,
      startTime: 360000,
      finishTime: 366000,
    });
    expect(res.course).toEqual({ id: 7, name: "Long", length: 5200, controlCount: 12 });
  });
});

describe("selectRecentActivity", () => {
  it("returns finishers ordered by finishTime desc, with class name + running time", () => {
    const runners = [
      runner({ id: "card:1", cardNo: 1, seq: 1, name: "A", classId: 2, startTime: 360000, finishTime: 366000 }),
      runner({ id: "card:2", cardNo: 2, seq: 2, name: "B", classId: 2, startTime: 360000, finishTime: 368000 }),
      runner({ id: "card:3", cardNo: 3, seq: 3, name: "C", classId: 2, finishTime: 0 }), // not finished
    ];
    const classes = [cls(2, { name: "H21" })];
    const out = selectRecentActivity(runners, classes, 10);
    expect(out.map((r) => r.name)).toEqual(["B", "A"]); // desc by finishTime; C excluded
    expect(out[0]).toMatchObject({ className: "H21", runningTime: 8000 });
  });
});
