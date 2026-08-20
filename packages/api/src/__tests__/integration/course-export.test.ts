/**
 * Integration test for the IOF CourseData export.
 *
 * Seeds an event with a map (so the CRS/scale paths run), start/finish
 * controls, two courses and a class assignment, then round-trips the
 * exported XML back through the importer's parser and asserts the model
 * survived.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import {
  createTestEvent,
  disconnect,
  type TestEventContext,
} from "../helpers/test-db.js";
import { makeCaller } from "../helpers/caller.js";
import {
  buildEventCourseDataXml,
  buildCourseExportFilename,
} from "../../course-export.js";
import { parseIOFCourseData } from "../../iof-course-parser.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(__dirname, "../../../../../e2e/test.ocd");

let ctx: TestEventContext;
let caller: ReturnType<typeof makeCaller>;
let mapScale: number;

beforeAll(async () => {
  ctx = await createTestEvent("course_export");
  caller = makeCaller(ctx.event);

  const buf = readFileSync(FIXTURE);
  await caller.course.uploadMap({
    fileName: "test.ocd",
    fileDataBase64: buf.toString("base64"),
  });
  const meta = await caller.course.mapMetadata();
  mapScale = meta!.scale;

  // Event start/finish (legacy integer status codes at the boundary).
  await caller.control.create({ codes: "901", name: "Start", status: 4, xpos: 0, ypos: 0.5 });
  await caller.control.create({ codes: "902", name: "Mål", status: 5, xpos: 100, ypos: 0.5 });
  await caller.control.create({ codes: "31", xpos: 20, ypos: 0.5 });
  await caller.control.create({ codes: "32", xpos: 60, ypos: 0.5 });
  // Never placed: must not reach the XML.
  await caller.control.create({ codes: "33" });

  const a = await caller.course.create({ name: "Export A", controlIds: [31, 32] });
  await caller.course.create({ name: "Export B", controlIds: [32] });

  const cls = await caller.class.create({ name: "H21 Export" });
  await caller.class.update({ id: cls.id, courseId: a.id });
});

afterAll(async () => {
  await ctx.cleanup();
  await disconnect();
});

describe("buildEventCourseDataXml", () => {
  it("exports controls, courses and class assignments that round-trip", async () => {
    const xml = await buildEventCourseDataXml(ctx.db, {
      id: ctx.eventId,
      name: ctx.event.name,
    });
    const parsed = parseIOFCourseData(xml);

    expect(parsed.mapScale).toBe(mapScale);

    // Placed controls only, with the event start/finish typed as such.
    const ids = parsed.controls.map((c) => c.id);
    expect(ids).toContain("31");
    expect(ids).toContain("32");
    expect(ids).not.toContain("33");
    expect(parsed.controls.find((c) => c.id === "901")!.type).toBe("Start");
    expect(parsed.controls.find((c) => c.id === "902")!.type).toBe("Finish");
    // The fixture is georeferenced, so real WGS84 coordinates come along.
    const c31 = parsed.controls.find((c) => c.id === "31")!;
    expect(c31.mapX).toBe(20);
    expect(c31.lat).not.toBe(0);

    // Course sequences carry the event start/finish rows around the
    // course's own controls, mirroring the rendered geometry.
    const courseA = parsed.courses.find((c) => c.name === "Export A")!;
    expect(courseA.controls.map((cc) => cc.controlId)).toEqual([
      "901", "31", "32", "902",
    ]);
    expect(courseA.controls.map((cc) => cc.type)).toEqual([
      "Start", "Control", "Control", "Finish",
    ]);
    expect(courseA.length).toBeGreaterThan(0);
    // Legs come from the stored per-leg meters (3 legs for 4 rows).
    expect(courseA.controls.slice(1).every((cc) => cc.legLength > 0)).toBe(true);

    const courseB = parsed.courses.find((c) => c.name === "Export B")!;
    expect(courseB.controls.map((cc) => cc.controlId)).toEqual(["901", "32", "902"]);

    expect(parsed.classAssignments).toEqual([
      { className: "H21 Export", courseName: "Export A" },
    ]);
  });

  it("builds a safe attachment filename", () => {
    expect(buildCourseExportFilename("itest")).toBe("itest-courses.xml");
    expect(buildCourseExportFilename("a b/c")).toBe("a_b_c-courses.xml");
  });
});
