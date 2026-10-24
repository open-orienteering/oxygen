/**
 * Page scenes (docs/course-print.md §7.5 tests; research 05 §7 tier 3): an
 * A4 sprint page with a description block, a white-out-outside ring
 * with page objects, and a rotated window — each a `PageInput` the
 * composer turns into layers. The reference raster draws them now (the
 * page oracle in `packages/api/src/render/page-raster.ts`); the PDF tier
 * compares against the same images in C3.
 *
 * Frames sit on whole 0.1 mm so their edges fall on golden pixels.
 */

import { mapWindowForFrame } from "../../course-maps/geometry.js";
import { buildDescriptionSheet } from "../../course-maps/description-rows.js";
import type { CourseMapObject } from "../../course-maps/schema.js";
import type { CourseSite, CourseStructure } from "../../course/types.js";
import { makePath, type RenderPath } from "../../render/pass-stream.js";
import { BaseMap } from "../../render/__fixtures__/course/index.js";
import type { PageInput } from "../page.js";

export const pageSceneNames = ["page-sprint-a4", "page-ring", "page-rotated"] as const;
export type PageSceneName = (typeof pageSceneNames)[number];

const mm = (v: number) => Math.round(v * 1000);
const line = (...pts: number[]): RenderPath => makePath(pts.map(mm));
const area = (...pts: number[]): RenderPath => makePath(pts.map(mm), undefined, true);
const at = (x: number, y: number): RenderPath => makePath([mm(x), mm(y)]);
const site = (id: string, kind: CourseSite["kind"], x: number, y: number, code = id): CourseSite => ({ id, code, kind, x, y });
const ordered = (ids: string[]): CourseStructure => ({ version: 1, id: "course", orderMode: "ordered", items: ids.map((siteId) => ({ siteId })) });

function input(base: BaseMap, rest: Omit<PageInput, "map">): PageInput {
  return { ...rest, map: { objects: base.objects, symbols: base.symbols, context: { colours: base.colours, libraryId: base.library, documentFactor: 1 } } };
}

/** A4 portrait sprint page: ISSprOM map at 1:4 000 printed at 1:3 000, header block with pictograms, title text. */
function sprintA4(): PageInput {
  const base = new BaseMap("ISSprOM2019-2")
    .add("401", area(-80, -110, 80, -110, 80, 110, -80, 110))
    .add("521", area(-40, -30, -10, -30, -10, 10, -40, 10))
    .add("521", area(10, 20, 50, 20, 50, 50, 10, 50))
    .add("521", area(-60, 50, -20, 50, -20, 80, -60, 80))
    .add("501", area(-80, -70, 80, -70, 80, -64, -80, -64))
    .add("529", area(20, -50, 60, -50, 60, -20, 20, -20));
  const sites = [
    site("S", "start", -50, -85, "S1"), site("31", "control", -10, -40), site("32", "control", 40, 0),
    site("33", "control", 0, 60), site("34", "control", -50, 30), site("F", "finish", -60, -50, "F1"),
  ];
  const frame = { x: 10, y: 10, width: 190, height: 277 };
  const window = mapWindowForFrame(frame, { x: 0, y: 0 }, 4000, 3000);
  const sheet = buildDescriptionSheet({
    eventName: "Sprint-SM",
    classNames: ["H21", "D21"],
    courseName: "A",
    lengthM: 2400,
    climbM: 15,
    controls: [
      { id: 1, code: "31", description: { d: "1.010" } },
      { id: 2, code: "32", description: { c: "0.003", d: "3.002", g: "11.104" } },
      { id: 3, code: "33", description: { d: "2.004", s: "1,5" } },
      { id: 4, code: "34", description: { d: "1.010", e: "8.001" } },
    ],
    finishLengthM: 120,
  });
  return input(base, {
    paper: { widthMm: 210, heightMm: 297 },
    frame,
    window,
    course: { structure: ordered(["S", "31", "32", "33", "34", "F"]), sites, appearance: {}, viewOptions: { overprintScale: 4000 / 3000 } },
    objects: [{ id: "title", anchor: "page", kind: "text", x: 14, y: 282, text: "{event} · {course}", fontSizeMm: 5, color: "#000000" }],
    textValues: { event: "Sprint-SM", course: "A" },
    description: { x: 137, y: 14, cellSizeMm: 7, rows: sheet.rows, header: sheet.header, title: "A" },
    label: "A",
  });
}

