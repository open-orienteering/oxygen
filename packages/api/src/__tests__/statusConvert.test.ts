import { describe, it, expect } from "vitest";
import { RunnerStatus } from "@oxygen/shared";
import { runnerStatusValueSchema, isRunnerStatusValue } from "../statusConvert.js";
import { absoluteTimeSchema } from "../timeConvert.js";

describe("runnerStatusValueSchema (RES-24)", () => {
  it.each(Object.entries(RunnerStatus))("accepts %s", (_name, value) => {
    expect(runnerStatusValueSchema.parse(value)).toBe(value);
    expect(isRunnerStatusValue(value)).toBe(true);
  });

  it.each([7, 999, -1, 100, 1.5, Number.NaN])("rejects %s", (value) => {
    expect(runnerStatusValueSchema.safeParse(value).success).toBe(false);
    expect(isRunnerStatusValue(value)).toBe(false);
  });
});

describe("absoluteTimeSchema (RES-24)", () => {
  it("accepts 0 and the last decisecond of the day", () => {
    expect(absoluteTimeSchema.parse(0)).toBe(0);
    expect(absoluteTimeSchema.parse(863_999)).toBe(863_999);
  });
  it.each([-1, 864_000, 999_999_999, 1.5])("rejects %s", (value) => {
    expect(absoluteTimeSchema.safeParse(value).success).toBe(false);
  });
});
