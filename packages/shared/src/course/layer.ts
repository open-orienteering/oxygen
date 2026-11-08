/**
 * `courseLayer()` — the course as objects with library symbols, ready to
 * join the document's objects in one `symbolise` call
 * (docs/course-layer.md §1; research 08 §4.1, 04 §7). Pure and
 * deterministic: screen, print and the stored GeoJSON read the same
 * derivation.
 */

import type { DocumentRenderInput } from "../map-document/render-bridge.js";
import { makePath } from "../render/pass-stream.js";
import type { LineSymbol, RenderSymbol } from "../render/symbol.js";
import type { DocumentColour } from "../map-document/header.js";
import type { RenderObject } from "../render/symbolise.js";
import type { FilterRegion } from "../render/filter-region.js";
import { COORD_FLAG } from "../render/pass-stream.js";
import { remapRenderColours } from "../render/transform.js";
import { circleWithGaps } from "./arcs.js";
import { corridorGeometry } from "./corridor.js";
import { courseColourStack, withObjectColours, withTintColours } from "./colour-stack.js";
import { deriveCourse, structuresOf } from "./derive.js";
import { TONER_WHITE_ID, courseObjects, filterRegionOf, hasTonerSaver, objectColours } from "./objects.js";
import { CROSSING_BODY_MM, CROSSING_SECTION_MM, CROSSING_SECTION_OFFSET_MM, courseSymbols } from "./symbols.js";
import type { CourseFilterRegion, CourseLayer, CourseLayerInput, CourseRenderObject } from "./types.js";
import type { MapPoint } from "../course-maps/schema.js";

const TONER_WHITE = { id: TONER_WHITE_ID, name: "Toner saver white", cmyk: [0, 0, 0, 0] as [number, number, number, number] };

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

  // §12.7: the All-variations view's tints — rows on top of the stack, tinted copies of 705 and 703.
  const palette0 = withObjectColours(stack.colours, objectColours(input.objects));
  const tinting = variationTints(input, set, palette0.colours);
  const palette = { ...palette0, colours: tinting.colours };

  for (const s of derivation.sites) {
    const ref = { kind: "site" as const, id: s.id };
    if (s.role === "start") {
      objects.push({ symbolIdx: idx.start, path: makePath([um(s.x), um(s.y)]), ...(s.angleDeg ? { angleDeg: s.angleDeg } : {}), ref });
    } else if (s.role === "finish") {
      objects.push({ symbolIdx: idx.finish, path: makePath([um(s.x), um(s.y)]), ref });
    } else if (s.role === "map_issue") {
      // §10.3: 702 unrotated; the derivation draws it with setter marks only.
      objects.push({ symbolIdx: idx.mapIssue, path: makePath([um(s.x), um(s.y)]), ref });
    } else if (s.role === "crossing_point") {
      objects.push(...crossingObjects(s, idx.crossing, input.document.documentFactor));
    } else {
      const symbolIdx = tinting.circleOf(s.id) ?? idx.circle;
      for (const path of circleWithGaps(um(s.x), um(s.y), set.circleRadiusUm, s.cuts)) objects.push({ symbolIdx, path, ref });
    }
  }

  for (const c of derivation.courses) {
    c.legs.forEach((leg, i) => {
      // §10.1: 705, 707 along the leg, or no line (the derivation keeps its pieces for the labels).
      if (leg.style === "none") return;
      const symbolIdx = leg.style === "marked_route" ? idx.markedRoute : (tinting.legOf(c.id) ?? idx.leg);
      for (const piece of leg.pieces) if (piece.length >= 2) objects.push({ symbolIdx, path: line(piece), ref: { kind: "leg", id: `${c.id}:${i}` } });
    });
  }

  // §10.2: the corridors' edges in 705 after the legs; the band is a clip region (below).
  const corridors = corridorGeometry(derivation.courses);
  for (const e of corridors?.edges ?? []) {
    objects.push({ symbolIdx: idx.leg, path: makePath(e.points.flatMap((p) => [p.x, p.y]), undefined, e.closed), ref: { kind: "corridor", id: e.ref } });
  }

  // 704: the anchor is the baseline, half a digit below the placed centre.
  const half = set.digitHeightUm / 2;
  for (const s of derivation.sites) {
    if (!s.label) continue;
    objects.push({ symbolIdx: idx.number, path: makePath([um(s.label.x), Math.round(um(s.label.y) - half)]), text: s.label.text, ref: { kind: "number", id: s.id } });
    const l = s.label.leader;
    if (l) objects.push({ symbolIdx: idx.leader, path: line([{ x: l.x1, y: l.y1 }, { x: l.x2, y: l.y2 }]), ref: { kind: "leader", id: s.id } });
  }

  const symbols: RenderSymbol[] = [...set.symbols, ...tinting.symbols];
  // A toner saver covers everything the map layer draws: its white is the top row (objects.ts, P1).
  const drawsToner = (input.viewOptions.window?.length ?? 0) >= 3 && hasTonerSaver(input.objects);
  const colours = drawsToner ? [...palette.colours, TONER_WHITE] : palette.colours;
  const tonerWhite = drawsToner ? colours.length - 1 : undefined;
  const built = courseObjects(input.objects, set, symbols, palette.indexOf, input.viewOptions, stack.index.get("purple-upper")!, tonerWhite);
  objects.push(...built.objects);

  // Stored filter regions (§8.3) follow the explicit ones.
  const stored = input.objects.flatMap((o) => (o.kind === "filter_region" ? [filterRegionOf(o)] : []));
  const regions = [...(input.regions ?? []), ...stored].map((r) => filterRegion(r, stack.remap));
  // §10.2: the corridors' white band cuts every map colour away; the course is never filtered.
  if (corridors?.band) regions.push({ path: ringsPath(corridors.band), mode: "clip", symbols: "all" });
  return { colours, remap: stack.remap, symbols, objects, images: built.images, derivation, warnings: built.warnings, regions };
}

