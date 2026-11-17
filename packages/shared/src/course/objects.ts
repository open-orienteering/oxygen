/**
 * Course objects (docs/course-layer.md §8; 08 §4.5): `course_objects` rows
 * with a kind, a vertex path in paper mm and kind props — their schema,
 * scope rule and drawing onto the 7xx set. Map-anchored layout objects
 * were moved into them by F12 (§3.6, retired).
 *
 * The page layer (`page-layer.ts`, course-print.md §4.4) draws a sheet's
 * page-anchored layout objects through the same builder: white-out,
 * white-out outside, 709 hatch and plain text / line / path / rectangle in
 * their own colours, in page mm, plus images the page backends draw.
 */

import { z } from "zod";
import { type CourseMapObject, type MapPoint, type PathVertex, mapFontFamilySchema, mapImageCropSchema, pathVertexSchema, pointSchema } from "../course-maps/schema.js";
import { expandMapText } from "../course-maps/text.js";
import { COORD_FLAG, type RenderPath, makePath } from "../render/pass-stream.js";
import { type RenderSymbol, parseRenderSymbol } from "../render/symbol.js";
import type { CourseSymbolSet } from "./symbols.js";
import type { CourseFilterRegion, CourseLayerImage, CourseLayerWarning, CourseRenderObject, CourseViewOptions } from "./types.js";

const um = (mm: number) => Math.round(mm * 1000);

// ─── Course objects: stored shape (§8.1) ────────────────────

export const COURSE_OBJECT_KINDS = [
  "oob_area", "oob_line", "whiteout", "toner_saver", "marked_route", "text", "image", "filter_region", "inset_frame",
] as const;
export type CourseObjectKind = (typeof COURSE_OBJECT_KINDS)[number];

const hexSchema = z.string().regex(/^#[0-9a-f]{6}$/i);
const indexList = z.array(z.number().int().min(0));

/** Vertices with at least `min` (and at most `max`) points; the issue message is the rule code. */
const vertices = (min: number, max = Infinity, vertex: z.ZodType<PathVertex> = pathVertexSchema) =>
  z.array(vertex).superRefine((v, ctx) => {
    if (v.length < min || v.length > max) {
      ctx.addIssue({ code: "custom", message: `OBJECT_GEOMETRY: ${min === max ? min : `${min}${max === Infinity ? "+" : `–${max}`}`} vertices, got ${v.length}` });
    }
  });

/**
 * One course object without its row fields: the kind, its geometry (paper
 * mm, y-up, the layout path's vertex / Bézier shape) and its props. Areas
 * take ≥ 3 vertices, lines ≥ 2, a text its anchor, an image two opposite
 * corners. Props are strict: unknown keys are refused, not dropped (the
 * object itself is not, so the API can intersect it with its row fields).
 */
export const courseObjectBodySchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("oob_area"),
    geometry: vertices(3),
    /**
     * `border`: 709 alone, 709.b with a solid boundary, 709.c dashed (default `none`). `hatch`: `709` the
     * out-of-bounds stripes (default), `710` the dangerous area's cross-hatch (course-layer.md §3.1).
     */
    props: z.strictObject({ border: z.enum(["none", "solid", "dashed"]).optional(), hatch: z.enum(["709", "710"]).optional() }),
  }),
  z.object({
    kind: z.literal("oob_line"),
    geometry: vertices(2),
    /** 708 out-of-bounds boundary (default) or 711 out-of-bounds route. */
    props: z.strictObject({ symbol: z.enum(["708", "711"]).optional() }),
  }),
  z.object({ kind: z.literal("whiteout"), geometry: vertices(3), props: z.strictObject({}) }),
  z.object({
    kind: z.literal("toner_saver"),
    /** The hull: white-out is drawn outside it, inside the map frame. */
    geometry: vertices(3),
    /** How the hull was generated (D5 regenerates from them); the drawn shape is the stored one. */
    props: z.strictObject({ marginMm: z.number().min(0).optional(), holeRadiusMm: z.number().min(0).optional() }),
  }),
  z.object({ kind: z.literal("marked_route"), geometry: vertices(2), props: z.strictObject({}) }),
  z.object({
    kind: z.literal("text"),
    geometry: vertices(1, 1),
    props: z.strictObject({
      text: z.string(),
      /** Paper mm at the map's scale, like the 7xx symbols. */
      fontSizeMm: z.number().finite().positive().max(100),
      fontFamily: mapFontFamilySchema.optional(),
      /** Default: upper purple. */
      color: hexSchema.optional(),
      align: z.enum(["left", "center", "right"]).optional(),
    }),
  }),
  z.object({
    kind: z.literal("image"),
    geometry: vertices(2, 2),
    props: z.strictObject({ graphicId: z.number().int().positive(), crop: mapImageCropSchema.optional() }),
  }),
  z.object({
    kind: z.literal("filter_region"),
    /** A polygon: Bézier handles are refused. */
    geometry: vertices(3, Infinity, pointSchema.strict()),
    /** D3's region (`map-rendering.md` §4.11), stored as the layer takes it. */
    props: z.strictObject({
      mode: z.enum(["clip", "hide"]),
      symbols: z.union([z.literal("all"), indexList, z.strictObject({ colours: indexList })]),
      invert: z.boolean().optional(),
    }),
  }),
  /** Reserved (micro insets, 08 §4.5): typed, refused on write, never drawn. */
  z.object({ kind: z.literal("inset_frame"), geometry: vertices(2), props: z.strictObject({}) }),
]);
export type CourseObjectBody = z.infer<typeof courseObjectBodySchema>;

