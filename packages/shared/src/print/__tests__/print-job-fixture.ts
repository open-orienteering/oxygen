/**
 * The fixture print job (docs/course-print.md §8.6, G16): one job with
 * every sheet kind `maps.pdf` composes — a course sheet with copies, a
 * map exchange's two part sheets (`section`), the all-controls sheet
 * (sites whose names sort differently in Swedish and English) and a setter
 * sheet — on a window rotated by the meridian tilt, with a PNG and an SVG
 * page object and an SVG image course object on the map layer. Built with
 * the server's own row → sheet functions (`sheetForMapRow`), so it is the
 * job `buildPrintJob` would answer for such an event.
 *
 * The device's byte-identity tests compose it: the shared test against
 * `renderCoursePages`, the web worker's against `renderPrintJob`, and the
 * API's `print-device.test.ts` against the server's print worker.
 * Test-only (it reaches `print-document.ts`, which reads the fonts with
 * Node): imported by relative path, never from the module's index.
 */

import { defaultMapAppearance } from "../../course-maps/schema.js";
import { type MapRowContext, type PrintMapRow, sheetForMapRow } from "../../course-maps/sheet-rows.js";
import type { StoredCourseObject } from "../../course/objects.js";
import { PRINT_JOB_VERSION, type PrintJob } from "../print-job.js";

export { printDocumentBytes, bundledFontsForTest } from "./print-document.js";

/** The fixture's document hash (any string: hosts key their caches by it). */
export const FIXTURE_HASH = "f".repeat(64);

/** A 1 × 1 PNG (graphic 7). */
export const FIXTURE_PNG = Uint8Array.from(
  atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="),
  (c) => c.charCodeAt(0),
);
/** The SVG of graphics 8 and 9: a red box with a white dot. */
export const FIXTURE_SVG = new TextEncoder().encode(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 10"><rect width="20" height="10" fill="#c00"/><circle cx="10" cy="5" r="3" fill="#fff"/></svg>',
);
/** The job's graphics' bytes by id, as the event stores them. */
export const fixtureGraphics: ReadonlyMap<number, { mime: "image/png" | "image/svg+xml"; data: Uint8Array }> = new Map([
  [7, { mime: "image/png", data: FIXTURE_PNG }],
  [8, { mime: "image/svg+xml", data: FIXTURE_SVG }],
  [9, { mime: "image/svg+xml", data: FIXTURE_SVG }],
]);

const template = {
  paper: "A5",
  orientation: "landscape",
  paperWidthMm: null,
  paperHeightMm: null,
  printScale: 10000,
  settings: { printMarginMm: 3, mapFrame: { x: 8, y: 8, width: 194, height: 132 }, description: { visible: true, x: 150, y: 12, cellSizeMm: 5 }, appearance: defaultMapAppearance },
  objects: [
    { id: "logo-png", anchor: "page", kind: "image", graphicId: 7, x: 10, y: 10, width: 20, height: 10 },
    { id: "logo-svg", anchor: "page", kind: "image", graphicId: 8, x: 40, y: 10, width: 20, height: 10 },
    { id: "title", anchor: "page", kind: "text", text: "{course}", x: 70, y: 12, fontSizeMm: 4, color: "#000000" },
  ],
};

const site = (id: string, seq: number, codes: string, kind: string, xpos: number, ypos: number, name = "") =>
  ({ id, seq, codes, name, status: kind === "start" ? "start" : kind === "finish" ? "finish" : "ok", kind, xpos, ypos });

const S = site("S1", 1, "", "start", -30, -20, "Start 1");
const F = site("F1", 2, "", "finish", 30, 20, "Mål");
const A = site("A", 3, "31", "control", -15, 5);
const X = site("X", 4, "", "map_exchange", 0, -5, "Växling");
const B = site("B", 5, "32", "control", 15, -10);
const C = site("C", 6, "100", "control", 20, 15);
// Swedish sorts å after z, English after a: the all-controls and setter sheets order these by `compareLabels`.
const D = site("D", 7, "Å1", "control", -25, 15);
const E = site("E", 8, "Z1", "control", 25, -20);

const ctx: MapRowContext = {
  event: { name: "Fixture", date: new Date("2026-11-14T00:00:00Z") },
  allControls: [S, F, A, X, B, C, D, E],
  // Tilted: the window is rotated on the page (§4.2).
  mapInfo: { scale: 10000, meridianTiltDeg: 3 },
  courseObjects: [
    {
      id: "00000000-0000-4000-8000-000000000001",
      seq: 1,
      scope: { all: true },
      z: 0,
      version: 1n,
      kind: "image",
      geometry: [{ x: 5, y: 5 }, { x: 15, y: 10 }],
      props: { graphicId: 9 },
    } as StoredCourseObject,
  ],
};

const blue = {
  id: "course-blue",
  name: "Blue",
  lengthM: 2300,
  climbM: 45,
  orderMode: "ordered" as const,
  structure: null,
  startName: "Start 1",
  finishControlId: "F1",
  firstAsStart: false,
  lastAsFinish: false,
  descriptionInstructions: null,
  classes: [{ name: "H21" }, { name: "D21" }],
  courseControls: [{ control: A }, { control: X }, { control: B }],
};

const row = (over: Partial<PrintMapRow>): PrintMapRow => ({
  name: "Blue",
  kind: "course",
  overrides: {},
  objects: [],
  windowCenter: null,
  template,
  course: blue,
  ...over,
});

/** The job as `GET …/print-job` answers it: sheets in print order, graphics ascending. */
export function fixturePrintJob(): PrintJob {
  const sheets: PrintJob["sheets"] = [
    { ...sheetForMapRow(row({}), ctx), copies: 3 },
    sheetForMapRow(row({ sectionIndex: 1 }), ctx),
    sheetForMapRow(row({ name: "All controls", kind: "all_controls", course: null }), ctx),
    sheetForMapRow(row({ name: "Setter 1", kind: "setter", course: null, props: { setter: 1, controlIds: ["C", "D", "E"] } }), ctx),
  ];
  return {
    version: PRINT_JOB_VERSION,
    document: { hash: FIXTURE_HASH, rotationCorrectionDeg: 0 },
    // JSON-safe as the route answers it (§8.5).
    sheets: JSON.parse(JSON.stringify(sheets)) as PrintJob["sheets"],
    graphics: [...fixtureGraphics].map(([id, g]) => ({ id, mime: g.mime })),
    mode: "cmyk",
    info: { title: "Fixture maps" },
    filename: "Fixture_maps.pdf",
  };
}
