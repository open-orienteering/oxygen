/**
 * Unit tests for the pure half of the draw engine (`computeDraw`): the
 * applied draw is the previewed draw (RES-15), start numbers continue after
 * the ones the draw keeps (RES-17), and late entries are appended after the
 * class's kept starts.
 */
import { describe, it, expect } from "vitest";
import type { ClassDrawConfig, DrawSettings } from "@oxygen/shared";
import { computeDraw, type ClassData, type DrawInputs } from "../drawEngine.js";

const TEN = 360_000;
const MIN = 600;

function klass(seq: number, n: number, over: Partial<ClassData> = {}): ClassData {
  return {
    classSeq: seq,
    classUuid: `class-${seq}`,
    className: `C${seq}`,
    courseSeq: seq,
    courseUuid: null,
    courseName: "",
    initialControls: [],
    runners: Array.from({ length: n }, (_, i) => ({
      id: `r-${seq}-${i}`,
      seq: seq * 100 + i,
      cardNo: null,
      name: `R${i}`,
      clubId: i % 3,
      clubName: `Club ${i % 3}`,
      startNo: 0,
      startTime: 0,
      rank: 0,
    })),
    skippedStarted: 0,
    keptStarts: [],
    ...over,
  };
}

const settings: DrawSettings = {
  firstStart: TEN,
  baseInterval: MIN,
  maxParallelStarts: 2,
  detectCourseOverlap: false,
};

function inputs(classes: ClassData[], maxKeptStartNo = 0): DrawInputs {
  return { classes, warnings: [], maxKeptStartNo };
}

const configs = (seqs: number[]): ClassDrawConfig[] =>
  seqs.map((classId) => ({ classId, method: "random", interval: 2 * MIN }));

describe("computeDraw", () => {
  it("gives the same draw and token for the same seed", () => {
    const a = computeDraw(inputs([klass(1, 20), klass(2, 15)]), configs([1, 2]), settings, 42);
    const b = computeDraw(inputs([klass(1, 20), klass(2, 15)]), configs([1, 2]), settings, 42);
    expect(b.classes).toEqual(a.classes);
    expect(b.previewToken).toBe(a.previewToken);
    expect(a.seed).toBe(42);
  });

  it("gives a different order and token for another seed", () => {
    const a = computeDraw(inputs([klass(1, 20)]), configs([1]), settings, 1);
    const b = computeDraw(inputs([klass(1, 20)]), configs([1]), settings, 2);
    expect(b.classes[0].entries.map((e) => e.runnerId)).not.toEqual(
      a.classes[0].entries.map((e) => e.runnerId),
    );
    expect(b.previewToken).not.toBe(a.previewToken);
  });

  it("changes the token when a runner is added", () => {
    const a = computeDraw(inputs([klass(1, 10)]), configs([1]), settings, 7);
    const b = computeDraw(inputs([klass(1, 11)]), configs([1]), settings, 7);
    expect(b.previewToken).not.toBe(a.previewToken);
  });

  it("does not reshuffle a class when another class is added to the selection", () => {
    const one = computeDraw(inputs([klass(1, 20)]), configs([1]), settings, 9);
    const two = computeDraw(inputs([klass(1, 20), klass(2, 5)]), configs([1, 2]), settings, 9);
    const order = (r: typeof one) =>
      r.classes.find((c) => c.classId === 1)!.entries.map((e) => e.runnerId);
    expect(order(two)).toEqual(order(one));
  });

  it("continues start numbers after the highest kept number", () => {
    const res = computeDraw(inputs([klass(1, 3), klass(2, 2)], 40), configs([1, 2]), settings, 3);
    const nos = res.classes.flatMap((c) => c.entries.map((e) => e.startNo)).sort((a, b) => a - b);
    expect(nos).toEqual([41, 42, 43, 44, 45]);
  });

  it("appends late entries after the class's last kept start", () => {
    const cls = klass(1, 2, { keptStarts: [TEN, TEN + 2 * MIN, TEN + 4 * MIN] });
    const res = computeDraw(inputs([cls]), configs([1]), settings, 5, {
      mode: "onlyMissing",
      force: false,
    });
    expect(res.classes[0].entries.map((e) => e.startTime)).toEqual([
      TEN + 6 * MIN,
      TEN + 8 * MIN,
    ]);
    expect(res.classes[0].writesClass).toBe(false);
  });

  it("counts drawn runners whose start time is replaced", () => {
    const cls = klass(1, 3);
    cls.runners[0].startTime = TEN;
    cls.runners[2].startTime = TEN + MIN;
    const res = computeDraw(inputs([cls]), configs([1]), settings, 5);
    expect(res.classes[0].replaced).toBe(2);
    expect(res.replaced).toBe(2);
  });

  it("warns when a drawn slot lands on a kept start in the same class", () => {
    const cls = klass(1, 3, { keptStarts: [TEN + 2 * MIN], skippedStarted: 1 });
    const res = computeDraw(inputs([cls]), configs([1]), settings, 5);
    expect(res.skippedStarted).toBe(1);
    expect(res.warnings.some((w) => w.includes("same time as a runner who keeps"))).toBe(true);
  });

  it("turns first-control conflicts into warnings", () => {
    const a = klass(1, 5, { initialControls: [31] });
    const b = klass(2, 5, { initialControls: [31] });
    const cfg: ClassDrawConfig[] = [
      { classId: 1, method: "random", interval: 2 * MIN, firstStart: TEN },
      { classId: 2, method: "random", interval: 2 * MIN, firstStart: TEN },
    ];
    const res = computeDraw(inputs([a, b]), cfg, { ...settings, detectCourseOverlap: true }, 1);
    expect(res.warnings).toContain(
      `"C1" and "C2" send 5 pairs of runners to control 31 less than 1:00 apart`,
    );
  });
});
