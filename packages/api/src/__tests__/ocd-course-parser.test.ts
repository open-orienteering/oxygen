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

/**
 * A minimal OCAD 12 course file: one course "Gapped" (STA1 → 71 → 72 → FIN1)
 * with a slit on 71, two 705 pieces on 71 → 72, a 707, a 708, a 709
 * line, a 711 and a 709 polygon.
 */
function syntheticCourseFile(): Buffer {
  const raw = (mm: number) => Math.round(mm * 100) * 256;
  const objects: { sym: number; type: number; coords: [number, number][]; text: string }[] = [
    { sym: 701000, type: 1, coords: [[10, 10]], text: "STA1" },
    // Two slit pairs after the centre: raw X = end angle, raw Y = start angle, tenths of a degree CCW from east.
    { sym: 702000, type: 1, coords: [[20, 10]], text: "a71\td2.004" },
    { sym: 702000, type: 1, coords: [[120, 10]], text: "a72" },
    { sym: 706000, type: 1, coords: [[130, 10]], text: "FIN1" },
    { sym: 705000, type: 2, coords: [[25, 10], [60, 10]], text: "Gapped\tf71\tt72" },
    { sym: 705000, type: 2, coords: [[80, 10], [115, 10]], text: "Gapped\tf71\tt72" },
    { sym: 707000, type: 2, coords: [[1, 1], [2, 2]], text: "1T1" },
    { sym: 708000, type: 2, coords: [[3, 3], [4, 4]], text: "" },
    { sym: 709000, type: 2, coords: [[5, 5], [6, 6]], text: "" },
    { sym: 711000, type: 2, coords: [[7, 7], [8, 8]], text: "" },
    { sym: 709000, type: 3, coords: [[0, 0], [5, 0], [5, 5]], text: "" },
  ];
  const slit = { start: 100, end: 300 }; // compass degrees; OCAD tenths CCW from east = (90 − compass) × 10
  const slitRaw = (compass: number) => (90 - compass) * 10;
  const stringParam = Buffer.from("Gapped\tsSTA1\tfFIN1\tc71\tc72\tmT1", "utf8");

  const buf = Buffer.alloc(4096);
  buf.writeUInt16LE(12, 4);
  const stringIndex = 256, objIndex = 512;
  buf.writeUInt32LE(objIndex, 12);
  buf.writeUInt32LE(stringIndex, 32);
  // String parameter block: next = 0, entry 0 = (pos, len, type 7).
  const stringPos = 400;
  buf.writeInt32LE(stringPos, stringIndex + 4);
  buf.writeInt32LE(stringParam.length, stringIndex + 8);
  buf.writeInt32LE(7, stringIndex + 12);
  stringParam.copy(buf, stringPos);

  let pos = 1024;
  objects.forEach((o, i) => {
    const slits = o.text.startsWith("a71") ? [slit] : [];
    const coords = [...o.coords.map(([x, y]) => [raw(x), raw(y)] as [number, number]), ...slits.map((s) => [slitRaw(s.end), slitRaw(s.start)] as [number, number])];
    const text = Buffer.from(o.text, "utf16le");
    const len = 56 + coords.length * 8 + text.length + 2;
    const e = objIndex + 4 + i * 40;
    buf.writeUInt32LE(pos, e + 16);
    buf.writeUInt32LE(len, e + 20);
    buf.writeInt32LE(o.sym, e + 24);
    buf.writeUInt8(o.type, e + 28);
    buf.writeUInt32LE(coords.length, pos + 44);
    buf.writeUInt16LE(Math.ceil((text.length + 2) / 8), pos + 48);
    coords.forEach(([x, y], k) => {
      buf.writeInt32LE(x, pos + 56 + k * 8);
      buf.writeInt32LE(y, pos + 60 + k * 8);
    });
    text.copy(buf, pos + 56 + coords.length * 8);
    pos += Math.ceil(len / 8) * 8;
  });
  return buf.subarray(0, pos);
}

describe("parseOCDCourseData authored geometry (D1)", () => {
  const parsed = parseOCDCourseData(syntheticCourseFile());

  it("fills ParsedControl.cuts from the slits (compass degrees)", () => {
    const c = parsed.controls.find((x) => x.id === "71")!;
    expect(c.cuts).toEqual([{ start: 100, end: 300 }]);
    expect(parsed.controls.find((x) => x.id === "72")!.cuts).toBeUndefined();
    expect(parsed.controls.find((x) => x.id === "STA1")!.cuts).toBeUndefined();
  });

  it("emits 705 pieces, 707 / 708 / 709 / 711 lines and the 709 polygon in the course geometry", () => {
    const features = parsed.courseGeometry.Gapped.features;
    const kinds = features.map((f) => (f.properties as { symbolType: string; sym?: number }).symbolType);
    expect(features.filter((f) => (f.properties as { preclipped?: boolean }).preclipped)).toHaveLength(2);
    expect(kinds.filter((k) => k === "restricted_line")).toHaveLength(2); // 708 and 709
    expect(features.filter((f) => (f.properties as { sym?: number }).sym === 708000)).toHaveLength(1);
    expect(kinds).toContain("forbidden_route");
    expect(kinds).toContain("restricted_area");
    expect(kinds).toContain("marked_route");
  });
});
