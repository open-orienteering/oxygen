/**
 * Page scenes (docs/course-print.md §7.5 tests; research 05 §7 tier 3): an
 * A4 sprint page with a description block, a white-out-outside ring
 * with page objects, a rotated window, and objects with opacity,
 * Multiply and rotation (J4), and graphics (J5) — each a `PageInput` the
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
import { luckaPng, stripesPng } from "./png.js";

export const pageSceneNames = ["page-sprint-a4", "page-ring", "page-rotated", "page-objects-alpha", "page-graphics"] as const;
export type PageSceneName = (typeof pageSceneNames)[number];

const mm = (v: number) => Math.round(v * 1000);
const line = (...pts: number[]): RenderPath => makePath(pts.map(mm));
const area = (...pts: number[]): RenderPath => makePath(pts.map(mm), undefined, true);
const at = (x: number, y: number): RenderPath => makePath([mm(x), mm(y)]);
const site = (id: string, kind: CourseSite["kind"], x: number, y: number, code = id): CourseSite => ({ id, code, kind, x, y });
const ordered = (ids: string[]): CourseStructure => ({ version: 1, id: "course", orderMode: "ordered", items: ids.map((siteId) => ({ siteId })) });

function input(base: BaseMap, rest: Omit<PageInput, "map">): PageInput {
  return { ...rest, map: { objects: base.objects, symbols: base.symbols, context: base.context() } };
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
    course: { structure: ordered(["S", "31", "32", "33", "34", "F"]), sites, appearance: {}, viewOptions: {} },
    objects: [{ id: "title", anchor: "page", kind: "text", x: 14, y: 282, text: "{event} · {course}", fontSizeMm: 5, color: "#000000" }],
    textValues: { event: "Sprint-SM", course: "A" },
    description: { x: 137, y: 14, cellSizeMm: 7, rows: sheet.rows, header: sheet.header, title: "A" },
    label: "A",
  });
}

/** Toner saver: a `toner_saver` course object (F12's form of a map-anchored white-out outside), a page white-out over the frame edge, page text and line. */
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
    { id: "box", anchor: "page", kind: "rectangle", x: 84, y: 62, width: 32, height: 24, fillMode: "whiteout", stroke: "#000000", strokeWidthMm: 0.3 },
    { id: "name", anchor: "page", kind: "text", x: 100, y: 72, text: "{course}", fontSizeMm: 4, color: "#000000", align: "center" },
    { id: "rule", anchor: "page", kind: "line", x1: 88, y1: 76, x2: 112, y2: 76, stroke: "#1f6fb2", strokeWidthMm: 0.5, dash: "dashed" },
  ];
  return input(base, {
    paper: { widthMm: 120, heightMm: 90 },
    frame,
    window,
    course: {
      structure: ordered(["S", "31", "32", "F"]), sites, appearance: {}, viewOptions: {},
      objects: [{ id: "ring", kind: "toner_saver", geometry: [{ x: -38, y: -32 }, { x: 38, y: -32 }, { x: 38, y: 28 }, { x: -38, y: 28 }], props: {} }],
    },
    objects,
    textValues: { course: "Bana 2" },
    description: null,
    label: "Bana 2",
  });
}

/** A window rotated 20° clockwise on the page (meridian tilt −20°): map, course and a text course object turn together. */
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
    course: {
      structure: ordered(["S", "31", "32", "F"]), sites, appearance: {}, viewOptions: {},
      objects: [{ id: "north", kind: "text", geometry: [{ x: -32, y: 4 }], props: { text: "N", fontSizeMm: 5, color: "#000000" } }],
    },
    objects: [],
    textValues: {},
    description: null,
    label: "Rotated",
  });
}

/**
 * Opacity, Multiply and rotation on layout and course objects (J4), over
 * `page-ring`'s map and course without its toner saver: a 50 % filled and
 * stroked rectangle (the stroke's inner half shows over the fill), a
 * Multiply rectangle over map and purple (the page layer multiplies the map
 * layer: the cross-layer case), a 30° white-out at 60 %, a 20° text at
 * 50 %, a 50 % page 709, and a 50 % white-out and a turned 60 % text as
 * course objects.
 */
