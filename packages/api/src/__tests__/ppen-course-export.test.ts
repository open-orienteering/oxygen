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