/** `{ all: true }`, or the courses and classes the object belongs to (a class: the courses it runs). */
export function courseObjectScopeSchemaOf<S extends z.ZodType<string | number>>(id: S) {
  return z.union([z.strictObject({ all: z.literal(true) }), z.strictObject({ courses: z.array(id), classes: z.array(id) })]);
}
export type CourseObjectScope<Id = number> = { all: true } | { courses: Id[]; classes: Id[] };

/** What the course layer takes: the body plus an id for the object's `ref`. */
export type CourseLayerObject = CourseObjectBody & { id: number | string };

/** A course object on the tRPC wire: public ids (course / class seq), the row's token. */
export type CourseObject = CourseObjectBody & {
  /** Public id (`seq`). */
  id: number;
  scope: CourseObjectScope<number>;
  z: number;
  /** Concurrency token (decimal HLC), sent back as `baseVersion` (§7). */
  version: string;
  /**
   * The courses (public ids) the scope resolves to — named courses plus the
   * courses of named classes, forking pools included — resolved by the
   * server with print's rule; `null` for `{ all: true }`.
   */
  inCourses: number[] | null;
};

/**
 * Whether an object is drawn with a course (§8.2). `drawn` = the drawn
 * courses and the classes that run them; `null` = no course (all-controls
 * view): `all`-scoped objects only.
 */
export function courseObjectInScope<Id>(scope: CourseObjectScope<Id>, drawn: { courses: readonly Id[]; classes: readonly Id[] } | null): boolean {
  if ("all" in scope) return true;
  if (!drawn) return false;
  return scope.courses.some((c) => drawn.courses.includes(c)) || scope.classes.some((c) => drawn.classes.includes(c));
}

/** A scope with course / class UUIDs: a `course_objects` row's (the wire names them by public id). */
export type StoredScope = CourseObjectScope<string>;
/** A `course_objects` row as the layer, the snapshot and the print pipeline read it: body + UUID scope. */
export type StoredCourseObject = CourseObjectBody & { id: string; seq: number; scope: StoredScope; z: number; version: bigint };

/** The objects drawn with a course (UUID), or with no course (`null`: `all`-scoped only). */
export function objectsInScope(objects: readonly StoredCourseObject[], courseId: string | null, byCourse: ReadonlyMap<string, string[]>): StoredCourseObject[] {
  const drawn = courseId === null ? null : { courses: [courseId], classes: byCourse.get(courseId) ?? [] };
  return objects.filter((o) => courseObjectInScope(o.scope, drawn));
}

const FONT = { sans: "liberation-sans", condensed: "liberation-sans-narrow", serif: "liberation-serif", mono: "liberation-mono" } as const;

/** Hex colours course objects draw in (a text's own colour), in object order. */
export function objectColours(objects: readonly CourseLayerObject[]): string[] {
  return objects.flatMap((o) => (o.kind === "text" && o.props.color ? [o.props.color] : []));
}

