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
import type { CourseDocumentContext, CourseLayer, CourseLayerInput, CourseSite, CourseStructure } from "../../../course/types.js";

export const courseSceneNames = ["course-legs", "course-cuts", "course-objects", "course-sprint", "course-all-controls", "course-leg-styles", "course-corridor", "course-exchange", "course-legs-curved"] as const;
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
export class BaseMap {
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
  /** The course layer's context: the library at factor 1, so the map is at the library's reference scale. */
  context(): CourseDocumentContext {
    return { colours: this.colours, libraryId: this.library, documentFactor: 1, mapScale: this.lib.library.referenceScale };
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
  const layer = courseLayer({ ...input, document: base.context() });
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

/** Automatic cuts at 204 / 109 features (document features), an authored gap, an authored leg gap and a manual number position. */
function cuts(): CourseScene {
  const base = new BaseMap("ISOM2017-2")
    .add("204", at(12.5, 10))
    .add("204", at(20, 15.2))
    .add("109", at(30, 22.5))
    .add("201", line(36, 2, 46, 6));
  const sites = [site("S", "start", 2, 10, "S1"), site("31", "control", 10, 10), site("32", "control", 30, 20), { ...site("33", "control", 44, 10), circleGaps: [{ start: 300, end: 330 }] }, site("F", "finish", 44, 26, "F1")];
  const structure = ordered([], {
    items: [
      { siteId: "S" },
      { siteId: "31" },
      { siteId: "32" },
      { siteId: "33", leg: { gaps: [{ from: 0.4, to: 0.6 }] } },
      { siteId: "F" },
    ],
    labelOffsets: { "33": { dx: 0, dy: -7 } },
  });
  // Radii of the drawn ISOM 204 (0.4 mm) and 109 (0.5 mm) — what `cutFeaturesOfDocument` would give.
  const cutFeatures = [{ x: 12.5, y: 10, r: 0.2 }, { x: 20, y: 15.2, r: 0.2 }, { x: 30, y: 22.5, r: 0.25 }];
  return scene("course-cuts", base, { structure, sites, objects: [], appearance: {}, viewOptions: {}, cutFeatures });
}

/**
 * Course objects: 707, 708, 711, and the former map-anchored layout objects as F12 moved them (white-out, toner-saver
 * ring, 709 / 709.b, text) — the scene is the one they drew before (course-layer.md §3.6).
 */
function objects(): CourseScene {
  const base = new BaseMap("ISOM2017-2")
    .add("406", area(0, 0, 50, 0, 50, 40, 0, 40))
    .add("505", line(2, 20, 48, 24))
    .add("106", line(4, 36, 46, 30));
  const sites = [site("S", "start", 6, 6, "S1"), site("31", "control", 26, 8), site("F", "finish", 44, 6, "F1")];
  const structure = ordered(["S", "31", "F"]);
  const window = [{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 50, y: 40 }, { x: 0, y: 40 }];
  return scene("course-objects", base, {
    structure, sites, appearance: {}, viewOptions: { window, textValues: { course: "Bana 1" } },
    objects: [
      { id: 1, kind: "marked_route", geometry: [{ x: 4, y: 12 }, { x: 4, y: 28 }], props: {} },
      { id: 2, kind: "oob_line", geometry: [{ x: 10, y: 30 }, { x: 22, y: 34 }], props: {} },
      { id: 3, kind: "oob_line", geometry: [{ x: 28, y: 34 }, { x: 46, y: 36 }], props: { symbol: "711" } },
      { id: "wo", kind: "whiteout", geometry: [{ x: 14, y: 16 }, { x: 24, y: 16 }, { x: 24, y: 26 }, { x: 14, y: 26 }], props: {} },
      { id: "oob", kind: "oob_area", geometry: [{ x: 30, y: 14 }, { x: 38, y: 14 }, { x: 38, y: 22 }, { x: 30, y: 22 }], props: {} },
      { id: "oob-b", kind: "oob_area", geometry: [{ x: 40, y: 14 }, { x: 48, y: 14 }, { x: 44, y: 22 }], props: { border: "solid" } },
      { id: "ring", kind: "toner_saver", geometry: [{ x: 2, y: 2 }, { x: 48, y: 2 }, { x: 48, y: 38 }, { x: 2, y: 38 }], props: {} },
      { id: "title", kind: "text", geometry: [{ x: 8, y: 31 }], props: { text: "{course}", fontSizeMm: 3, color: "#1f6fb2" } },
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

/** Leg styles and bends (F1): a bent 705 over a black path, a bent 707 marked route over a power line, a `none` leg with a stored gap. */
function legStyles(): CourseScene {
  const base = new BaseMap("ISOM2017-2")
    .add("401", area(0, 0, 50, 0, 50, 36, 0, 36))
    .add("505", line(0, 13, 50, 19))
    .add("516", line(33, 0, 35, 36));
  const sites = [site("S", "start", 6, 4, "S1"), site("31", "control", 24, 6), site("32", "control", 42, 28), site("F", "finish", 10, 30, "F1")];
  const structure = ordered([], {
    items: [
      { siteId: "S" },
      { siteId: "31", leg: { bends: [{ x: 14, y: 20 }] } },
      { siteId: "32", leg: { style: "marked_route", bends: [{ x: 40, y: 8 }] } },
      { siteId: "F", leg: { style: "none", gaps: [{ from: 0.4, to: 0.6 }] } },
    ],
  });
  return scene("course-leg-styles", base, { structure, sites, objects: [], appearance: {}, viewOptions: {} });
}

/**
 * Corridors (F2, F19; course-layer.md §10.2): S → 31 → 32 one narrow run, 60 m (4 mm, h 2 < R 2.5) with its edge and
 * a 3 mm band, bent at (36, 10); 32 → 33 a 150 m corridor without edge (h 5 ≥ R: a change of width at 32); 33 → F
 * plain. The 701 and every circle the corridors end at are mouths: the map shows inside them and the band wraps
 * them. The edges end on the triangle and on 31's circle, which opens towards both legs; 32's circle stays whole
 * (the wide corridor covers the narrow one's junctions there), as does 33's. The band is a clip region: the 505,
 * 101 and 516 are cut away in it, the course draws over it.
 */
function corridor(): CourseScene {
  const base = new BaseMap("ISOM2017-2")
    .add("401", area(0, 0, 50, 0, 50, 40, 0, 40))
    .add("505", line(0, 14, 50, 20))
    .add("101", line(28, 0, 30, 40))
    .add("516", line(4, 24, 46, 36));
  const sites = [site("S", "start", 6, 6, "S1"), site("31", "control", 22, 8), site("32", "control", 40, 24), site("33", "control", 20, 32), site("F", "finish", 6, 30, "F1")];
  const narrow = { widthM: 60, edge: true, whiteMm: 3, whiteOpacity: 1 };
  const structure = ordered([], {
    items: [
      { siteId: "S" },
      { siteId: "31", leg: { corridor: narrow } },
      { siteId: "32", leg: { bends: [{ x: 36, y: 10 }], corridor: narrow } },
      { siteId: "33", leg: { corridor: { widthM: 150, edge: false, whiteMm: 2, whiteOpacity: 0.5 } } },
      { siteId: "F" },
    ],
  });
  return scene("course-corridor", base, { structure, sites, objects: [], appearance: {}, viewOptions: {} });
}

/**
 * Map exchange (F5, course-layer.md §11): S → 31 → 32 (exchange) → 33 → F drawn as part 2 alone — the
 * exchange a numbered circle ("2"), no start triangle, legs 32 → 33 → F, 33 numbered "3" (numbering continues).
 */
function exchange(): CourseScene {
  const base = new BaseMap("ISOM2017-2")
    .add("401", area(0, 0, 50, 0, 50, 36, 0, 36))
    .add("505", line(0, 18, 50, 22));
  const sites = [site("S", "start", 6, 6, "S1"), site("31", "control", 22, 8), site("32", "map_exchange", 40, 12, "32"), site("33", "control", 30, 30), site("F", "finish", 8, 28, "F1")];
  return scene("course-exchange", base, { structure: ordered(["S", "31", "32", "33", "F"]), sites, objects: [], appearance: {}, viewOptions: { section: 1 } });
}

/**
 * Curved bends (F13, course-layer.md §10.1): S → 31 straight, 31 → 32 a 705 curved through one smooth bend,
 * 32 → 33 a curved 707, 33 → F curved through a crossing point joined on its curved segment. The legs stay
 * polylines in the stream: the curves flattened at 5 µm.
 */
function legsCurved(): CourseScene {
  const base = new BaseMap("ISOM2017-2")
    .add("401", area(0, 0, 50, 0, 50, 36, 0, 36))
    .add("505", line(0, 18, 50, 14));
  const sites = [
    site("S", "start", 6, 4, "S1"), site("31", "control", 24, 6), site("32", "control", 42, 28), site("33", "control", 24, 30),
    site("F", "finish", 8, 30, "F1"), site("P", "crossing_point", 21.5, 28, "P1"),
  ];
  const structure = ordered([], {
    items: [
      { siteId: "S" },
      { siteId: "31" },
      { siteId: "32", leg: { bends: [{ x: 40, y: 12, hIn: { x: -2, y: -5 }, hOut: { x: 2, y: 5 } }] } },
      { siteId: "33", leg: { style: "marked_route", bends: [{ x: 33, y: 33, hIn: { x: 4, y: 0 }, hOut: { x: -4, y: 0 } }] } },
      { siteId: "F", leg: { bends: [{ x: 16, y: 26, hIn: { x: 4, y: 0 }, hOut: { x: -4, y: 0 } }], crossing: { controlId: "P" } } },
    ],
  });
  return scene("course-legs-curved", base, { structure, sites, objects: [], appearance: {}, viewOptions: {} });
}

const builders: Record<CourseSceneName, () => CourseScene> = {
  "course-legs": legs,
  "course-cuts": cuts,
  "course-objects": objects,
  "course-sprint": sprint,
  "course-all-controls": allControls,
  "course-leg-styles": legStyles,
  "course-corridor": corridor,
  "course-exchange": exchange,
  "course-legs-curved": legsCurved,
};

export function courseScene(name: CourseSceneName): CourseScene {
  return builders[name]();
}

export function isCourseSceneName(name: string): name is CourseSceneName {
  return (courseSceneNames as readonly string[]).includes(name);
}

