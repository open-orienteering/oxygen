/**
 * IOF CourseData parsing edge cases the course import refuses or keeps
 * (course-layer.md §6.4 "Import semantics", review package 17).
 */
import { describe, expect, it } from "vitest";
import { parseIOFCourseData } from "../iof-course-parser.js";

const race = (course: string, length = "") => `
  <RaceCourseData>
    <Map><Scale>10000</Scale></Map>
    <Control type="Start"><Id>S1</Id><MapPosition x="0" y="0"/></Control>
    <Control><Id>31</Id><MapPosition x="10" y="0"/></Control>
    <Control type="Finish"><Id>F1</Id><MapPosition x="20" y="0"/></Control>
    <Course>
      <Name>${course}</Name>${length}
      <CourseControl type="Start"><Control>S1</Control></CourseControl>
      <CourseControl type="Control"><Control>31</Control></CourseControl>
      <CourseControl type="Finish"><Control>F1</Control></CourseControl>
    </Course>
  </RaceCourseData>`;
const file = (...races: string[]) => `<?xml version="1.0"?><CourseData xmlns="http://www.orienteering.org/datastandard/3.0" iofVersion="3.0">${races.join("")}</CourseData>`;

describe("parseIOFCourseData", () => {
  it("reads a single race", () => {
    const parsed = parseIOFCourseData(file(race("A", "<Length>3200</Length>")));
    expect(parsed.courses.map((c) => [c.name, c.length])).toEqual([["A", 3200]]);
    expect(parsed.controls).toHaveLength(3);
  });

  it("reads a course without <Length> as length 0 (the import keeps the stored one)", () => {
    expect(parseIOFCourseData(file(race("A"))).courses[0].length).toBe(0);
  });

  it("refuses a file with several races instead of reading zero courses", () => {
    expect(() => parseIOFCourseData(file(race("A"), race("B")))).toThrow("The file holds 2 races; export one race per file");
  });
});