/** Hex colours page-anchored layout objects draw in (stroke, solid fill, text), in object order. */
export function pageObjectColours(objects: readonly CourseMapObject[]): string[] {
  const out: string[] = [];
  for (const o of objects) {
    if (o.kind === "text") out.push(o.color);
    else if (o.kind === "line") out.push(o.stroke);
    else if (o.kind === "path" || o.kind === "rectangle") {
      if (o.fillMode === "solid" && o.fill) out.push(o.fill);
      if (o.stroke && o.strokeWidthMm !== undefined && o.fillMode !== "outOfBounds") out.push(o.stroke);
    }
  }
  return out;
}

/**
 * The toner saver's own white row (§3.6, P1): on top of the layer's
 * stack, above upper purple and the course-object rows, so the white-out
 * outside covers everything the map layer draws — the map's text in rows
 * above purple, 709 areas, object text. The page layer comes after it.
 */
export const TONER_WHITE_ID = "course:toner-saver-white";

/** Whether the layer draws a white-out outside (a `toner_saver` course object). */
export function hasTonerSaver(objects: readonly CourseLayerObject[]): boolean {
  return objects.some((o) => o.kind === "toner_saver");
}

/** A stored path's construction as a render path: a handle on either end makes the segment a cubic. */
function vertexPath(points: readonly PathVertex[], closed: boolean): { coords: number[]; flags: number[] } {
  const coords: number[] = [um(points[0].x), um(points[0].y)];
  const flags: number[] = [0];
  const segment = (a: PathVertex, b: PathVertex) => {
    if (a.hOut || b.hIn) {
      const c1 = a.hOut ? { x: a.x + a.hOut.x, y: a.y + a.hOut.y } : a;
      const c2 = b.hIn ? { x: b.x + b.hIn.x, y: b.y + b.hIn.y } : b;
      coords.push(um(c1.x), um(c1.y), um(c2.x), um(c2.y));
      flags.push(COORD_FLAG.bezierFirst, COORD_FLAG.bezierSecond);
    }
    coords.push(um(b.x), um(b.y));
    flags.push(0);
  };
  for (let i = 1; i < points.length; i++) segment(points[i - 1], points[i]);
  // A closed path closes itself; only a curved closing segment needs its points.
  const last = points[points.length - 1];
  if (closed && points.length > 1 && (last.hOut || points[0].hIn)) segment(last, points[0]);
  return { coords, flags };
}

const rectVertices = (o: { x: number; y: number; width: number; height: number }): PathVertex[] => [
  { x: o.x, y: o.y }, { x: o.x + o.width, y: o.y }, { x: o.x + o.width, y: o.y + o.height }, { x: o.x, y: o.y + o.height },
];

/** Dashes as legacy print draws them: dash max(2, 5w), gap max(1, 2.5w), page mm. */
const dashFor = (dashed: boolean, widthMm: number) =>
  dashed ? { layout: "ocad" as const, dashUm: um(Math.max(2, 5 * widthMm)), gapUm: um(Math.max(1, 2.5 * widthMm)) } : undefined;

export interface ObjectBuild {
  objects: CourseRenderObject[];
  images: CourseLayerImage[];
  warnings: CourseLayerWarning[];
}

/** What both builders read of the view: the white-out-outside ring and the text values. */
type ObjectView = Pick<CourseViewOptions, "window" | "textValues">;

