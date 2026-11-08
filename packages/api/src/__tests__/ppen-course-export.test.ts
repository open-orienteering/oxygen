import { describe, it, expect } from "vitest";
import { buildPpenXml, type PpenExportInput } from "../ppen-course-export.js";
import { parsePpenCourseData } from "../ppen-course-parser.js";

/** A two-course event: shared start/finish, one control only on course B. */
function sample(): PpenExportInput {
  return {
    eventName: "Vårtävling",
    mapScale: 10000,
    mapFileName: "skog.ocd",
    controls: [
      { id: "S1", type: "Start", xMm: 10, yMm: 20 },
      { id: "31", type: "Control", xMm: 30.5, yMm: 40.25 },
      { id: "32", type: "Control", xMm: 50, yMm: 60 },
      { id: "33", type: "Control", xMm: 70, yMm: 80 },
      { id: "F1", type: "Finish", xMm: 90, yMm: 100 },
      // Never placed on the map — must not appear anywhere.
      { id: "99", type: "Control", xMm: 0, yMm: 0 },
    ],
    courses: [
      {
        name: "A",
        lengthM: 4200,
        climbM: 80,
        controls: [
          { controlId: "S1", type: "Start" },
          { controlId: "31", type: "Control", legLengthM: 1200 },
          { controlId: "32", type: "Control", legLengthM: 1500 },
          { controlId: "F1", type: "Finish", legLengthM: 1500 },
        ],
      },
      {
        name: "B",
        lengthM: 3100,
        climbM: 0,
        controls: [
          { controlId: "S1", type: "Start" },
          { controlId: "33", type: "Control", legLengthM: 1600 },
          { controlId: "99", type: "Control", legLengthM: 700 },
          { controlId: "F1", type: "Finish", legLengthM: 1500 },
        ],
      },
    ],
    classAssignments: [],
  };
}

describe("buildPpenXml", () => {
  it("emits a CourseScribe document with map scale and title", () => {
    const xml = buildPpenXml(sample());
    expect(xml.startsWith('<?xml version="1.0" encoding="utf-8"?>')).toBe(true);
    expect(xml).toContain("<course-scribe-event>");
    expect(xml).toContain("<title>Vårtävling</title>");
    expect(xml).toContain('scale="10000"');
    expect(xml).toContain(">skog.ocd</map>");
    expect(xml).toContain('kind="start"');
    expect(xml).toContain('kind="finish"');
    expect(xml).toContain("<code>31</code>");
    expect(xml).not.toContain("<code>99</code>");
  });

  it("survives a round-trip through the ppen importer", () => {
    const input = sample();
    const parsed = parsePpenCourseData(buildPpenXml(input));

    expect(parsed.mapScale).toBe(10000);

    // Start/finish get synthesized STA/FIN ids on re-import.
    expect(parsed.controls.find((c) => c.type === "Start")!.mapX).toBeCloseTo(10, 5);
    expect(parsed.controls.find((c) => c.type === "Finish")!.mapY).toBeCloseTo(100, 5);
    expect(parsed.controls.map((c) => c.id)).toEqual(
      expect.arrayContaining(["31", "32", "33"]),
    );
    expect(parsed.controls.map((c) => c.id)).not.toContain("99");

    const a = parsed.courses.find((c) => c.name === "A")!;
    expect(a.controls.map((cc) => cc.type)).toEqual([
      "Start",
      "Control",
      "Control",
      "Finish",
    ]);
    expect(a.controls.map((cc) => cc.controlId).slice(1, 3)).toEqual(["31", "32"]);

    const b = parsed.courses.find((c) => c.name === "B")!;
    // Unplaced 99 dropped from the sequence.
    expect(b.controls.map((cc) => cc.controlId).filter((id) => id === "33")).toEqual([
      "33",
    ]);
    expect(b.controls.map((cc) => cc.controlId)).not.toContain("99");
  });
});

/** Slice F in Purple Pen (row F9; docs/ppen-import-export.md). */
describe("buildPpenXml — course structure (F9)", () => {
  function bent(): PpenExportInput {
    const input = sample();
    input.controls.push({ id: "Passeringspunkt 1", type: "CrossingPoint", xMm: 40, yMm: 50 });
    // A: S1 → 31 → 32 (bent, through the crossing point) → F1.
    input.courses[0].controls = [
      { controlId: "S1", type: "Start" },
      { controlId: "31", type: "Control", legLengthM: 1200 },
      { controlId: "Passeringspunkt 1", type: "CrossingPoint", specialInstruction: "MandatoryCrossingPoint" },
      { controlId: "32", type: "Control", legLengthM: 1500, bends: [{ x: 45, y: 42 }, { x: 48, y: 55.5 }] },
      { controlId: "F1", type: "Finish", legLengthM: 1500 },
    ];
    // B runs the same bent leg 31 → 32: one <leg> for the pair.
    input.courses[1].family = "Fam";
    input.courses[1].controls = [
      { controlId: "S1", type: "Start" },
      { controlId: "31", type: "Control" },
      { controlId: "32", type: "Control", bends: [{ x: 1, y: 1 }] },
      { controlId: "F1", type: "Finish" },
    ];
    return input;
  }

  it("writes one <leg> with <bends> per bent control pair (first course wins)", () => {
    const xml = buildPpenXml(bent());
    expect(xml.match(/<leg /g)).toHaveLength(1);
    expect(xml).toMatch(/<leg id="\d+" start-control="\d+" end-control="\d+">\s*<bends>\s*<location x="45" y="42"(\s*\/>|><\/location>)\s*<location x="48" y="55.5"/);
  });

  it("skips crossing points (sites and rows) and writes every course as kind normal", () => {
    const xml = buildPpenXml(bent());
    expect(xml).not.toContain("Passeringspunkt");
    expect(xml.match(/<course id="\d+" kind="normal"/g)).toHaveLength(2);
  });

  it("round-trips the bends through the parser, the leg measured along them", () => {
    const parsed = parsePpenCourseData(buildPpenXml(bent()));
    const a = parsed.courses.find((c) => c.name === "A")!;
    expect(a.controls.map((cc) => cc.controlId).slice(1, 3)).toEqual(["31", "32"]);
    expect(a.controls[2].bends).toEqual([{ x: 45, y: 42 }, { x: 48, y: 55.5 }]);
    const along = Math.hypot(45 - 30.5, 42 - 40.25) + Math.hypot(3, 13.5) + Math.hypot(2, 4.5);
    expect(a.controls[2].legLength).toBe(Math.round((along * 10000) / 1000));
    // The pair's one <leg> applies to every course that runs it.
    const b = parsed.courses.find((c) => c.name === "B")!;
    expect(b.controls[2].bends).toEqual([{ x: 45, y: 42 }, { x: 48, y: 55.5 }]);
    expect(a.controls[1].bends).toBeUndefined();
  });
});