function objectsAlpha(): PageInput {
  const base = ring();
  const objects: CourseMapObject[] = [
    { id: "glass", anchor: "page", kind: "rectangle", x: 16, y: 14, width: 24, height: 14, fillMode: "solid", fill: "#1f6fb2", stroke: "#000000", strokeWidthMm: 0.8, opacity: 0.5 },
    { id: "lucka", anchor: "page", kind: "rectangle", x: 48, y: 31, width: 18, height: 15, fillMode: "solid", fill: "#ffd400", blend: "multiply" },
    { id: "veil", anchor: "page", kind: "rectangle", x: 72, y: 16, width: 22, height: 12, fillMode: "whiteout", rotationDeg: 30, opacity: 0.6 },
    { id: "label", anchor: "page", kind: "text", x: 18, y: 72, text: "Lucka 24", fontSizeMm: 5, color: "#000000", rotationDeg: 20, opacity: 0.5 },
    { id: "keep-out", anchor: "page", kind: "rectangle", x: 80, y: 54, width: 20, height: 14, fillMode: "outOfBounds", opacity: 0.5 },
  ];
  return {
    ...base,
    course: {
      ...base.course,
      objects: [
        { id: "mist", kind: "whiteout", geometry: [{ x: -46, y: -30 }, { x: -30, y: -30 }, { x: -30, y: -16 }, { x: -46, y: -16 }], props: { opacity: 0.5 } },
        { id: "tag", kind: "text", geometry: [{ x: 8, y: -26 }], props: { text: "Lusse", fontSizeMm: 4, color: "#000000", rotationDeg: -15, opacity: 0.6 } },
      ],
    },
    objects,
    label: "Objects alpha",
  };
}

/**
 * Graphics (J5): the lucka PNG (opaque red band, half-opaque gold band,
 * transparent middle) around control 31 as a course image, turned 15° at
 * 70 % around control 32, as a Multiply page image over map and purple, and
 * a striped RGB graphic cropped to its middle half, flipped and turned −20°
 * on the page — over `page-ring`'s map without its toner saver.
 */
function graphics(): PageInput {
  const base = ring();
  const objects: CourseMapObject[] = [
    { id: "stamp", anchor: "page", kind: "image", graphicId: LUCKA, x: 76, y: 12, width: 20, height: 20, blend: "multiply" },
    { id: "badge", anchor: "page", kind: "image", graphicId: STRIPES, x: 14, y: 58, width: 24, height: 16, crop: { x: 0.25, y: 0, width: 0.5, height: 1 }, rotationDeg: -20, flipH: true },
  ];
  return {
    ...base,
    course: {
      ...base.course,
      objects: [
        { id: "lucka-31", kind: "image", geometry: [{ x: -12, y: -2 }, { x: 4, y: 14 }], props: { graphicId: LUCKA } },
        { id: "lucka-32", kind: "image", geometry: [{ x: 17, y: 12 }, { x: 33, y: 28 }], props: { graphicId: LUCKA, rotationDeg: 15, opacity: 0.7 } },
      ],
    },
    objects,
    label: "Graphics",
  };
}

const LUCKA = 1;
const STRIPES = 2;

/** The PNG bytes a page scene's images draw, by graphic id (empty for scenes without images). */
export function pageSceneGraphics(name: PageSceneName): ReadonlyMap<number, Uint8Array> {
  return name === "page-graphics" ? new Map([[LUCKA, luckaPng(64)], [STRIPES, stripesPng()]]) : new Map();
}

const builders: Record<PageSceneName, () => PageInput> = { "page-sprint-a4": sprintA4, "page-ring": ring, "page-rotated": rotated, "page-objects-alpha": objectsAlpha, "page-graphics": graphics };

export function pageScene(name: PageSceneName): PageInput {
  return builders[name]();
}
