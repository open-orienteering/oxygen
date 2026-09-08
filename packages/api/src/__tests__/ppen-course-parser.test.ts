import { describe, it, expect } from "vitest";
import {
  isPpenContent,
  parsePpenCourseData,
} from "../ppen-course-parser.js";

/** Minimal two-course .ppen: shared start/finish, three regular controls. */
const SAMPLE_PPEN = `<?xml version="1.0" encoding="utf-8"?>
<course-scribe-event>
  <event id="1">
    <title>Youth Training</title>
    <map kind="OCAD" scale="10000">map.ocd</map>
  </event>
  <control id="10" kind="start">
    <location x="10" y="20" />
  </control>
  <control id="11" kind="normal">
    <code>31</code>
    <location x="30.5" y="40.25" />
  </control>
  <control id="12" kind="normal">
    <code>32</code>
    <location x="50" y="60" />
  </control>
  <control id="13" kind="normal">
    <code>33</code>
    <location x="70" y="80" />
  </control>
  <control id="14" kind="finish">
    <location x="90" y="100" />
  </control>
  <course id="1" kind="normal" order="1">
    <name>A</name>
    <first course-control="100" />
  </course>
  <course id="2" kind="normal" order="2">
    <name>B</name>
    <first course-control="200" />
  </course>
  <course-control id="100" control="10">
    <next course-control="101" />
  </course-control>
  <course-control id="101" control="11">
    <next course-control="102" />
  </course-control>
  <course-control id="102" control="12">
    <next course-control="103" />
  </course-control>
  <course-control id="103" control="14" />
  <course-control id="200" control="10">
    <next course-control="201" />
  </course-control>
  <course-control id="201" control="13">
    <next course-control="202" />
  </course-control>
  <course-control id="202" control="14" />
</course-scribe-event>
`;

describe("isPpenContent", () => {
  it("detects the Purple Pen root element", () => {
    expect(isPpenContent(SAMPLE_PPEN)).toBe(true);
    expect(isPpenContent("<CourseData><RaceCourseData/></CourseData>")).toBe(
      false,
    );
    expect(isPpenContent("not xml")).toBe(false);
  });
});

