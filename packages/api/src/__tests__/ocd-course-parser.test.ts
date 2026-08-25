import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseOCDCourseData } from "../ocd-course-parser.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const COURSE_FIXTURE = resolve(__dirname, "../../../../e2e/test.ocd");

function ocdWithScaleParameter(scale: number): Buffer {
  const text = Buffer.from(
    `\tm${scale.toFixed(6)}\tg66.6667\tx679000\ty6572000\ti13002`,
    "utf8",
  );
  // Real maps often put parameter 1039 well beyond byte 50,000. The old
  // parser searched only the first 50 kB and silently fell back to 1:7500.
  const buf = Buffer.alloc(60_000);
  buf.writeUInt16LE(12, 4); // OCAD version
  buf.writeUInt32LE(64, 32); // first string-parameter index block
  // Block next pointer is already zero. First 16-byte entry starts at 68.
  buf.writeInt32LE(55_000, 68);
  buf.writeInt32LE(text.length, 72);
  buf.writeInt32LE(1039, 76); // OCAD scale/coordinate-system parameter
  text.copy(buf, 55_000);
  return buf;
}

describe("parseOCDCourseData map scale", () => {
  it("reads scale parameter 1039 instead of assuming 1:7500", () => {
    expect(parseOCDCourseData(ocdWithScaleParameter(15000)).mapScale).toBe(
      15000,
    );
  });

  it("keeps the legacy fallback when the file has no scale parameter", () => {
    const buf = Buffer.alloc(64);
    buf.writeUInt16LE(12, 4);
    expect(parseOCDCourseData(buf).mapScale).toBe(7500);
  });
});

describe("parseOCDCourseData leg lengths", () => {
  it("attaches each leg to its destination control, matching IOF CourseData", () => {
    const parsed = parseOCDCourseData(readFileSync(COURSE_FIXTURE));
    const course = parsed.courses[0];
    expect(course.controls[0].type).toBe("Start");
    expect(course.controls[0].legLength).toBe(0);
    expect(course.controls.at(-1)?.type).toBe("Finish");
    expect(course.controls.at(-1)?.legLength).toBeGreaterThan(0);
    expect(
      course.controls.reduce((sum, control) => sum + control.legLength, 0),
    ).toBeCloseTo(course.length, -1);
  });
});
