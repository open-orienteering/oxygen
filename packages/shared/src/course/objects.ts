/**
 * Map-anchored layout objects → course-layer objects (docs/course-layer.md
 * §3.6): today's `CourseMapObject`s are the 08 §4.5 kinds they already
 * are — white-out, white-out outside (toner saver), 709 hatch, and plain
 * text / line / path / rectangle in their own colours, plus images that
 * the page backends draw.
 */

import { type CourseMapObject, type MapPoint, type PathVertex } from "../course-maps/schema.js";
import { expandMapText } from "../course-maps/text.js";
import { COORD_FLAG, type RenderPath, makePath } from "../render/pass-stream.js";
import { type RenderSymbol, parseRenderSymbol } from "../render/symbol.js";
import type { CourseSymbolSet } from "./symbols.js";
import type { CourseLayerImage, CourseLayerWarning, CourseRenderObject, CourseViewOptions } from "./types.js";

const um = (mm: number) => Math.round(mm * 1000);

const FONT = { sans: "liberation-sans", condensed: "liberation-sans-narrow", serif: "liberation-serif", mono: "liberation-mono" } as const;

/** Hex colours the objects draw in (stroke, solid fill, text), in object order. */
export function objectColours(objects: readonly CourseMapObject[]): string[] {
  const out: string[] = [];
  for (const o of objects) {
    if (o.anchor !== "map") continue;
    if (o.kind === "text") out.push(o.color);
    else if (o.kind === "line") out.push(o.stroke);
    else if (o.kind === "path" || o.kind === "rectangle") {
      if (o.fillMode === "solid" && o.fill) out.push(o.fill);
      if (o.stroke && o.strokeWidthMm !== undefined && o.fillMode !== "outOfBounds") out.push(o.stroke);
    }
  }
  return out;
}

/** `pathData`'s construction (objects-svg.ts) as a render path: a handle on either end makes the segment a cubic. */
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
const dashFor = (dashed: boolean, widthMm: number, os: number) =>
  dashed ? { layout: "ocad" as const, dashUm: um(Math.max(2, 5 * widthMm) / os), gapUm: um(Math.max(1, 2.5 * widthMm) / os) } : undefined;

export interface ObjectBuild {
  objects: CourseRenderObject[];
  images: CourseLayerImage[];
  warnings: CourseLayerWarning[];
}

/** Adds symbols to `symbols` (deduplicated by content) and returns the layer objects. */
export function layoutObjects(
  input: readonly CourseMapObject[],
  set: CourseSymbolSet,
  symbols: RenderSymbol[],
  colourOf: (hex: string) => number,
  view: CourseViewOptions,
): ObjectBuild {
  const os = view.overprintScale && view.overprintScale > 0 ? view.overprintScale : 1;
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
  const strokeSymbol = (hex: string, widthMm: number, dashed: boolean) => {
    const dash = dashFor(dashed, widthMm, os);
    return symbol({ type: "line", main: { colour: colourOf(hex), widthUm: um(widthMm / os), ...(dash ? { dash } : {}) } });
  };

  for (const o of input) {
    if (o.anchor !== "map") continue;
    const ref = { kind: "object" as const, id: o.id };
    if (o.kind === "image") {
      out.images.push({ object: o, rectUm: { x: um(o.x), y: um(o.y), width: um(o.width), height: um(o.height) } });
      continue;
    }
    if (o.kind === "text") {
      const text = expandMapText(o.text, view.textValues ?? {});
      if (!text) continue;
      const align = o.align === "center" ? "centre" : (o.align ?? "left");
      const idx = symbol({ type: "text", fontFamily: FONT[o.fontFamily ?? "sans"], fontSizeUm: um(o.fontSizeMm / os), colour: colourOf(o.color), align });
      out.objects.push({ symbolIdx: idx, path: makePath([um(o.x), um(o.y)]), text, ref });
      continue;
    }
    if (o.kind === "line") {
      out.objects.push({ symbolIdx: strokeSymbol(o.stroke, o.strokeWidthMm, o.dash === "dashed"), path: makePath([um(o.x1), um(o.y1), um(o.x2), um(o.y2)]), ref });
      continue;
    }

    const fillMode = o.fillMode ?? "none";
    const vertices = o.kind === "rectangle" ? rectVertices(o) : o.points;
    const closed = o.kind === "rectangle" || o.closed || fillMode === "whiteout" || fillMode === "whiteoutInverted" || fillMode === "outOfBounds";
    const shape = vertexPath(vertices, closed);
    const shapePath = makePath(shape.coords, shape.flags, closed);
    const hasStroke = !!o.stroke && o.strokeWidthMm !== undefined;

    if (fillMode === "whiteout") out.objects.push({ symbolIdx: set.idx.whiteout, path: shapePath, ref });
    else if (fillMode === "solid" && o.fill) out.objects.push({ symbolIdx: symbol({ type: "area", fill: colourOf(o.fill) }), path: shapePath, ref });
    else if (fillMode === "outOfBounds") {
      const idx = !hasStroke ? set.idx.oobArea : o.dash === "dashed" ? set.idx.oobAreaDashed : set.idx.oobAreaBorder;
      out.objects.push({ symbolIdx: idx, path: shapePath, ref });
      continue; // the library entry draws the boundary: stored colour and width are not read
    } else if (fillMode === "whiteoutInverted") {
      if (!view.window || view.window.length < 3) {
        out.warnings.push({ code: "WINDOW_MISSING", ref, message: `white-out outside ${o.id} needs viewOptions.window; not drawn` });
      } else {
        const ring = view.window.flatMap((p: MapPoint) => [um(p.x), um(p.y)]);
        const flags = [...new Array(view.window.length).fill(0), ...shape.flags];
        flags[view.window.length] |= COORD_FLAG.hole;
        out.objects.push({ symbolIdx: set.idx.whiteout, path: makePath([...ring, ...shape.coords], flags, true), ref });
      }
    }
    if (hasStroke) out.objects.push({ symbolIdx: strokeSymbol(o.stroke!, o.strokeWidthMm!, o.dash === "dashed"), path: shapePath, ref });
  }
  return out;
}

export type { RenderPath };
