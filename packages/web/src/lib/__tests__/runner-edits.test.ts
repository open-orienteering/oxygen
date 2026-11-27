import { describe, it, expect } from "vitest";
import {
  mergePendingEdits,
  validateRunnerEdits,
  isSettled,
  shouldSyncField,
  saveErrorText,
} from "../runner-edits";

describe("mergePendingEdits (WEB-07)", () => {
  it("keeps every field edited before the save fires", () => {
    let p = mergePendingEdits({}, "name", "Anna");
    p = mergePendingEdits(p, "cardNo", 500123);
    expect(p).toEqual({ name: "Anna", cardNo: 500123 });
  });

  it("lets the last edit of one field win", () => {
    let p = mergePendingEdits({}, "name", "An");
    p = mergePendingEdits(p, "name", "Anna");
    expect(p).toEqual({ name: "Anna" });
  });

  it("does not mutate the input map", () => {
    const before = { name: "Anna" };
    mergePendingEdits(before, "cardNo", 1);
    expect(before).toEqual({ name: "Anna" });
  });
});

describe("validateRunnerEdits (WEB-08)", () => {
  it("refuses a blank or whitespace name", () => {
    expect(validateRunnerEdits({ name: "" }).errors).toEqual({ name: "nameRequired" });
    expect(validateRunnerEdits({ name: "   " }).errors).toEqual({ name: "nameRequired" });
    expect(validateRunnerEdits({ name: "" }).data).toEqual({});
  });

  it("refuses class 0", () => {
    expect(validateRunnerEdits({ classId: 0 })).toEqual({ data: {}, errors: { classId: "classRequired" } });
  });

  it("refuses a negative or out-of-range card number, but not 0 (no card)", () => {
    expect(validateRunnerEdits({ cardNo: -5 }).errors).toEqual({ cardNo: "invalidCardNo" });
    expect(validateRunnerEdits({ cardNo: 3_000_000_000 }).errors).toEqual({ cardNo: "invalidCardNo" });
    expect(validateRunnerEdits({ cardNo: 0 })).toEqual({ data: { cardNo: 0 }, errors: {} });
  });

  it("still sends the valid edits beside an invalid one", () => {
    expect(validateRunnerEdits({ name: "", cardNo: 42, classId: 3 })).toEqual({
      data: { cardNo: 42, classId: 3 },
      errors: { name: "nameRequired" },
    });
  });

  it("passes other fields through untouched, empty values included", () => {
    const p = { phone: "", cardNo: 0, courseId: null, startTime: 0 };
    expect(validateRunnerEdits(p)).toEqual({ data: p, errors: {} });
  });
});

describe("isSettled", () => {
  it("compares text exactly", () => {
    expect(isSettled("Anna", "Anna")).toBe(true);
    expect(isSettled("Anna ", "Anna")).toBe(false);
  });

  it("compares number fields as the saved number", () => {
    expect(isSettled("007", "7", "number")).toBe(true);
    expect(isSettled("", "", "number")).toBe(true);
    expect(isSettled("12", "12345", "number")).toBe(false);
  });
});

describe("shouldSyncField (WEB-07)", () => {
  it.each([
    [false, false, true],
    [true, false, false],
    [false, true, false],
    [true, true, false],
  ])("focused=%s dirty=%s -> %s", (focused, dirty, expected) => {
    expect(shouldSyncField({ focused, dirty })).toBe(expected);
  });
});

describe("saveErrorText", () => {
  it("drops the tRPC code prefix", () => {
    expect(saveErrorText("CONFLICT: Card 5 is used by Bo")).toBe("Card 5 is used by Bo");
    expect(saveErrorText("Card 5 is used by Bo")).toBe("Card 5 is used by Bo");
  });
});