interface VariationTinting {
  colours: DocumentColour[];
  /** Appended after the set's symbols (indices continue `set.symbols`). */
  symbols: RenderSymbol[];
  /** The tinted 705 of a course id, or undefined (no tint, or no `allVariations`). */
  legOf: (courseId: string) => number | undefined;
  /** The tinted 703 of a site only tinted structures visit, all with one label; else undefined. */
  circleOf: (siteId: string) => number | undefined;
}

/**
 * The All-variations tints (§12.7): with `viewOptions.allVariations`, one
 * row `course-tint:<label>` per label of the tinted structures on top of
 * `colours`, and a 705 and a 703 copy on it. A site keeps the plain purple
 * unless every structure that visits it carries the same tint. Without the
 * option, nothing: a tint is ignored.
 */
function variationTints(input: CourseLayerInput, set: ReturnType<typeof courseSymbols>, colours: DocumentColour[]): VariationTinting {
  const none: VariationTinting = { colours, symbols: [], legOf: () => undefined, circleOf: () => undefined };
  if (!input.viewOptions.allVariations) return none;
  const structures = structuresOf(input);
  const labels = structures.flatMap((s) => (s.tint ? [s.tint] : []));
  if (labels.length === 0) return none;
  const rows = withTintColours(colours, labels);
  const leg = set.symbols[set.idx.leg] as LineSymbol;
  const circle = set.symbols[set.idx.circle] as LineSymbol;
  const symbols: RenderSymbol[] = [];
  const legIdx = new Map<string, number>();
  const circleIdx = new Map<string, number>();
  for (const label of new Set(labels)) {
    const colour = rows.indexOf(label);
    legIdx.set(label, set.symbols.length + symbols.push({ ...leg, id: `${leg.id}/tint:${label}`, main: { ...leg.main!, colour } }) - 1);
    circleIdx.set(label, set.symbols.length + symbols.push({ ...circle, id: `${circle.id}/tint:${label}`, main: { ...circle.main!, colour } }) - 1);
  }
  const tintOfCourse = new Map(structures.map((s) => [s.id, s.tint] as const));
  // Every tint (null = plain) a site is visited with.
  const visitors = new Map<string, Set<string | null>>();
  for (const s of structures) for (const item of s.items) {
    const seen = visitors.get(item.siteId) ?? new Set<string | null>();
    seen.add(s.tint ?? null);
    visitors.set(item.siteId, seen);
  }
  return {
    colours: rows.colours,
    symbols,
    legOf: (courseId) => {
      const t = tintOfCourse.get(courseId);
      return t ? legIdx.get(t) : undefined;
    },
    circleOf: (siteId) => {
      const v = visitors.get(siteId);
      const only = v && v.size === 1 ? [...v][0] : null;
      return only ? circleIdx.get(only) : undefined;
    },
  };
}

/**
 * A crossing point's objects (§10.3), turned along the passage
 * (`angleDeg`, counter-clockwise from +x). ISOM: 710 as a line over
 * `CROSSING_BODY_MM` (the section form `CROSSING_SECTION_MM`). ISSprOM:
 * the 710.1 point, or for a section two 710.2 lines either side of the
 * passage, the second reversed so both ends curve outwards.
 */
function crossingObjects(s: CourseLayer["derivation"]["sites"][number], idx: { line?: number; point?: number; section?: number }, factor: number): CourseRenderObject[] {
  const ref = { kind: "site" as const, id: s.id };
  const a = ((s.angleDeg ?? 90) * Math.PI) / 180;
  const ux = Math.cos(a), uy = Math.sin(a);
  const along = (half: number, off: number): MapPoint[] => [
    { x: s.x - ux * half - uy * off, y: s.y - uy * half + ux * off },
    { x: s.x + ux * half - uy * off, y: s.y + uy * half + ux * off },
  ];
  if (idx.point !== undefined) {
    if (s.section && idx.section !== undefined) {
      const half = (CROSSING_SECTION_MM * factor) / 2, off = CROSSING_SECTION_OFFSET_MM * factor;
      return [
        { symbolIdx: idx.section, path: line(along(half, off)), ref },
        { symbolIdx: idx.section, path: line(along(half, -off).reverse()), ref },
      ];
    }
    return [{ symbolIdx: idx.point, path: makePath([um(s.x), um(s.y)]), angleDeg: s.angleDeg ?? 90, ref }];
  }
  const half = ((s.section ? CROSSING_SECTION_MM : CROSSING_BODY_MM) * factor) / 2;
  return [{ symbolIdx: idx.line!, path: line(along(half, 0)), ref }];
}

/** Flat µm rings → one closed path, every ring after the first flagged as a new ring (even-odd). */
function ringsPath(rings: readonly (readonly number[])[]) {
  const coords: number[] = [];
  const flags: number[] = [];
  rings.forEach((r, k) => {
    for (let i = 0; i < r.length; i += 2) {
      coords.push(r[i], r[i + 1]);
      flags.push(k > 0 && i === 0 ? COORD_FLAG.hole : 0);
    }
  });
  return makePath(coords, flags, true);
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
