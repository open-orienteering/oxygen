/**
 * `courseLayer()` — the course as objects with library symbols, ready to
 * join the document's objects in one `symbolise` call
 * (docs/course-layer.md §1; research 08 §4.1, 04 §7). Pure and
 * deterministic: screen, print and the stored GeoJSON read the same
 * derivation.
 */

import type { DocumentRenderInput } from "../map-document/render-bridge.js";
import { makePath } from "../render/pass-stream.js";
import type { RenderSymbol } from "../render/symbol.js";
import type { RenderObject } from "../render/symbolise.js";
import type { FilterRegion } from "../render/filter-region.js";
import { COORD_FLAG } from "../render/pass-stream.js";
import { remapRenderColours } from "../render/transform.js";
import { circleWithGaps } from "./arcs.js";
import { courseColourStack, withObjectColours } from "./colour-stack.js";
import { deriveCourse } from "./derive.js";
import { layoutObjects, objectColours } from "./objects.js";
import { courseSymbols } from "./symbols.js";
import type { CourseExtra, CourseFilterRegion, CourseLayer, CourseLayerInput, CourseRenderObject } from "./types.js";
import type { MapPoint } from "../course-maps/schema.js";

const um = (mm: number) => Math.round(mm * 1000);
const line = (pts: readonly MapPoint[], closed = false) => makePath(pts.flatMap((p) => [um(p.x), um(p.y)]), undefined, closed);

export function courseLayer(input: CourseLayerInput): CourseLayer {
  const stack = courseColourStack(input.document.colours);
  const set = courseSymbols(input.document, stack.index, input.appearance);
  const derivation = deriveCourse(input, {
    circleRadiusMm: set.circleRadiusUm / 1000,
    finishRadiusMm: set.finishRadiusUm / 1000,
    startRadiusMm: set.startRadiusUm / 1000,
    numberEmMm: set.numberEmUm / 1000,
    lineWidthMm: set.lineWidthUm / 1000,
  });
  const { idx } = set;
  const objects: CourseRenderObject[] = [];

  for (const s of derivation.sites) {
    const ref = { kind: "site" as const, id: s.id };
    if (s.role === "start") {
      objects.push({ symbolIdx: idx.start, path: makePath([um(s.x), um(s.y)]), ...(s.angleDeg ? { angleDeg: s.angleDeg } : {}), ref });
    } else if (s.role === "finish") {
      objects.push({ symbolIdx: idx.finish, path: makePath([um(s.x), um(s.y)]), ref });
    } else {
      for (const path of circleWithGaps(um(s.x), um(s.y), set.circleRadiusUm, s.cuts)) objects.push({ symbolIdx: idx.circle, path, ref });
    }
  }

  const extraSymbol: Record<CourseExtra["kind"], number> = {
    marked_route: idx.markedRoute, restricted_line: idx.restrictedLine, forbidden_route: idx.forbiddenRoute, oob_area: idx.oobArea,
  };
  for (const c of derivation.courses) {
    c.legs.forEach((leg, i) => {
      for (const piece of leg.pieces) if (piece.length >= 2) objects.push({ symbolIdx: idx.leg, path: line(piece), ref: { kind: "leg", id: `${c.id}:${i}` } });
    });
    c.extras.forEach((x, i) => {
      if (x.points.length < 2) return;
      objects.push({ symbolIdx: extraSymbol[x.kind], path: line(x.points, x.kind === "oob_area"), ref: { kind: "extra", id: `${c.id}:${i}` } });
    });
  }

  // 704: the anchor is the baseline, half a digit below the placed centre.
  const half = set.digitHeightUm / 2;
  for (const s of derivation.sites) {
    if (!s.label) continue;
    objects.push({ symbolIdx: idx.number, path: makePath([um(s.label.x), Math.round(um(s.label.y) - half)]), text: s.label.text, ref: { kind: "number", id: s.id } });
    const l = s.label.leader;
    if (l) objects.push({ symbolIdx: idx.leader, path: line([{ x: l.x1, y: l.y1 }, { x: l.x2, y: l.y2 }]), ref: { kind: "leader", id: s.id } });
  }

  const symbols: RenderSymbol[] = [...set.symbols];
  const palette = withObjectColours(stack.colours, objectColours(input.objects));
  const built = layoutObjects(input.objects, set, symbols, palette.indexOf, input.viewOptions);
  objects.push(...built.objects);

  const regions = (input.regions ?? []).map((r) => filterRegion(r, stack.remap));
  return { colours: palette.colours, remap: stack.remap, symbols, objects, images: built.images, derivation, warnings: built.warnings, regions };
}

/** A course filter region in stream units: rings → one closed path (holes flagged), document colours → the completed stack. */
function filterRegion(r: CourseFilterRegion, remap: number[] | null): FilterRegion {
  const coords: number[] = [];
  const flags: number[] = [];
  r.rings.forEach((ring, k) => {
    ring.forEach((p, i) => {
      coords.push(um(p.x), um(p.y));
      flags.push(k > 0 && i === 0 ? COORD_FLAG.hole : 0);
    });
  });
  const s = r.symbols;
  const symbols = s === "all" ? s : Array.isArray(s) ? [...s] : { colours: s.colours.map((c) => (remap ? (remap[c] ?? c) : c)) };
  return { path: makePath(coords, flags, true), mode: r.mode, symbols, ...(r.invert ? { invert: true } : {}) };
}

export interface CourseRenderInput {
  objects: RenderObject[];
  symbols: RenderSymbol[];
  /** `objects[courseObjectOffset + i]` is `layer.objects[i]`. */
  courseObjectOffset: number;
  /** The layer's filter regions; `symbolise` takes them with `regionObjectLimit` so the course is never filtered. */
  regions: FilterRegion[];
  regionObjectLimit: number;
}

/**
 * The document's render input with the course layer appended: document
 * symbols re-indexed onto the layer's stack (`layer.colours` is the stack
 * to draw with), course symbols after them. One `symbolise` call on the
 * result draws map and course in colour order.
 */
export function courseRenderInput(base: Pick<DocumentRenderInput, "objects" | "symbols">, layer: CourseLayer): CourseRenderInput {
  const docSymbols = layer.remap ? base.symbols.map((s) => remapRenderColours(s, layer.remap!)) : [...base.symbols];
  const offset = docSymbols.length;
  return {
    symbols: [...docSymbols, ...layer.symbols],
    objects: [...base.objects, ...layer.objects.map(({ ref: _ref, ...o }) => ({ ...o, symbolIdx: o.symbolIdx + offset }))],
    courseObjectOffset: base.objects.length,
    regions: layer.regions,
    regionObjectLimit: base.objects.length,
  };
}
