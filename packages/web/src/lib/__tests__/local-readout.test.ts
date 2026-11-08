/**
 * Offline readout reads the runner's own course (her variant) before her
 * class's (slice F, row F6b; docs/course-controls-and-matching.md "Forked
 * courses and variants", "Read paths" §2), and names the other pooled
 * variant a mispunched run matches fully (F6c, the red exit).
 */

import { describe, it, expect } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { computeCardReadout, courseOf } from "../offline/local-readout";
import { RunnerStatus } from "@oxygen/shared";

const pos = (code: number) => ({ codes: [code], skipMatching: false, noTimingLeg: false });
const course = (id: number, name: string, codes: number[]) => ({
  id,
  name,
  length: 1000,
  controls: "",
  orderMode: "ordered" as const,
  expectedPositions: codes.map(pos),
});
// The root (first alternatives) is 31 32 34; variant A the same, B 31 33 34.
const dashboard = {
  classes: [{ id: 1, name: "H21", courseId: 10 }],
  courses: [course(10, "Long", [31, 32, 34]), course(11, "Long A", [31, 32, 34]), course(12, "Long B", [31, 33, 34])],
};
const runner = (id: number, cardNo: number, courseId?: number) => ({
  id,
  name: `R${id}`,
  cardNo,
  classId: 1,
  status: 0,
  startTime: 0,
  finishTime: 0,
  ...(courseId !== undefined ? { courseId } : {}),
});

// The same event with the class's pool on the dashboard (A = 11, B = 12).
const pooled = {
  classes: [{ id: 1, name: "H21", courseId: 10, coursePoolIds: [11, 12] }],
  courses: dashboard.courses.map((c) => ({ ...c, variantKey: c.id === 11 ? "A" : c.id === 12 ? "B" : null })),
};

function client(runners: ReturnType<typeof runner>[], dash: object = dashboard): QueryClient {
  const qc = new QueryClient();
  qc.setQueryData([["competition", "dashboard"], { type: "query" }], dash);
  qc.setQueryData([["runner", "list"], { type: "query" }], runners);
  return qc;
}

const bPunches = {
  startTime: 36000,
  finishTime: 39600,
  punches: [
    { controlCode: 31, time: 36600 },
    { controlCode: 33, time: 37200 },
    { controlCode: 34, time: 37800 },
  ],
};

describe("courseOf", () => {
  it("takes the runner's course before the class's; 0 / absent means the class's", () => {
    expect(courseOf({ courseId: 12 }, { courseId: 10 }, dashboard)?.name).toBe("Long B");
    expect(courseOf({ courseId: 0 }, { courseId: 10 }, dashboard)?.name).toBe("Long");
    expect(courseOf({}, { courseId: 10 }, dashboard)?.name).toBe("Long");
    expect(courseOf({}, undefined, dashboard)).toBeNull();
  });
});

describe("computeCardReadout with variants", () => {
  it("a runner on B with B's punches is OK on Long B", () => {
    const r = computeCardReadout({ cardNo: 500, ...bPunches }, client([runner(1, 500, 12)]))!;
    expect(r.course?.name).toBe("Long B");
    expect(r.timing.status).toBe(RunnerStatus.OK);
  });

  it("a runner on A with B's punches is a mispunch: her own variant only", () => {
    const r = computeCardReadout({ cardNo: 501, ...bPunches }, client([runner(2, 501, 11)]))!;
    expect(r.course?.name).toBe("Long A");
    expect(r.timing.status).toBe(RunnerStatus.MissingPunch);
  });

  it("a runner without a course of her own is matched against the class's", () => {
    const r = computeCardReadout({ cardNo: 502, ...bPunches }, client([runner(3, 502)]))!;
    expect(r.course?.name).toBe("Long");
  });
});

describe("computeCardReadout: another variant matched (F6c)", () => {
  it("a runner on A with B's punches is MP and names B", () => {
    const r = computeCardReadout({ cardNo: 510, ...bPunches }, client([runner(4, 510, 11)], pooled))!;
    expect(r.timing.status).toBe(RunnerStatus.MissingPunch);
    expect(r.otherVariantMatches).toEqual([{ courseId: 12, variantKey: "B", courseName: "Long B" }]);
  });

  it("names nothing for an OK run or a class without coursePoolIds", () => {
    const ok = computeCardReadout({ cardNo: 511, ...bPunches }, client([runner(5, 511, 12)], pooled))!;
    expect(ok.otherVariantMatches).toEqual([]);
    const plain = computeCardReadout({ cardNo: 512, ...bPunches }, client([runner(6, 512, 11)]))!;
    expect(plain.otherVariantMatches).toEqual([]);
  });
});