/** The shared part of the two builders: symbols deduplicated by content, white-out outside, text symbols. */
function objectBuilder(
  set: CourseSymbolSet,
  symbols: RenderSymbol[],
  colourOf: (hex: string) => number,
  view: ObjectView,
  tonerWhite: number | undefined,
) {
  const out: ObjectBuild = { objects: [], images: [], warnings: [] };
  const known = new Map<string, number>();
  const symbol = (body: Record<string, unknown>): number => {
    const key = JSON.stringify(body);
    let i = known.get(key);
    if (i === undefined) {
      i = symbols.length;
      symbols.push(parseRenderSymbol({ id: `course:object/${known.size}`, code: "object", name: "Layout object", ...body }));
      known.set(key, i);
    }
    return i;
  };
  /** White-out outside `shape`: the ring (the map frame) with the shape as an even-odd hole. */
  const whiteoutOutside = (shape: { coords: number[]; flags: number[] }, ref: CourseRenderObject["ref"], what: string) => {
    if (!view.window || view.window.length < 3) {
      out.warnings.push({ code: "WINDOW_MISSING", ref, message: `${what} needs viewOptions.window; not drawn` });
      return;
    }
    const ring = view.window.flatMap((p: MapPoint) => [um(p.x), um(p.y)]);
    const flags = [...new Array(view.window.length).fill(0), ...shape.flags];
    flags[view.window.length] |= COORD_FLAG.hole;
    const symbolIdx = tonerWhite === undefined ? set.idx.whiteout : symbol({ type: "area", fill: tonerWhite });
    out.objects.push({ symbolIdx, path: makePath([...ring, ...shape.coords], flags, true), ref });
  };
  const textSymbol = (fontFamily: keyof typeof FONT | undefined, sizeUm: number, colour: number, align: "left" | "center" | "right" | undefined) =>
    symbol({ type: "text", fontFamily: FONT[fontFamily ?? "sans"], fontSizeUm: sizeUm, colour, align: align === "center" ? "centre" : (align ?? "left") });
  const image = (graphicId: number, crop: CourseLayerImage["crop"], x: number, y: number, width: number, height: number) =>
    out.images.push({ graphicId, ...(crop ? { crop } : {}), rectUm: { x: um(x), y: um(y), width: um(width), height: um(height) } });
  return { out, symbol, whiteoutOutside, textSymbol, image };
}

/**
 * Course objects onto the 7xx set (§8.3), symbols added to `symbols`.
 * Geometry and text sizes are paper mm like the course symbols, so nothing
 * is divided by the print enlargement. `filter_region` is not an object
 * (the layer lifts it into `regions`); `inset_frame` is reserved.
 */
export function courseObjects(
  input: readonly CourseLayerObject[],
  set: CourseSymbolSet,
  symbols: RenderSymbol[],
  colourOf: (hex: string) => number,
  view: ObjectView,
  upperPurple: number,
  /** The colour a toner saver fills: the map layer's toner white row (the set's white-out when absent). */
  tonerWhite?: number,
): ObjectBuild {
  const b = objectBuilder(set, symbols, colourOf, view, tonerWhite);
  for (const o of input) {
    const ref = { kind: "object" as const, id: courseObjectRefId(o.id) };
    const area = (closed: boolean) => {
      const shape = vertexPath(o.geometry, closed);
      return { shape, path: makePath(shape.coords, shape.flags, closed) };
    };
    switch (o.kind) {
      case "oob_area": {
        const border = o.props.border ?? "none";
        const idx = o.props.hatch === "710"
          ? border === "solid" ? set.idx.dangerousAreaBorder : border === "dashed" ? set.idx.dangerousAreaDashed : set.idx.dangerousArea
          : border === "solid" ? set.idx.oobAreaBorder : border === "dashed" ? set.idx.oobAreaDashed : set.idx.oobArea;
        b.out.objects.push({ symbolIdx: idx, path: area(true).path, ref });
        break;
      }
      case "oob_line":
        b.out.objects.push({ symbolIdx: o.props.symbol === "711" ? set.idx.forbiddenRoute : set.idx.restrictedLine, path: area(false).path, ref });
        break;
      case "marked_route":
        b.out.objects.push({ symbolIdx: set.idx.markedRoute, path: area(false).path, ref });
        break;
      case "whiteout":
        b.out.objects.push({ symbolIdx: set.idx.whiteout, path: area(true).path, ref });
        break;
      case "toner_saver":
        b.whiteoutOutside(area(true).shape, ref, `toner saver ${o.id}`);
        break;
      case "text": {
        const text = expandMapText(o.props.text, view.textValues ?? {});
        if (!text) break;
        const colour = o.props.color ? colourOf(o.props.color) : upperPurple;
        const p = o.geometry[0];
        b.out.objects.push({ symbolIdx: b.textSymbol(o.props.fontFamily, um(o.props.fontSizeMm), colour, o.props.align), path: makePath([um(p.x), um(p.y)]), text, ref });
        break;
      }
      case "image": {
        const [p, q] = o.geometry;
        b.image(o.props.graphicId, o.props.crop, Math.min(p.x, q.x), Math.min(p.y, q.y), Math.abs(p.x - q.x), Math.abs(p.y - q.y));
        break;
      }
      case "filter_region":
      case "inset_frame":
        break;
    }
  }
  return b.out;
}

