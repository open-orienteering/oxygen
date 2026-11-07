/**
 * Offline readout reads the runner's own course (her variant) before her
 * class's (slice F, row F6b; docs/course-controls-and-matching.md "Forked
 * courses and variants", "Read paths" §2).
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

function client(runners: ReturnType<typeof runner>[]): QueryClient {
  const qc = new QueryClient();
  qc.setQueryData([["competition", "dashboard"], { type: "query" }], dashboard);
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
