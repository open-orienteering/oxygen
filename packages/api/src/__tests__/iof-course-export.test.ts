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

  it("emits randomOrder on free-order Control rows and round-trips", () => {
    const xml = buildCourseDataXml({
      eventName: "Free",
      mapScale: 10000,
      controls: [
        { id: "S1", type: "Start", xMm: 10, yMm: 10 },
        { id: "31", type: "Control", xMm: 20, yMm: 20 },
        { id: "32", type: "Control", xMm: 30, yMm: 30 },
        { id: "F1", type: "Finish", xMm: 40, yMm: 40 },
      ],
      courses: [
        {
          name: "Score",
          lengthM: 0,
          climbM: 0,
          orderMode: "free_order",
          controls: [
            { controlId: "S1", type: "Start" },
            { controlId: "31", type: "Control", legLengthM: 500 },
            { controlId: "32", type: "Control", legLengthM: 500 },
            { controlId: "F1", type: "Finish", legLengthM: 500 },
          ],
        },
      ],
      classAssignments: [],
    });
    expect(xml).toMatch(/CourseControl[^>]*\brandomOrder="true"/);
    // Legs omitted for free-order Control rows.
    expect(xml).not.toMatch(
      /CourseControl[^>]*type="Control"[^>]*>[\s\S]*?<LegLength/,
    );

    const parsed = parseIOFCourseData(xml);
    expect(parsed.courses[0].orderMode).toBe("free_order");
    expect(
      parsed.courses[0].controls
        .filter((c) => c.type === "Control")
        .every((c) => c.randomOrder),
    ).toBe(true);
  });

  it("keeps ordered mode when only some controls have randomOrder", () => {
    const parsed = parseIOFCourseData(`<?xml version="1.0" encoding="UTF-8"?>
<CourseData xmlns="http://www.orienteering.org/datastandard/3.0" iofVersion="3.0">
  <RaceCourseData>
    <Map><Scale>10000</Scale></Map>
    <Control type="Control"><Id>31</Id><MapPosition x="1" y="1" unit="mm"/></Control>
    <Control type="Control"><Id>32</Id><MapPosition x="2" y="2" unit="mm"/></Control>
    <Course>
      <Name>Partial</Name>
      <CourseControl type="Control" randomOrder="true"><Control>31</Control></CourseControl>
      <CourseControl type="Control"><Control>32</Control></CourseControl>
    </Course>
  </RaceCourseData>
</CourseData>`);
    expect(parsed.courses[0].orderMode).toBe("ordered");
  });
});

/**
 * The slice-F structure in CourseData (row F9; docs/iof-coursedata-export.md
 * "What ends up in the file"): course families, crossing points, taped
 * routes and the map exchange, and their way back through the parser.
 */
