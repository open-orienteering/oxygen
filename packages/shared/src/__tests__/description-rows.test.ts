import { describe, expect, it } from "vitest";
import {
  buildDescriptionSheet,
  hasThickRuleBelow,
  pruneDescriptionInstructions,
} from "../course-maps/description-rows.js";

describe("buildDescriptionSheet", () => {
  it("emits the 3-row header, start, controls, default finish", () => {
    const sheet = buildDescriptionSheet({
      eventName: "Test Event",
      classNames: ["H21", "D21"],
      courseName: "A",
      lengthM: 4200,
      climbM: 85,
      controls: [
        { id: 31, code: "31", description: { d: "2.004" } },
        { id: 32, code: "32" },
      ],
    });
    expect(sheet.header).toEqual({
      eventName: "Test Event",
      classNames: "H21, D21",
      courseName: "A",
      lengthKm: "4.20 km",
      climbM: "85 m",
    });
    expect(sheet.rows.map((r) => r.kind)).toEqual([
      "start",
      "control",
      "control",
      "finish",
    ]);
    expect(sheet.rows[1]).toMatchObject({
      kind: "control",
      sequence: 1,
      code: "31",
      description: { d: "2.004" },
    });
    expect(sheet.rows[3]).toMatchObject({
      kind: "finish",
      symbolKey: "14.3",
    });
  });

  it("inserts specials after start and after a named control", () => {
    const sheet = buildDescriptionSheet({
      eventName: "E",
      classNames: [],
      courseName: "B",
      lengthM: 0,
      climbM: 0,
      controls: [
        { id: 31, code: "31" },
        { id: 32, code: "32" },
      ],
      instructions: {
        specials: [
          { afterControlId: null, kind: "13.1", lengthM: 60 },
          { afterControlId: 31, kind: "13.2", lengthM: 120 },
        ],
        finish: { kind: "14.1", lengthM: 150 },
      },
    });
    expect(sheet.rows.map((r) => [r.kind, r.symbolKey ?? r.code])).toEqual([
      ["start", "start"],
      ["special", "13.1"],
      ["control", "31"],
      ["special", "13.2"],
      ["control", "32"],
      ["finish", "14.1"],
    ]);
    expect(sheet.rows[1].lengthM).toBe(60);
    expect(sheet.rows[5].lengthM).toBe(150);
  });

  it("drops specials whose afterControlId is not on the course", () => {
    const sheet = buildDescriptionSheet({
      eventName: "E",
      classNames: [],
      courseName: "C",
      lengthM: 1000,
      climbM: 0,
      controls: [{ id: 31, code: "31" }],
      instructions: {
        specials: [
          { afterControlId: 99, kind: "13.1" },
          { afterControlId: 31, kind: "13.5" },
        ],
      },
    });
    // 99 is not filtered by the builder itself — prune handles that at
    // write time. The builder only emits specials whose after id matches
    // a control in the input list (or null).
    expect(sheet.rows.filter((r) => r.kind === "special")).toHaveLength(1);
    expect(sheet.rows.find((r) => r.kind === "special")?.symbolKey).toBe("13.5");
  });

  it("uses the measured last-control → finish distance when no explicit length is set", () => {
    const base = {
      eventName: "E",
      classNames: [],
      courseName: "D",
      lengthM: 1000,
      climbM: 0,
      controls: [{ id: 31, code: "31" }],
    };
    const measured = buildDescriptionSheet({ ...base, finishLengthM: 148.4 });
    expect(measured.rows.at(-1)).toMatchObject({ kind: "finish", lengthM: 148 });

    // An explicit finish length always wins over the measured one.
    const explicit = buildDescriptionSheet({
      ...base,
      finishLengthM: 148.4,
      instructions: { finish: { kind: "14.1", lengthM: 200 } },
    });
    expect(explicit.rows.at(-1)).toMatchObject({ symbolKey: "14.1", lengthM: 200 });

    // Nothing measured and nothing set → no length text.
    const none = buildDescriptionSheet({ ...base, finishLengthM: 0 });
    expect(none.rows.at(-1)?.lengthM).toBeUndefined();
  });

  it("draws thick rules under start, after every third control, around specials and above finish", () => {
    const sheet = buildDescriptionSheet({
      eventName: "E",
      classNames: [],
      courseName: "F",
      lengthM: 0,
      climbM: 0,
      controls: [31, 32, 33, 34, 35, 36, 37, 38].map((code) => ({ id: code, code: String(code) })),
      instructions: { specials: [{ afterControlId: 34, kind: "13.1" }] },
    });
    // start, 1, 2, 3, 4, special, 5, 6, 7, 8, finish
    const thick = sheet.rows.map((_, i) => hasThickRuleBelow(sheet.rows, i));
    expect(thick).toEqual([
      true,  // under start
      false, // 1
      false, // 2
      true,  // 3 — every third description
      true,  // 4 — above the special
      true,  // special — below it
      false, // 5
      true,  // 6 — every third
      false, // 7
      true,  // 8 — above finish
      false, // finish (bottom border)
    ]);
  });
});

describe("pruneDescriptionInstructions", () => {
  it("keeps finish and after-start specials, drops orphans", () => {
    const pruned = pruneDescriptionInstructions(
      {
        specials: [
          { afterControlId: null, kind: "13.1" },
          { afterControlId: 31, kind: "13.2" },
          { afterControlId: 99, kind: "13.3" },
        ],
        finish: { kind: "14.2", lengthM: 80 },
      },
      new Set([31]),
    );
    expect(pruned).toEqual({
      specials: [
        { afterControlId: null, kind: "13.1" },
        { afterControlId: 31, kind: "13.2" },
      ],
      finish: { kind: "14.2", lengthM: 80 },
    });
  });

  it("returns null when everything is gone", () => {
    expect(
      pruneDescriptionInstructions(
        { specials: [{ afterControlId: 99, kind: "13.1" }] },
        new Set([31]),
      ),
    ).toBeNull();
  });
});
