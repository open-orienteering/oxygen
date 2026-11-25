import { describe, it, expect } from "vitest";
import { capabilityForEntry } from "../journalCapabilities.js";

const cap = (type: string, payload: Record<string, unknown> = {}) =>
  capabilityForEntry({ type, payload });

describe("capabilityForEntry", () => {
  it.each([
    "card.read",
    "result.applied",
    "finish.recorded",
    "start.recorded",
    "runner.registered",
    "finish.adjusted",
    "punch.recorded",
    "punch.removed",
    "punch.updated",
  ])("%s needs race.operate", (type) => {
    expect(cap(type)).toBe("race.operate");
  });

  it.each(["start.adjusted", "runner.updated", "runner.deleted", "class.upserted"])(
    "%s needs event.manage",
    (type) => {
      expect(cap(type)).toBe("event.manage");
    },
  );

  it.each(["course.upserted", "control.upserted", "reference.imported"])(
    "%s needs courses.edit",
    (type) => {
      expect(cap(type)).toBe("courses.edit");
    },
  );

  it("refuses an unknown type", () => {
    expect(cap("runner.exploded")).toBeNull();
    expect(cap("")).toBeNull();
  });

  it("lowers a finishTime-only runner.updated to race.operate", () => {
    expect(cap("runner.updated", { fields: { finishTime: 36000 } })).toBe("race.operate");
  });

  it("keeps event.manage when runner.updated carries anything else", () => {
    expect(cap("runner.updated", { fields: { finishTime: 36000, name: "x" } })).toBe("event.manage");
    expect(cap("runner.updated", { fields: { name: "x" } })).toBe("event.manage");
    expect(cap("runner.updated", { fields: {} })).toBe("event.manage");
    expect(cap("runner.updated", {})).toBe("event.manage");
    expect(cap("runner.updated", { fields: [] })).toBe("event.manage");
  });

  it("does not apply the finishTime exception to other types", () => {
    expect(cap("runner.deleted", { fields: { finishTime: 1 } })).toBe("event.manage");
  });
});
