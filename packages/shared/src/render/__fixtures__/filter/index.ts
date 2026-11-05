/**
 * Filter-region scenes (docs/map-rendering.md §4.11, §6.3; research 04 §8
 * row "Filter regions"): an ISOM base map of 101 contours, 505 footpaths
 * and a 407 area under one tilted pentagon, entered through
 * `courseLayer({ regions })` and `courseRenderInput()` exactly as a
 * backend does. Each scene is a pass-stream snapshot
 * (`../streams/filter/<name>.stream.json`) and a golden image.
 * Coordinates: paper mm in the region rings, µm in the base objects; y-up.
 */

import { makePath } from "../../pass-stream.js";
import type { ColourStack, RenderSymbol } from "../../symbol.js";
import type { RenderObject } from "../../symbolise.js";
import type { FilterRegion } from "../../filter-region.js";
import type { MapPoint } from "../../../course-maps/schema.js";
import type { CourseFilterRegion } from "../../../course/types.js";
import { courseLayer, courseRenderInput } from "../../../course/layer.js";
import { BaseMap } from "../course/index.js";

export const filterSceneNames = ["filter-clip-brown", "filter-hide-505", "filter-moved", "filter-show-only"] as const;
export type FilterSceneName = (typeof filterSceneNames)[number];

export interface FilterScene {
  name: FilterSceneName;
  colours: ColourStack;
  symbols: RenderSymbol[];
  objects: RenderObject[];
  regions: FilterRegion[];
  regionObjectLimit: number;
}

const mm = (v: number) => Math.round(v * 1000);
const line = (...pts: number[]) => makePath(pts.map(mm));
/** A cubic Bézier: anchor, two controls, anchor (mm). */
const curve = (...pts: number[]) => makePath(pts.map(mm), [0, 1, 2, 0]);
const area = (...pts: number[]) => makePath(pts.map(mm), undefined, true);

/** ISOM2017-2 symbols of the base, in `BaseMap.add` order. */
export const FILTER_SYMBOL = { area407: 0, contour101: 1, footpath505: 2 } as const;
/** The 101 brown in the library palette stack (`brown100-line`), below upper white: the course stack keeps it. */
export const FILTER_BROWN = 20;

/**
 * Base objects (indices in order): 0 the 407 area; 1 a straight contour
 * through the pentagon, 2 a curved one through it, 3 a contour below it;
 * 4 a footpath through the pentagon, 5 a footpath right of it (inside the
 * moved pentagon), 6 a footpath above both.
 */
function base(): BaseMap {
  return new BaseMap("ISOM2017-2")
    .add("407", area(0, 0, 60, 0, 60, 40, 0, 40))
    .add("101", line(2, 6, 58, 30))
    .add("101", curve(2, 26, 20, 40, 34, 4, 58, 20))
    .add("101", line(2, 2, 58, 2.5))
    .add("505", line(18, 4, 22, 36))
    .add("505", line(41, 6, 43, 34))
    .add("505", line(4, 38, 56, 38));
}

/** A pentagon of radius 10 mm round (cx, cy), turned 12°. */
function pentagon(cx: number, cy: number): MapPoint[] {
  return Array.from({ length: 5 }, (_, k) => {
    const a = ((90 + 12 + 72 * k) * Math.PI) / 180;
    return { x: Math.round((cx + 10 * Math.cos(a)) * 1000) / 1000, y: Math.round((cy + 10 * Math.sin(a)) * 1000) / 1000 };
  });
}
/** Half the pentagon's width (its x extent at 12° is 2·10·sin 84° ≈ 19.9 mm). */
export const FILTER_SHIFT_MM = 10;
const AT = { x: 24, y: 20 };

function scene(name: FilterSceneName, regions: CourseFilterRegion[]): FilterScene {
  const b = base();
  const layer = courseLayer({
    structure: null, sites: [], objects: [], appearance: {}, viewOptions: {}, regions,
    document: { colours: b.colours, libraryId: b.library, documentFactor: 1 },
  });
  const merged = courseRenderInput(b, layer);
  return { name, colours: layer.colours, symbols: merged.symbols, objects: merged.objects, regions: merged.regions, regionObjectLimit: merged.regionObjectLimit };
}

const here = [pentagon(AT.x, AT.y)];
const moved = [pentagon(AT.x + FILTER_SHIFT_MM, AT.y)];

const builders: Record<FilterSceneName, () => FilterScene> = {
  /** Clip "all brown": contours stop at the boundary, footpaths and the 407 run through. */
  "filter-clip-brown": () => scene("filter-clip-brown", [{ rings: here, mode: "clip", symbols: { colours: [FILTER_BROWN] } }]),
  /** Hide "505 only": the footpath crossing the pentagon vanishes whole, the others stay. */
  "filter-hide-505": () => scene("filter-hide-505", [{ rings: here, mode: "hide", symbols: [FILTER_SYMBOL.footpath505] }]),
  /** Both, with the pentagon moved half its width: the other footpath goes, the contours are cut further right. */
  "filter-moved": () =>
    scene("filter-moved", [
      { rings: moved, mode: "clip", symbols: { colours: [FILTER_BROWN] } },
      { rings: moved, mode: "hide", symbols: [FILTER_SYMBOL.footpath505] },
    ]),
  /** Map simplification: "show only 101 and 505" inside — the 407 hatch is cut away, contours and paths stay. */
  "filter-show-only": () =>
    scene("filter-show-only", [{ rings: here, mode: "clip", symbols: [FILTER_SYMBOL.contour101, FILTER_SYMBOL.footpath505], invert: true }]),
};

export function filterScene(name: FilterSceneName): FilterScene {
  return builders[name]();
}

export function isFilterSceneName(name: string): name is FilterSceneName {
  return (filterSceneNames as readonly string[]).includes(name);
}