/**
 * A sheet's page-anchored layout objects (course-print.md §4.4), flipped
 * to y-up page mm by the caller (`flipPageObject`), symbols added to
 * `symbols`. Sizes are page mm as stored: the page layer is not enlarged.
 * A white-out outside fills the ring `view.window` (the frame) with the
 * set's white-out.
 */
export function pageObjects(
  input: readonly CourseMapObject[],
  set: CourseSymbolSet,
  symbols: RenderSymbol[],
  colourOf: (hex: string) => number,
  view: ObjectView,
): ObjectBuild {
  const b = objectBuilder(set, symbols, colourOf, view, undefined);
  const strokeSymbol = (hex: string, widthMm: number, dashed: boolean) => {
    const dash = dashFor(dashed, widthMm);
    return b.symbol({ type: "line", main: { colour: colourOf(hex), widthUm: um(widthMm), ...(dash ? { dash } : {}) } });
  };
  for (const o of input) {
    const ref = { kind: "object" as const, id: o.id };
    if (o.kind === "image") {
      b.image(o.graphicId, o.crop, o.x, o.y, o.width, o.height);
      continue;
    }
    if (o.kind === "text") {
      const text = expandMapText(o.text, view.textValues ?? {});
      if (!text) continue;
      b.out.objects.push({ symbolIdx: b.textSymbol(o.fontFamily, um(o.fontSizeMm), colourOf(o.color), o.align), path: makePath([um(o.x), um(o.y)]), text, ref });
      continue;
    }
    if (o.kind === "line") {
      b.out.objects.push({ symbolIdx: strokeSymbol(o.stroke, o.strokeWidthMm, o.dash === "dashed"), path: makePath([um(o.x1), um(o.y1), um(o.x2), um(o.y2)]), ref });
      continue;
    }

    const fillMode = o.fillMode ?? "none";
    const vertices = o.kind === "rectangle" ? rectVertices(o) : o.points;
    const closed = o.kind === "rectangle" || o.closed || fillMode === "whiteout" || fillMode === "whiteoutInverted" || fillMode === "outOfBounds";
    const shape = vertexPath(vertices, closed);
    const shapePath = makePath(shape.coords, shape.flags, closed);
    const hasStroke = !!o.stroke && o.strokeWidthMm !== undefined;

    if (fillMode === "whiteout") b.out.objects.push({ symbolIdx: set.idx.whiteout, path: shapePath, ref });
    else if (fillMode === "solid" && o.fill) b.out.objects.push({ symbolIdx: b.symbol({ type: "area", fill: colourOf(o.fill) }), path: shapePath, ref });
    else if (fillMode === "outOfBounds") {
      const idx = !hasStroke ? set.idx.oobArea : o.dash === "dashed" ? set.idx.oobAreaDashed : set.idx.oobAreaBorder;
      b.out.objects.push({ symbolIdx: idx, path: shapePath, ref });
      continue; // the library entry draws the boundary: stored colour and width are not read
    } else if (fillMode === "whiteoutInverted") b.whiteoutOutside(shape, ref, `white-out outside ${o.id}`);
    if (hasStroke) b.out.objects.push({ symbolIdx: strokeSymbol(o.stroke!, o.strokeWidthMm!, o.dash === "dashed"), path: shapePath, ref });
  }
  return b.out;
}

/** A course object's `ref.id`: distinct from a sheet's layout-object ids. */
export const courseObjectRefId = (id: number | string) => `course-object:${id}`;

/** A `filter_region` course object as the layer's region input (one outer ring). */
export function filterRegionOf(o: Extract<CourseLayerObject, { kind: "filter_region" }>): CourseFilterRegion {
  return {
    rings: [o.geometry.map((p) => ({ x: p.x, y: p.y }))],
    mode: o.props.mode,
    symbols: o.props.symbols,
    ...(o.props.invert ? { invert: true } : {}),
  };
}

export type { RenderPath };
