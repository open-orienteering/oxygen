/**
 * Pin the leg-length string parser used by `performReadout` to convert
 * `Course.legs` (semicolon-separated string written by the OCAD / IOF
 * importer) into the `number[]` consumed by the kiosk receipt.
 *
 * Tests double as documentation of the corner cases:
 *   - empty / null / undefined input
 *   - trailing semicolons (the importer always appends one)
 *   - non-numeric chunks
 *   - mixed whitespace and negative numbers
 */

import { describe, it, expect } from "vitest";
import { parseLegsString } from "../routers/cardReadout.js";

describe("parseLegsString", () => {
  it("returns an empty array for null / undefined / empty input", () => {
    expect(parseLegsString(null)).toEqual([]);
    expect(parseLegsString(undefined)).toEqual([]);
    expect(parseLegsString("")).toEqual([]);
  });

  it("parses the importer's standard trailing-semicolon shape", () => {
    expect(parseLegsString("420;310;180;240;")).toEqual([420, 310, 180, 240]);
  });

  it("handles no trailing semicolon", () => {
    expect(parseLegsString("100;200;300")).toEqual([100, 200, 300]);
  });

  it("treats non-numeric chunks as 0", () => {
    expect(parseLegsString("100;abc;200;")).toEqual([100, 0, 200]);
  });

  it("clamps negative numbers to 0", () => {
    expect(parseLegsString("100;-50;200;")).toEqual([100, 0, 200]);
  });

  it("strips empty chunks between semicolons", () => {
    expect(parseLegsString(";;100;;200;;")).toEqual([100, 200]);
  });

  it("returns the parsed values exactly in input order", () => {
    expect(parseLegsString("1;2;3;4;5;")).toEqual([1, 2, 3, 4, 5]);
  });
});
