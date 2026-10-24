/**
 * Course scenes (docs/map-rendering.md §6.3, docs/course-layer.md
 * "Tests"): a small base map drawn with the canonical library on its
 * palette stack, plus a course layer from `courseLayer()`, merged with
 * `courseRenderInput()` exactly as a backend does. Each scene is a
 * pass-stream snapshot (`../streams/course/<name>.stream.json`) and a
 * golden image. Coordinates: paper mm in the course inputs, µm in the
 * base objects; y-up.
 */

import { type RenderPath, makePath } from "../../pass-stream.js";
import type { ColourStack, RenderSymbol } from "../../symbol.js";
import type { RenderObject } from "../../symbolise.js";
import { type SymbolLibraryId, materialiseLibrary } from "../../../symbol-library/index.js";
import type { DocumentColour } from "../../../map-document/header.js";
import { courseLayer, courseRenderInput } from "../../../course/layer.js";
import type { CourseLayer, CourseLayerInput, CourseSite, CourseStructure } from "../../../course/types.js";

export const courseSceneNames = ["course-legs", "course-cuts", "course-objects", "course-sprint", "course-all-controls"] as const;
export type CourseSceneName = (typeof courseSceneNames)[number];

export interface CourseScene {
  name: CourseSceneName;
  library: SymbolLibraryId;
  /** The completed stack the merged input is drawn with. */
  colours: ColourStack;
  symbols: RenderSymbol[];
  objects: RenderObject[];
  layer: CourseLayer;
  /** Index of the first course object in `objects`. */
  courseObjectOffset: number;
}

const mm = (v: number) => Math.round(v * 1000);
const line = (...pts: number[]): RenderPath => makePath(pts.map(mm));
const area = (...pts: number[]): RenderPath => makePath(pts.map(mm), undefined, true);
const at = (x: number, y: number): RenderPath => makePath([mm(x), mm(y)]);
const site = (id: string, kind: CourseSite["kind"], x: number, y: number, code = id): CourseSite => ({ id, code, kind, x, y });

/** The base map: library entries on the library's own palette stack, aligned as a matched document's would be. */
class BaseMap {
  readonly library: SymbolLibraryId;
  readonly symbols: RenderSymbol[] = [];
  readonly objects: RenderObject[] = [];
  readonly colours: DocumentColour[];
  private readonly lib: ReturnType<typeof materialiseLibrary>;
  private readonly at = new Map<string, number>();
  constructor(library: SymbolLibraryId) {
    this.library = library;
    this.lib = materialiseLibrary(library);
    this.colours = this.lib.colours.map((c) => ({ ...c, paletteIds: [c.id.slice(c.id.indexOf(":") + 1)] }));
  }
  add(code: string, path: RenderPath, angleDeg?: number): this {
    let i = this.at.get(code);
    if (i === undefined) {
      const k = this.lib.library.entries.findIndex((e) => e.id === `${this.library}:${code}`);
      if (k < 0) throw new Error(`no library entry ${this.library}:${code}`);
      i = this.symbols.length;
      this.symbols.push(this.lib.symbols[k]);
      this.at.set(code, i);
    }
    this.objects.push({ symbolIdx: i, path, ...(angleDeg ? { angleDeg } : {}) });
    return this;
  }
}

function scene(name: CourseSceneName, base: BaseMap, input: Omit<CourseLayerInput, "document">): CourseScene {
  const layer = courseLayer({ ...input, document: { colours: base.colours, libraryId: base.library, documentFactor: 1 } });
  const merged = courseRenderInput(base, layer);
  return { name, library: base.library, colours: layer.colours, symbols: merged.symbols, objects: merged.objects, layer, courseObjectOffset: merged.courseObjectOffset };
}

const ordered = (ids: string[], extra: Partial<CourseStructure> = {}): CourseStructure => ({ version: 1, id: "course", orderMode: "ordered", items: ids.map((siteId) => ({ siteId })), ...extra });

/** Start turned to 31, three legs over black, brown and blue line art; lower purple under it, sequence numbers. */
function legs(): CourseScene {
  const base = new BaseMap("ISOM2017-2")
    .add("401", area(0, 0, 50, 0, 50, 18, 0, 18))
    .add("505", line(0, 8, 50, 14))
    .add("101", line(30, 0, 34, 40))
    .add("306", line(12, 40, 44, 22))
    .add("516", line(4, 26, 46, 34));
  const sites = [site("S", "start", 6, 4, "S1"), site("31", "control", 24, 10), site("32", "control", 42, 30), site("33", "control", 16, 34), site("F", "finish", 6, 20, "F1")];
  return scene("course-legs", base, { structure: ordered(["S", "31", "32", "33", "F"]), sites, objects: [], appearance: {}, viewOptions: {} });
}

