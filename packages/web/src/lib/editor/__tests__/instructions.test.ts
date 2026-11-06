import { describe, it, expect } from "vitest";
import {
  addSpecial,
  instructionsOnCourse,
  normaliseInstructions,
  parseLengthM,
  removeSpecial,
  setFinish,
  updateSpecial,
} from "../instructions";

describe("description instructions edits (docs/course-editor.md §4)", () => {
  it("sets the finish variant, keeping the length", () => {
    expect(setFinish(null, { kind: "14.1" })).toEqual({ finish: { kind: "14.1" } });
    expect(setFinish({ finish: { kind: "14.1", lengthM: 80 } }, { kind: "14.2" })).toEqual({ finish: { kind: "14.2", lengthM: 80 } });
  });

  it("sets and clears the finish length; the variant defaults to 14.3 (the sheet's default)", () => {
    expect(setFinish(null, { lengthM: 120 })).toEqual({ finish: { kind: "14.3", lengthM: 120 } });
    expect(setFinish({ finish: { kind: "14.1", lengthM: 120 } }, { lengthM: null })).toEqual({ finish: { kind: "14.1" } });
  });

  it("keeps the specials when the finish changes", () => {
    const prev = { specials: [{ afterControlId: null, kind: "13.1" }] };
    expect(setFinish(prev, { kind: "14.2" })).toEqual({ specials: [{ afterControlId: null, kind: "13.1" }], finish: { kind: "14.2" } });
  });

  it("adds a special (13.1 by default) after the given anchor, at the end", () => {
    expect(addSpecial(null, null)).toEqual({ specials: [{ afterControlId: null, kind: "13.1" }] });
    const prev = { specials: [{ afterControlId: null, kind: "13.2" }], finish: { kind: "14.1" } };
    expect(addSpecial(prev, 31)).toEqual({
      specials: [{ afterControlId: null, kind: "13.2" }, { afterControlId: 31, kind: "13.1" }],
      finish: { kind: "14.1" },
    });
  });

  it("updates one special's anchor, kind or length", () => {
    const prev = { specials: [{ afterControlId: null, kind: "13.1" }, { afterControlId: 31, kind: "13.2", lengthM: 40 }] };
    expect(updateSpecial(prev, 1, { afterControlId: null })!.specials![1]).toEqual({ afterControlId: null, kind: "13.2", lengthM: 40 });
    expect(updateSpecial(prev, 0, { kind: "13.6" })!.specials![0]).toEqual({ afterControlId: null, kind: "13.6" });
    expect(updateSpecial(prev, 0, { lengthM: 60 })!.specials![0]).toEqual({ afterControlId: null, kind: "13.1", lengthM: 60 });
    expect(updateSpecial(prev, 1, { lengthM: null })!.specials![1]).toEqual({ afterControlId: 31, kind: "13.2" });
    // Out of range: unchanged.
    expect(updateSpecial(prev, 5, { kind: "13.6" })).toEqual(prev);
  });

  it("removes a special; nothing left is null (the column is cleared)", () => {
    const prev = { specials: [{ afterControlId: null, kind: "13.1" }, { afterControlId: 31, kind: "13.2" }] };
    expect(removeSpecial(prev, 0)).toEqual({ specials: [{ afterControlId: 31, kind: "13.2" }] });
    expect(removeSpecial({ specials: [{ afterControlId: null, kind: "13.1" }] }, 0)).toBeNull();
    expect(removeSpecial({ specials: [{ afterControlId: null, kind: "13.1" }], finish: { kind: "14.1" } }, 0)).toEqual({ finish: { kind: "14.1" } });
  });

  it("normalises: lengths that are not positive go, metres are whole, empty is null", () => {
    expect(normaliseInstructions({})).toBeNull();
    expect(normaliseInstructions({ specials: [] })).toBeNull();
    expect(normaliseInstructions({ finish: { kind: "14.1", lengthM: 0 } })).toEqual({ finish: { kind: "14.1" } });
    expect(normaliseInstructions({ finish: { kind: "14.1", lengthM: Number.NaN } })).toEqual({ finish: { kind: "14.1" } });
    expect(normaliseInstructions({ specials: [{ afterControlId: 31, kind: "13.1", lengthM: 59.6 }] })).toEqual({ specials: [{ afterControlId: 31, kind: "13.1", lengthM: 60 }] });
  });

  it("shows only the specials anchored on the course (the sheet drops the others; setStructure prunes them)", () => {
    const stored = { specials: [{ afterControlId: null, kind: "13.1" }, { afterControlId: 99, kind: "13.2" }, { afterControlId: 31, kind: "13.3" }], finish: { kind: "14.2" } };
    expect(instructionsOnCourse(stored, [31, 32])).toEqual({
      specials: [{ afterControlId: null, kind: "13.1" }, { afterControlId: 31, kind: "13.3" }],
      finish: { kind: "14.2" },
    });
    expect(instructionsOnCourse(null, [31])).toBeNull();
  });

  it("parses a length field: blank or not a positive number is unset", () => {
    expect(parseLengthM("")).toBeNull();
    expect(parseLengthM("  ")).toBeNull();
    expect(parseLengthM("abc")).toBeNull();
    expect(parseLengthM("0")).toBeNull();
    expect(parseLengthM("-5")).toBeNull();
    expect(parseLengthM("120")).toBe(120);
    expect(parseLengthM("80,4")).toBe(80);
  });
});