describe("parsePpenCourseData", () => {
  it("parses controls, courses and map scale", () => {
    const parsed = parsePpenCourseData(SAMPLE_PPEN);

    expect(parsed.mapScale).toBe(10000);
    expect(parsed.geometrySource).toBe("xml");
    expect(parsed.classAssignments).toEqual([]);

    expect(parsed.controls.map((c) => c.id)).toEqual([
      "STA1",
      "31",
      "32",
      "33",
      "FIN1",
    ]);
    expect(parsed.controls.find((c) => c.id === "STA1")!.type).toBe("Start");
    expect(parsed.controls.find((c) => c.id === "FIN1")!.type).toBe("Finish");
    const c31 = parsed.controls.find((c) => c.id === "31")!;
    expect(c31.type).toBe("Control");
    expect(c31.mapX).toBeCloseTo(30.5, 5);
    expect(c31.mapY).toBeCloseTo(40.25, 5);
    expect(c31.lat).toBe(0);
    expect(c31.lng).toBe(0);
  });

  it("records the map the courses were set on", () => {
    // Positions are paper mm anchored to this file — the importer needs
    // its name to tell whether they belong on the event's map.
    const xml = SAMPLE_PPEN.replace(
      /<map [^>]*>[^<]*<\/map>/,
      `<map kind="OCAD" scale="10000" absolute-path="C:\\Kartor\\Brotorp.ocd">..\\..\\Kartfiler\\Brotorp.ocd</map>`,
    );
    expect(parsePpenCourseData(xml).sourceMap).toEqual({
      fileName: "Brotorp.ocd",
      kind: "OCAD",
      scale: 10000,
    });
  });

  it("falls back to the absolute path when no relative one is stored", () => {
    const xml = SAMPLE_PPEN.replace(
      /<map [^>]*>[^<]*<\/map>/,
      `<map kind="PDF" scale="15000" absolute-path="C:\\Kartor\\Nacka 1_15000.pdf"></map>`,
    );
    expect(parsePpenCourseData(xml).sourceMap).toEqual({
      fileName: "Nacka 1_15000.pdf",
      kind: "PDF",
      scale: 15000,
    });
  });

  it("walks course-control linked lists into ordered sequences", () => {
    const parsed = parsePpenCourseData(SAMPLE_PPEN);
    expect(parsed.courses.map((c) => c.name)).toEqual(["A", "B"]);

    const a = parsed.courses[0];
    expect(a.controls.map((cc) => cc.controlId)).toEqual([
      "STA1",
      "31",
      "32",
      "FIN1",
    ]);
    expect(a.controls.map((cc) => cc.type)).toEqual([
      "Start",
      "Control",
      "Control",
      "Finish",
    ]);

    const b = parsed.courses[1];
    expect(b.controls.map((cc) => cc.controlId)).toEqual([
      "STA1",
      "33",
      "FIN1",
    ]);
  });

  it("computes leg lengths and course length from map mm and scale", () => {
    const parsed = parsePpenCourseData(SAMPLE_PPEN);
    const a = parsed.courses[0];
    // (dx,dy) start→31: (20.5, 20.25) → ≈28.81 mm → 288 m at 1:10 000
    expect(a.controls[1].legLength).toBe(
      Math.round((Math.hypot(20.5, 20.25) * 10000) / 1000),
    );
    expect(a.length).toBe(
      a.controls.slice(1).reduce((sum, cc) => sum + cc.legLength, 0),
    );
    expect(a.length).toBeGreaterThan(0);
  });

  it("builds straight-line geometry for each course", () => {
    const parsed = parsePpenCourseData(SAMPLE_PPEN);
    expect(parsed.courseGeometry.A).toBeDefined();
    const points = parsed.courseGeometry.A.features.filter(
      (f) => f.geometry.type === "Point",
    );
    const legs = parsed.courseGeometry.A.features.filter(
      (f) => f.geometry.type === "LineString",
    );
    expect(points).toHaveLength(4);
    expect(legs).toHaveLength(3);
  });

  it("rejects files without the Purple Pen root", () => {
    expect(() => parsePpenCourseData("<CourseData/>")).toThrow(
      /course-scribe-event/i,
    );
  });

  it("rejects non-normal course kinds", () => {
    const xml = SAMPLE_PPEN.replace(
      'kind="normal" order="1"',
      'kind="score" order="1"',
    );
    expect(() => parsePpenCourseData(xml)).toThrow(/score/i);
    expect(() => parsePpenCourseData(xml)).toThrow(/A/);
  });

  it("rejects branching next links (relay variations)", () => {
    const xml = SAMPLE_PPEN.replace(
      `<course-control id="101" control="11">
    <next course-control="102" />
  </course-control>`,
      `<course-control id="101" control="11">
    <next course-control="102" />
    <next course-control="200" />
  </course-control>`,
    );
    expect(() => parsePpenCourseData(xml)).toThrow(/branch/i);
    expect(() => parsePpenCourseData(xml)).toThrow(/A/);
  });

  it("defaults map scale to 15000 when missing", () => {
    const xml = SAMPLE_PPEN.replace('scale="10000"', "");
    expect(parsePpenCourseData(xml).mapScale).toBe(15000);
  });

  it("skips map-issue points but keeps following the course chain", () => {
    const xml = SAMPLE_PPEN.replace(
      `  <control id="10" kind="start">
    <location x="10" y="20" />
  </control>`,
      `  <control id="9" kind="map-issue">
    <location x="5" y="5" />
  </control>
  <control id="10" kind="start">
    <location x="10" y="20" />
  </control>`,
    ).replace(
      `<course-control id="100" control="10">
    <next course-control="101" />
  </course-control>`,
      `<course-control id="99" control="9">
    <next course-control="100" />
  </course-control>
  <course-control id="100" control="10">
    <next course-control="101" />
  </course-control>`,
    ).replace(
      `<first course-control="100" />`,
      `<first course-control="99" />`,
    );

    const parsed = parsePpenCourseData(xml);
    expect(parsed.controls.map((c) => c.id)).not.toContain("9");
    expect(parsed.courses[0].controls.map((cc) => cc.controlId)).toEqual([
      "STA1",
      "31",
      "32",
      "FIN1",
    ]);
  });
});
