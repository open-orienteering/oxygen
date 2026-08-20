import { describe, it, expect } from "vitest";
import {
  buildCourseDataXml,
  type CourseDataExport,
} from "../iof-course-export.js";
import { parseIOFCourseData } from "../iof-course-parser.js";

/** A two-course event: shared start/finish, one control only on course B. */
function sample(): CourseDataExport {
  return {
    eventName: "Vårtävling",
    mapScale: 10000,
    createTime: "2026-08-19T10:00:00.000Z",
    controls: [
      { id: "S1", type: "Start", xMm: 10, yMm: 20, lat: 59.1, lng: 18.1 },
      { id: "31", type: "Control", xMm: 30.5, yMm: 40.25, lat: 59.2, lng: 18.2 },
      { id: "32", type: "Control", xMm: 50, yMm: 60, lat: null, lng: null },
      { id: "33", type: "Control", xMm: 70, yMm: 80 },
      { id: "F1", type: "Finish", xMm: 90, yMm: 100, lat: 59.5, lng: 18.5 },
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
          // Unplaced control: dropped from the sequence.
          { controlId: "99", type: "Control", legLengthM: 700 },
          { controlId: "F1", type: "Finish", legLengthM: 1500 },
        ],
      },
    ],
    classAssignments: [
      { className: "H21", courseName: "A" },
      { className: "D21", courseName: "A" },
      { className: "Öppen 1", courseName: "B" },
      // Course not exported → assignment dropped.
      { className: "Ghost", courseName: "Z" },
    ],
  };
}

describe("buildCourseDataXml", () => {
  it("emits an IOF 3.0 CourseData document", () => {
    const xml = buildCourseDataXml(sample());
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(xml).toContain(
      '<CourseData xmlns="http://www.orienteering.org/datastandard/3.0"',
    );
    expect(xml).toContain('iofVersion="3.0"');
    expect(xml).toContain('creator="Oxygen"');
    expect(xml).toContain('createTime="2026-08-19T10:00:00.000Z"');
    expect(xml).toContain("<Name>Vårtävling</Name>");
    expect(xml).toContain("<Scale>10000</Scale>");
    expect(xml).toContain('unit="mm"');
  });

  it("survives a round-trip through the importer", () => {
    const input = sample();
    const parsed = parseIOFCourseData(buildCourseDataXml(input));

    expect(parsed.mapScale).toBe(10000);

    // Controls: placed ones only, positions and types intact.
    expect(parsed.controls.map((c) => c.id)).toEqual([
      "S1",
      "31",
      "32",
      "33",
      "F1",
    ]);
    const c31 = parsed.controls.find((c) => c.id === "31")!;
    expect(c31.type).toBe("Control");
    expect(c31.mapX).toBeCloseTo(30.5, 5);
    expect(c31.mapY).toBeCloseTo(40.25, 5);
    expect(c31.lat).toBeCloseTo(59.2, 5);
    expect(c31.lng).toBeCloseTo(18.2, 5);
    expect(parsed.controls.find((c) => c.id === "S1")!.type).toBe("Start");
    expect(parsed.controls.find((c) => c.id === "F1")!.type).toBe("Finish");
    // Missing lat/lng degrades to 0 rather than breaking the parse.
    expect(parsed.controls.find((c) => c.id === "33")!.lat).toBe(0);

    // Courses: names, lengths, climb and sequences (unplaced dropped).
    const [a, b] = parsed.courses;
    expect(a.name).toBe("A");
    expect(a.length).toBe(4200);
    expect(a.climb).toBe(80);
    expect(a.controls.map((cc) => cc.controlId)).toEqual([
      "S1",
      "31",
      "32",
      "F1",
    ]);
    expect(a.controls.map((cc) => cc.type)).toEqual([
      "Start",
      "Control",
      "Control",
      "Finish",
    ]);
    expect(a.controls[1].legLength).toBe(1200);
    expect(b.controls.map((cc) => cc.controlId)).toEqual(["S1", "33", "F1"]);
    // Climb 0 is omitted, so it parses back as 0.
    expect(b.climb).toBe(0);

    // Class assignments, minus the one pointing at a course we don't export.
    expect(parsed.classAssignments).toEqual([
      { className: "H21", courseName: "A" },
      { className: "D21", courseName: "A" },
      { className: "Öppen 1", courseName: "B" },
    ]);

    // Straight-line geometry is derived from the map positions, so the
    // importer can draw the courses immediately.
    expect(Object.keys(parsed.courseGeometry)).toEqual(["A", "B"]);
    expect(parsed.geometrySource).toBe("xml");
  });

  it("keeps the first of duplicate control ids", () => {
    const input = sample();
    input.controls.push({ id: "31", type: "Control", xMm: 999, yMm: 999 });
    const parsed = parseIOFCourseData(buildCourseDataXml(input));
    expect(parsed.controls.filter((c) => c.id === "31")).toHaveLength(1);
    expect(parsed.controls.find((c) => c.id === "31")!.mapX).toBeCloseTo(30.5, 5);
  });

  it("handles an event with no courses and no controls", () => {
    const xml = buildCourseDataXml({
      eventName: "Empty",
      mapScale: 0,
      controls: [],
      courses: [],
      classAssignments: [],
    });
    const parsed = parseIOFCourseData(xml);
    expect(parsed.controls).toEqual([]);
    expect(parsed.courses).toEqual([]);
    // Missing scale falls back to the IOF-ish default.
    expect(parsed.mapScale).toBe(15000);
    expect(xml).not.toContain("<MapPositionTopLeft");
  });

  it("exports courses that use their first/last control as start/finish", () => {
    const parsed = parseIOFCourseData(
      buildCourseDataXml({
        eventName: "Sprint",
        mapScale: 4000,
        controls: [
          { id: "41", type: "Control", xMm: 10, yMm: 10 },
          { id: "42", type: "Control", xMm: 20, yMm: 20 },
        ],
        courses: [
          {
            name: "First-as-start",
            lengthM: 900,
            climbM: 0,
            controls: [
              { controlId: "41", type: "Start" },
              { controlId: "42", type: "Finish", legLengthM: 900 },
            ],
          },
        ],
        classAssignments: [],
      }),
    );
    const seq = parsed.courses[0].controls;
    expect(seq.map((cc) => [cc.controlId, cc.type])).toEqual([
      ["41", "Start"],
      ["42", "Finish"],
    ]);
  });
});
