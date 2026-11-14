/** The device capability check (docs/course-print.md §8.6 "Capability", G16). */

import { describe, expect, it } from "vitest";
import { deviceLimit, printCost } from "../capability";

const sheet = (widthMm: number, heightMm: number, copies?: number) =>
  ({ paper: { widthMm, heightMm }, ...(copies === undefined ? {} : { copies }) }) as never;

describe("deviceLimit", () => {
  it("is 0 without a Worker or under 2 GiB", () => {
    expect(deviceLimit({ worker: false, deviceMemory: 8, coarsePointer: false })).toBe(0);
    expect(deviceLimit({ worker: true, deviceMemory: 1, coarsePointer: false })).toBe(0);
    expect(deviceLimit({ worker: true, deviceMemory: 0.5, coarsePointer: true })).toBe(0);
  });

  it("grows with deviceMemory: 2 → 8, 4 → 24, 8 → 64 A4-equivalents", () => {
    expect(deviceLimit({ worker: true, deviceMemory: 2, coarsePointer: false })).toBe(8);
    expect(deviceLimit({ worker: true, deviceMemory: 4, coarsePointer: false })).toBe(24);
    expect(deviceLimit({ worker: true, deviceMemory: 8, coarsePointer: false })).toBe(64);
  });

  it("without deviceMemory (Safari, Firefox): 8 on a touch device, 24 otherwise", () => {
    expect(deviceLimit({ worker: true, coarsePointer: true })).toBe(8);
    expect(deviceLimit({ worker: true, coarsePointer: false })).toBe(24);
  });
});

describe("printCost", () => {
  it("counts composed pages in A4-equivalents; copies are free, 0 copies is no page", () => {
    expect(printCost({ sheets: [sheet(210, 297)] })).toBe(1);
    expect(printCost({ sheets: [sheet(210, 297, 5)] })).toBe(1);
    expect(printCost({ sheets: [sheet(210, 297, 0)] })).toBe(0);
    expect(printCost({ sheets: [sheet(297, 420), sheet(148, 210)] })).toBeCloseTo(2.5, 2);
  });
});
