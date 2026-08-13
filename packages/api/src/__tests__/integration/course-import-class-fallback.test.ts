/**
 * Integration test: course-import preview falls back to course names
 * when the file contains no class assignments.
 *
 * Motivating case: an OCAD course-setting export ("Banor Alla
 * klasser.ocd") where the course setter never defined classes in
 * Course Setting, but named every course after its class (D10, H14,
 * U1, ...). Such files have course records but zero class records, so
 * the preview used to show "None" for every course with no way to map
 * classes at all.
 *
 * The fallback synthesizes one class assignment per course (class name
 * = course name), runs it through the normal auto-matcher, and flags
 * the response with `classNamesFromCourseNames: true` so the UI can
 * explain where the suggestions came from.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import {
  createTestEvent,
  disconnect,
  type TestEventContext,
} from "../helpers/test-db.js";
import { makeCaller } from "../helpers/caller.js";

// 5 courses named A–E, no class-assignment records (verified: the
// file's string-parameter index has strType 2 entries but no strType 3).
const OCD_FIXTURE = resolve(__dirname, "../../../../../e2e/test.ocd");

const XML_WITH_ASSIGNMENTS = `<?xml version="1.0" encoding="UTF-8"?>
<CourseData xmlns="http://www.orienteering.org/datastandard/3.0" iofVersion="3.0">
  <RaceCourseData>
    <Map><Scale>15000</Scale></Map>
    <Control type="Control"><Id>31</Id></Control>
    <Control type="Control"><Id>32</Id></Control>
    <Course>
      <!-- No "a"/"c" in the name: must not substring-match the seeded
           classes "A" and "C" in the fallback test below. -->
      <Name>Öppen 5</Name>
      <Length>2500</Length>
      <CourseControl type="Start"><Control>S1</Control></CourseControl>
      <CourseControl type="Control"><Control>31</Control></CourseControl>
      <CourseControl type="Control"><Control>32</Control></CourseControl>
      <CourseControl type="Finish"><Control>F1</Control></CourseControl>
    </Course>
    <ClassCourseAssignment>
      <ClassName>Klass A</ClassName>
      <CourseName>Öppen 5</CourseName>
    </ClassCourseAssignment>
  </RaceCourseData>
</CourseData>`;

const XML_WITHOUT_ASSIGNMENTS = XML_WITH_ASSIGNMENTS.replace(
  /<ClassCourseAssignment>[\s\S]*?<\/ClassCourseAssignment>/,
  "",
);

let ctx: TestEventContext;
let caller: ReturnType<typeof makeCaller>;
let ocdBase64: string;

beforeAll(async () => {
  ctx = await createTestEvent("course_class_fallback");
  caller = makeCaller(ctx.event);
  ocdBase64 = readFileSync(OCD_FIXTURE).toString("base64");

  // Classes matching two of the OCD's five course names (A–E).
  await ctx.db.class.create({
    data: { eventId: ctx.eventId, name: "A", sortIndex: 1 },
  });
  await ctx.db.class.create({
    data: { eventId: ctx.eventId, name: "C", sortIndex: 2 },
  });
}, 60_000);

afterAll(async () => {
  await ctx?.cleanup();
  await disconnect();
}, 30_000);

describe("course.previewImport class-name fallback", () => {
  it("suggests classes from course names when the OCD has no class records", async () => {
    const preview = await caller.course.previewImport({ ocdBase64 });

    expect(preview.classNamesFromCourseNames).toBe(true);
    expect(preview.courses.length).toBe(5);

    // Every course gets exactly one synthesized assignment row, so the
    // UI renders a mapping dropdown instead of the dead "None" row.
    for (const course of preview.courses) {
      expect(course.xmlClassNames).toEqual([course.name]);
      expect(course.classMatches.length).toBe(1);
    }

    const byName = new Map(preview.courses.map((c) => [c.name, c]));
    expect(byName.get("A")?.classMatches[0]).toMatchObject({
      matched: true,
      matchType: "exact",
      dbClassName: "A",
    });
    expect(byName.get("C")?.classMatches[0]).toMatchObject({
      matched: true,
      matchType: "exact",
      dbClassName: "C",
    });
    // No class named B/D/E exists — unmatched, but still mappable.
    expect(byName.get("B")?.classMatches[0]).toMatchObject({
      matched: false,
      matchType: "none",
    });
  });

  it("does not use the fallback when the file provides assignments", async () => {
    const preview = await caller.course.previewImport({
      xmlContent: XML_WITH_ASSIGNMENTS,
    });

    expect(preview.classNamesFromCourseNames).toBe(false);
    expect(preview.courses.length).toBe(1);
    expect(preview.courses[0].xmlClassNames).toEqual(["Klass A"]);
  });

  it("applies the fallback to IOF XML without ClassCourseAssignment too", async () => {
    const preview = await caller.course.previewImport({
      xmlContent: XML_WITHOUT_ASSIGNMENTS,
    });

    expect(preview.classNamesFromCourseNames).toBe(true);
    expect(preview.courses.length).toBe(1);
    expect(preview.courses[0].xmlClassNames).toEqual(["Öppen 5"]);
    expect(preview.courses[0].classMatches[0]).toMatchObject({
      matched: false,
      matchType: "none",
    });
  });

  it("importCourses assigns classes selected from fallback suggestions", async () => {
    // As the UI would do: course "A" mapped to DB class "A" (seq from
    // the preview), the rest skipped.
    const preview = await caller.course.previewImport({ ocdBase64 });
    const classA = preview.dbClasses.find((c) => c.name === "A");
    expect(classA).toBeDefined();

    const res = await caller.course.importCourses({
      ocdBase64,
      classMapping: { A: [classA!.id] },
    });
    expect(res.classesAssigned).toBe(1);

    const cls = await ctx.db.class.findFirst({
      where: { eventId: ctx.eventId, name: "A" },
      select: { course: { select: { name: true } } },
    });
    expect(cls?.course?.name).toBe("A");
  });
});