/** Automatic cuts at 204 / 109 features (document features), an authored gap, file-authored leg pieces and a manual number position. */
function cuts(): CourseScene {
  const base = new BaseMap("ISOM2017-2")
    .add("204", at(12.5, 10))
    .add("204", at(20, 15.2))
    .add("109", at(30, 22.5))
    .add("201", line(36, 2, 46, 6));
  const sites = [site("S", "start", 2, 10, "S1"), site("31", "control", 10, 10), site("32", "control", 30, 20), site("33", "control", 44, 10), site("F", "finish", 44, 26, "F1")];
  const structure = ordered([], {
    items: [
      { siteId: "S" },
      { siteId: "31" },
      { siteId: "32" },
      { siteId: "33", circleGaps: [{ start: 300, end: 330 }], leg: { pieces: [[{ x: 32.6, y: 18.6 }, { x: 37, y: 16 }], [{ x: 38.5, y: 15 }, { x: 41.5, y: 12 }]] } },
      { siteId: "F" },
    ],
    labelOffsets: { "33": { dx: 0, dy: -7 } },
  });
  // Radii of the drawn ISOM 204 (0.4 mm) and 109 (0.5 mm) — what `cutFeaturesOfDocument` would give.
  const cutFeatures = [{ x: 12.5, y: 10, r: 0.2 }, { x: 20, y: 15.2, r: 0.2 }, { x: 30, y: 22.5, r: 0.25 }];
  return scene("course-cuts", base, { structure, sites, objects: [], appearance: {}, viewOptions: {}, cutFeatures });
}

/** Layout objects and imported extras: white-out, toner-saver ring, 709 / 709.b, 707, 708, 711, map text. */
function objects(): CourseScene {
  const base = new BaseMap("ISOM2017-2")
    .add("406", area(0, 0, 50, 0, 50, 40, 0, 40))
    .add("505", line(2, 20, 48, 24))
    .add("106", line(4, 36, 46, 30));
  const sites = [site("S", "start", 6, 6, "S1"), site("31", "control", 26, 8), site("F", "finish", 44, 6, "F1")];
  const structure = ordered(["S", "31", "F"], {
    extras: [
      { kind: "marked_route", points: [{ x: 4, y: 12 }, { x: 4, y: 28 }] },
      { kind: "restricted_line", points: [{ x: 10, y: 30 }, { x: 22, y: 34 }] },
      { kind: "forbidden_route", points: [{ x: 28, y: 34 }, { x: 46, y: 36 }] },
    ],
  });
  const window = [{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 50, y: 40 }, { x: 0, y: 40 }];
  return scene("course-objects", base, {
    structure, sites, appearance: {}, viewOptions: { window, textValues: { course: "Bana 1" } },
    objects: [
      { id: "wo", anchor: "map", kind: "rectangle", x: 14, y: 16, width: 10, height: 10, fillMode: "whiteout" },
      { id: "oob", anchor: "map", kind: "rectangle", x: 30, y: 14, width: 8, height: 8, fillMode: "outOfBounds" },
      { id: "oob-b", anchor: "map", kind: "path", points: [{ x: 40, y: 14 }, { x: 48, y: 14 }, { x: 44, y: 22 }], fillMode: "outOfBounds", closed: true, stroke: "#a626ff", strokeWidthMm: 0.2 },
      { id: "ring", anchor: "map", kind: "path", points: [{ x: 2, y: 2 }, { x: 48, y: 2 }, { x: 48, y: 38 }, { x: 2, y: 38 }], fillMode: "whiteoutInverted", closed: true },
      { id: "title", anchor: "map", kind: "text", x: 8, y: 31, text: "{course}", fontSizeMm: 3, color: "#1f6fb2" },
    ],
  });
}

/** ISSprOM: 6 mm circles, upper-purple knockout numbers over a building, finish rings 5 / 7 mm. */
function sprint(): CourseScene {
  const base = new BaseMap("ISSprOM2019-2")
    .add("401", area(0, 0, 40, 0, 40, 30, 0, 30))
    .add("521", area(10, 6, 26, 6, 26, 20, 10, 20))
    .add("521", area(30, 18, 38, 18, 38, 28, 30, 28));
  const sites = [site("S", "start", 4, 4, "S1"), site("31", "control", 18, 22), site("32", "control", 34, 12), site("F", "finish", 34, 26, "F1")];
  return scene("course-sprint", base, { structure: ordered(["S", "31", "32", "F"]), sites, objects: [], appearance: { numberStyle: "knockout" }, viewOptions: {} });
}

/** All controls of an event (codes, no legs) with a free-order course: every site drawn, codes as numbers, start north. */
function allControls(): CourseScene {
  const base = new BaseMap("ISOM2017-2").add("403", area(0, 0, 44, 0, 44, 30, 0, 30)).add("304", area(26, 4, 36, 4, 36, 12, 26, 12));
  const sites = [
    site("S", "start", 6, 6, "S1"), site("41", "control", 18, 8), site("42", "control", 21, 12), site("57", "control", 14, 22),
    site("63", "control", 38, 24), site("100", "control", 30, 18), site("F", "finish", 6, 24, "F1"),
  ];
  const structure: CourseStructure = { version: 1, id: "free", orderMode: "free_order", items: ["S", "41", "57", "63", "F"].map((siteId) => ({ siteId })) };
  return scene("course-all-controls", base, { structure, sites, objects: [], appearance: {}, viewOptions: { allControls: true } });
}

const builders: Record<CourseSceneName, () => CourseScene> = {
  "course-legs": legs,
  "course-cuts": cuts,
  "course-objects": objects,
  "course-sprint": sprint,
  "course-all-controls": allControls,
};

export function courseScene(name: CourseSceneName): CourseScene {
  return builders[name]();
}

export function isCourseSceneName(name: string): name is CourseSceneName {
  return (courseSceneNames as readonly string[]).includes(name);
}