describe("buildCourseDataXml — course structure (F9)", () => {
  function forked(): CourseDataExport {
    return {
      eventName: "Gaffling",
      mapScale: 10000,
      createTime: "2026-11-08T10:00:00.000Z",
      controls: [
        { id: "S1", type: "Start", xMm: 0, yMm: 0.5 },
        { id: "41", type: "Control", xMm: 20, yMm: 0.5 },
        { id: "42", type: "Control", xMm: 20, yMm: 30 },
        { id: "80", type: "Control", xMm: 40, yMm: 0.5, mapExchange: true },
        { id: "Passeringspunkt 1", type: "CrossingPoint", xMm: 50, yMm: 10 },
        { id: "F1", type: "Finish", xMm: 60, yMm: 0.5 },
      ],
      courses: ["A", "B"].map((key) => ({
        name: `Lång ${key}`,
        family: "Lång",
        lengthM: 900,
        climbM: 0,
        controls: [
          { controlId: "S1", type: "Start" as const },
          { controlId: key === "A" ? "41" : "42", type: "Control" as const, legLengthM: 200 },
          { controlId: "80", type: "Control" as const, legLengthM: 200 },
          { controlId: "Passeringspunkt 1", type: "CrossingPoint" as const, specialInstruction: "MandatoryCrossingPoint" as const },
          { controlId: "F1", type: "Finish" as const, legLengthM: 300, specialInstruction: "TapedRoute" as const, tapedRouteLengthM: 300 },
        ],
      })),
      classAssignments: [
        { className: "H21", courseName: "Lång A" },
        { className: "H21", courseName: "Lång B" },
      ],
    };
  }

  it("writes CourseFamily after Name, one Course per variant", () => {
    const xml = buildCourseDataXml(forked());
    expect(xml).toMatch(/<Name>Lång A<\/Name>\s*<CourseFamily>Lång<\/CourseFamily>\s*<Length>900<\/Length>/);
    expect(xml.match(/<Course>/g)).toHaveLength(2);
    expect(xml.match(/<ClassCourseAssignment>/g)).toHaveLength(2);
  });

  it("writes the crossing point as a CrossingPoint control and an unnumbered row without LegLength", () => {
    const xml = buildCourseDataXml(forked());
    expect(xml).toMatch(/<Control type="CrossingPoint">\s*<Id>Passeringspunkt 1<\/Id>/);
    expect(xml).toMatch(/<CourseControl type="CrossingPoint" specialInstruction="MandatoryCrossingPoint">\s*<Control>Passeringspunkt 1<\/Control>\s*<\/CourseControl>/);
  });

  it("writes the taped route on the leg's end row with its length", () => {
    const xml = buildCourseDataXml(forked());
    expect(xml).toMatch(/<CourseControl type="Finish" specialInstruction="TapedRoute" tapedRouteLength="300">\s*<Control>F1<\/Control>\s*<LegLength>300<\/LegLength>/);
    // An ordinary leg has no instruction.
    expect(xml).not.toMatch(/<CourseControl type="Control" specialInstruction/);
  });

  it("marks the map exchange in the site's Extensions, nowhere else", () => {
    const xml = buildCourseDataXml(forked());
    expect(xml).toContain('xmlns:ox="urn:oxygen:iof:extensions"');
    expect(xml).toMatch(/<Control type="Control">\s*<Id>80<\/Id>[\s\S]*?<Extensions>\s*<ox:MapExchange>true<\/ox:MapExchange>\s*<\/Extensions>\s*<\/Control>/);
    expect(xml.match(/MapExchange>true/g)).toHaveLength(1);
    expect(xml).not.toContain("<MapText>");
  });

  it("round-trips the family, the crossing, the taped route and the exchange through the parser", () => {
    const parsed = parseIOFCourseData(buildCourseDataXml(forked()));
    const a = parsed.courses.find((c) => c.name === "Lång A")!;
    expect(a.family).toBe("Lång");
    // The crossing row folds into the leg it is on: no row of its own, the
    // end row carries it and the whole leg.
    expect(a.controls.map((cc) => cc.controlId)).toEqual(["S1", "41", "80", "F1"]);
    expect(a.controls[3]).toMatchObject({ type: "Finish", legLength: 300, crossing: { controlId: "Passeringspunkt 1" }, style: "marked_route" });
    expect(a.controls[2].crossing).toBeUndefined();
    expect(a.controls[2].style).toBeUndefined();
    expect(parsed.controls.find((c) => c.id === "Passeringspunkt 1")!.type).toBe("CrossingPoint");
    expect(parsed.controls.find((c) => c.id === "80")!.mapExchange).toBe(true);
    expect(parsed.controls.find((c) => c.id === "41")!.mapExchange).toBeUndefined();
    expect(parsed.classAssignments).toEqual([
      { className: "H21", courseName: "Lång A" },
      { className: "H21", courseName: "Lång B" },
    ]);
  });

  it("a passage (crossing section) writes MandatoryOutOfBoundsAreaPassage and reads back as section", () => {
    const input = forked();
    input.courses[0].controls[3].specialInstruction = "MandatoryOutOfBoundsAreaPassage";
    const xml = buildCourseDataXml(input);
    expect(xml).toContain('specialInstruction="MandatoryOutOfBoundsAreaPassage"');
    const a = parseIOFCourseData(xml).courses.find((c) => c.name === "Lång A")!;
    expect(a.controls[3].crossing).toEqual({ controlId: "Passeringspunkt 1", section: true });
  });

  it("writes no family for a course without one", () => {
    const xml = buildCourseDataXml(sample());
    expect(xml).not.toContain("CourseFamily");
    expect(parseIOFCourseData(xml).courses[0].family).toBeUndefined();
  });
});

describe("parseIOFCourseData — a foreign file's structure (F9)", () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<CourseData xmlns="http://www.orienteering.org/datastandard/3.0" iofVersion="3.0">
  <RaceCourseData>
    <Map><Scale>10000</Scale></Map>
    <Control type="Start"><Id>S1</Id><MapPosition x="0" y="0" unit="mm"/></Control>
    <Control type="Control"><Id>31</Id><MapPosition x="10" y="0" unit="mm"/></Control>
    <Control type="CrossingPoint"><Id>CP</Id><MapPosition x="15" y="5" unit="mm"/></Control>
    <Control type="EndOfMarkedRoute"><Id>EMR</Id><MapPosition x="18" y="0" unit="mm"/></Control>
    <Control type="Finish"><Id>F1</Id><MapPosition x="20" y="0" unit="mm"/></Control>
    <Course>
      <Name>Split</Name>
      <CourseControl type="CrossingPoint"><Control>CP</Control></CourseControl>
      <CourseControl type="Start"><Control>S1</Control></CourseControl>
      <CourseControl type="Control"><Control>31</Control><LegLength>100</LegLength></CourseControl>
      <CourseControl type="CrossingPoint"><Control>CP</Control><LegLength>70</LegLength></CourseControl>
      <CourseControl type="EndOfMarkedRoute" specialInstruction="FunnelTapedRoute"><Control>EMR</Control><LegLength>30</LegLength></CourseControl>
      <CourseControl type="Finish"><Control>F1</Control><LegLength>20</LegLength></CourseControl>
      <CourseControl type="CrossingPoint"><Control>CP</Control></CourseControl>
    </Course>
  </RaceCourseData>
</CourseData>`;

  it("folds crossing and end-of-marked-route rows into the next row, summing a split LegLength", () => {
    const course = parseIOFCourseData(xml).courses[0];
    // A crossing row before the first or after the last row joins no leg.
    expect(course.controls.map((cc) => cc.controlId)).toEqual(["S1", "31", "F1"]);
    expect(course.controls[0].crossing).toBeUndefined();
    expect(course.controls[2]).toMatchObject({ legLength: 120, crossing: { controlId: "CP" }, style: "marked_route" });
  });

  it("keeps the crossing point as a site and drops the end-of-marked-route point", () => {
    const parsed = parseIOFCourseData(xml);
    expect(parsed.controls.map((c) => [c.id, c.type])).toEqual([
      ["S1", "Start"], ["31", "Control"], ["CP", "CrossingPoint"], ["F1", "Finish"],
    ]);
  });
});
