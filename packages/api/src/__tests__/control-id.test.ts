/**
 * The control id space (docs/course-layer.md §6.3, F32): a start or finish
 * takes the lowest free code in 3–10, then 11–30, and is shown by its name.
 */

import { describe, expect, it } from "vitest";
import { displayCode, lowestFreeStartCode, publicControlId } from "../control-id.js";

describe("publicControlId", () => {
  it("is the first code, else the seq", () => {
    expect(publicControlId({ codes: "31;131", seq: 4 })).toBe(31);
    expect(publicControlId({ codes: "", seq: 80 })).toBe(80);
    expect(publicControlId({ codes: "3", seq: 80 })).toBe(3);
  });
});

describe("displayCode", () => {
  it("shows a control by its code, then its name, then its seq", () => {
    expect(displayCode({ codes: "31", name: "Kontroll", seq: 1, kind: "control", status: "ok" })).toBe("31");
    expect(displayCode({ codes: "", name: "Passeringspunkt 1", seq: 10_001, kind: "crossing_point" })).toBe("Passeringspunkt 1");
    expect(displayCode({ codes: "", name: "", seq: 7, kind: "control" })).toBe("7");
  });

  it("shows a start or finish by its name although it has a code", () => {
    expect(displayCode({ codes: "3", name: "Start 1", seq: 80, kind: "start" })).toBe("Start 1");
    expect(displayCode({ codes: "4", name: "Mål 1", seq: 81, kind: "finish" })).toBe("Mål 1");
    // The legacy status 4 / 5 on a row whose kind was not rewritten.
    expect(displayCode({ codes: "5", name: "Start 2", seq: 82, kind: "control", status: "start" })).toBe("Start 2");
  });

  it("falls back to the code, then the seq, for a nameless start", () => {
    expect(displayCode({ codes: "3", name: "", seq: 80, kind: "start" })).toBe("3");
    expect(displayCode({ codes: "", name: "", seq: 80, kind: "finish" })).toBe("80");
  });
});

describe("lowestFreeStartCode", () => {
  const range = (lo: number, hi: number) => Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);

  it("starts at 3, skipping 1 (clear) and 2 (check)", () => {
    expect(lowestFreeStartCode(new Set())).toBe(3);
    expect(lowestFreeStartCode(new Set([1, 2, 31, 80]))).toBe(3);
  });

  it("takes the lowest gap", () => {
    expect(lowestFreeStartCode(new Set([3, 4, 6]))).toBe(5);
  });

  it("continues at 11 when 3–10 are held", () => {
    expect(lowestFreeStartCode(new Set(range(3, 10)))).toBe(11);
  });

  it("is null when 3–30 are all held", () => {
    expect(lowestFreeStartCode(new Set(range(3, 30)))).toBeNull();
    expect(lowestFreeStartCode(new Set([...range(3, 29), 31]))).toBe(30);
  });
});