/** Toner saver: a map-anchored white-out-outside ring, a page white-out over the frame edge, page text and line. */
function ring(): PageInput {
  const base = new BaseMap("ISOM2017-2")
    .add("406", area(-60, -50, 60, -50, 60, 50, -60, 50))
    .add("505", line(-60, -10, 60, 14))
    .add("106", line(-50, 40, 50, 30))
    .add("304", area(10, -30, 30, -30, 30, -15, 10, -15));
  const sites = [site("S", "start", -30, -25, "S1"), site("31", "control", -4, 6), site("32", "control", 25, 20), site("F", "finish", 35, -10, "F1")];
  const frame = { x: 8, y: 8, width: 104, height: 74 };
  const window = mapWindowForFrame(frame, { x: 0, y: 0 }, 10000, 10000);
  const objects: CourseMapObject[] = [
    { id: "ring", anchor: "map", kind: "path", points: [{ x: -38, y: -32 }, { x: 38, y: -32 }, { x: 38, y: 28 }, { x: -38, y: 28 }], fillMode: "whiteoutInverted", closed: true },
    { id: "box", anchor: "page", kind: "rectangle", x: 84, y: 62, width: 32, height: 24, fillMode: "whiteout", stroke: "#000000", strokeWidthMm: 0.3 },
    { id: "name", anchor: "page", kind: "text", x: 100, y: 72, text: "{course}", fontSizeMm: 4, color: "#000000", align: "center" },
    { id: "rule", anchor: "page", kind: "line", x1: 88, y1: 76, x2: 112, y2: 76, stroke: "#1f6fb2", strokeWidthMm: 0.5, dash: "dashed" },
  ];
  return input(base, {
    paper: { widthMm: 120, heightMm: 90 },
    frame,
    window,
    course: { structure: ordered(["S", "31", "32", "F"]), sites, appearance: {}, viewOptions: {} },
    objects,
    textValues: { course: "Bana 2" },
    description: null,
    label: "Bana 2",
  });
}

/** A window rotated 20° clockwise on the page (meridian tilt −20°): map, course and a map-anchored text turn together. */
function rotated(): PageInput {
  const base = new BaseMap("ISOM2017-2")
    .add("401", area(-70, -60, 70, -60, 70, 60, -70, 60))
    .add("521", area(-10, -10, 10, -10, 10, 10, -10, 10))
    .add("505", line(-70, -30, 70, -30))
    .add("112", at(-30, 25));
  const sites = [site("S", "start", -35, -40, "S1"), site("31", "control", 20, -20), site("32", "control", 25, 25), site("F", "finish", -20, 30, "F1")];
  const frame = { x: 8, y: 8, width: 104, height: 74 };
  const window = mapWindowForFrame(frame, { x: 0, y: 0 }, 10000, 10000, 20);
  return input(base, {
    paper: { widthMm: 120, heightMm: 90 },
    frame,
    window,
    course: { structure: ordered(["S", "31", "32", "F"]), sites, appearance: {}, viewOptions: {} },
    objects: [{ id: "north", anchor: "map", kind: "text", x: -32, y: 4, text: "N", fontSizeMm: 5, color: "#000000" }],
    textValues: {},
    description: null,
    label: "Rotated",
  });
}

const builders: Record<PageSceneName, () => PageInput> = { "page-sprint-a4": sprintA4, "page-ring": ring, "page-rotated": rotated };

export function pageScene(name: PageSceneName): PageInput {
  return builders[name]();
}
