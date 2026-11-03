/**
 * The page layer of one sheet (docs/course-print.md §4.4; research 05
 * §5.1): page-anchored layout objects and the description block through
 * the course layer's object builder and one `symbolise`, in page µm y-up.
 * `composePage` draws it after the map layer in the PDF; the editor's
 * Layout mode (docs/course-layout.md §1) draws the same stream on the GL
 * canvas, so the preview is the PDF.
 *
 * Lives beside the course layer, not in `@oxygen/shared/print`, so the
 * web worker gets it without the PDF writer.
 */

import type { CourseMapObject, MapPoint, MapRect, MapWindow } from "../course-maps/schema.js";
import type { MapTextValues } from "../course-maps/text.js";
import type { DocumentColour } from "../map-document/header.js";
import { descriptionBlock } from "../print/description.js";
import type { DescriptionBlockInput } from "../print/description.js";
import { type ComposedPage, type MapLayerTransform, type PageImage, type PageWarning, flipPageObject, frameInMap, frameRectUm, inverseMapLayerTransform, mapLayerTransform, transformPassStream } from "../print/page.js";
import type { FontMetrics } from "../render/truetype.js";
import type { PassStream } from "../render/pass-stream.js";
import type { RenderSymbol } from "../render/symbol.js";
import { symbolise } from "../render/symbolise.js";
import { courseColourStack, withObjectColours } from "./colour-stack.js";
import { layoutObjects, objectColours } from "./objects.js";
import { courseSymbols } from "./symbols.js";
import type { CourseDocumentContext } from "./types.js";

/**
 * How far the outer boundary of a white-out outside lies beyond the frame:
 * the frame clip cuts it back, and no anti-aliased seam of map ink is left
 * between the clip edge and a ring edge on the same line.
 */
export const RING_BLEED_UM = 1000;

const grow = (r: ComposedPage["frameUm"], d: number): ComposedPage["frameUm"] => ({ x: r.x - d, y: r.y - d, width: r.width + 2 * d, height: r.height + 2 * d });

export interface PageLayerInput {
  paper: { heightMm: number };
  /** The map frame, page mm y-down (the template's convention). */
  frame: MapRect;
  window: MapWindow;
  /** Layout objects of both anchors; only the page-anchored ones are drawn here. */
  objects: readonly CourseMapObject[];
  textValues?: MapTextValues;
  description: DescriptionBlockInput | null;
  /** The pinned document's library and factor (white-out and 709 symbols at their map size). */
  context: Pick<CourseDocumentContext, "libraryId" | "documentFactor">;
}

export interface PageLayer {
  stream: PassStream;
  /** The map layer's colours ⊕ white and the block ink ⊕ page-object colours; the stream indexes it. */
  colours: DocumentColour[];
  transform: MapLayerTransform;
  /** The frame, page µm y-up. */
  frameUm: ComposedPage["frameUm"];
  /** The frame's corners in paper mm (y-up): where the map layer is clipped. */
  frameRing: MapPoint[];
  /** Page images (`layer: "page"`, page µm); never in the stream. */
  images: PageImage[];
  warnings: PageWarning[];
}

/**
 * The page layer of `input`, its colours appended to `mapColours` (the
 * course layer's completed stack): a page white-out and a 709 area take
 * the stack's own white and purple, layout-object hex colours follow.
 */
export function pageLayer(input: PageLayerInput, mapColours: readonly DocumentColour[], fonts: FontMetrics[]): PageLayer {
  const H = input.paper.heightMm;
  const frameUm = frameRectUm(input.frame, H);
  const transform = mapLayerTransform(input.frame, input.window, H);
  const warnings: PageWarning[] = [];

  // Page-anchored objects, flipped to y-up page mm, through the course layer's object builder.
  const pageObjects = input.objects.filter((o) => o.anchor === "page").map((o) => flipPageObject(o, H));
  const ink = input.description?.colour ?? "#000000";
  const palette = withObjectColours([...mapColours], [...(input.description ? ["#ffffff", ink] : []), ...objectColours(pageObjects)]);
  // White-out and 709 on the page in the map's own entries, at the size they print on the map.
  const stackIndex = courseColourStack([...mapColours]).index;
  const set = courseSymbols(
    { libraryId: input.context.libraryId, documentFactor: input.context.documentFactor * transform.scaleRatio },
    stackIndex,
    {},
  );
  const pageSymbols: RenderSymbol[] = [...set.symbols];
  // A page-anchored white-out outside covers the frame (legacy: the ring against the map frame).
  const fr = grow(frameUm, RING_BLEED_UM);
  const frameRing = [
    { x: fr.x / 1000, y: fr.y / 1000 },
    { x: (fr.x + fr.width) / 1000, y: fr.y / 1000 },
    { x: (fr.x + fr.width) / 1000, y: (fr.y + fr.height) / 1000 },
    { x: fr.x / 1000, y: (fr.y + fr.height) / 1000 },
  ];
  const built = layoutObjects(pageObjects, set, pageSymbols, palette.indexOf, { overprintScale: 1, window: frameRing, textValues: input.textValues }, stackIndex.get("purple-upper")!);
  for (const w of built.warnings) warnings.push({ code: w.code, message: w.message });
  const render = built.objects.map(({ ref: _ref, ...o }) => o);
  if (input.description) {
    const block = descriptionBlock(input.description, H, palette.indexOf);
    const offset = pageSymbols.length;
    pageSymbols.push(...block.symbols);
    for (const o of block.objects) render.push({ ...o, symbolIdx: o.symbolIdx + offset });
  }
  const page = symbolise({ objects: render, symbols: pageSymbols, fonts });
  for (const w of page.warnings) warnings.push({ code: w.code, message: `page layer: ${w.message}` });

  const images: PageImage[] = built.images.map((i) => ({ layer: "page" as const, graphicId: i.object.graphicId, rectUm: i.rectUm, ...(i.object.crop ? { crop: i.object.crop } : {}) }));
  return { stream: page.stream, colours: palette.colours, transform, frameUm, frameRing: frameInMap(transform, frameUm), images, warnings };
}

/**
 * The page layer's stream in paper µm (y-up): through `T_map⁻¹`, so a
 * viewer drawing the map can draw the page with the same view matrix
 * (docs/course-layout.md §1 "Page view").
 */
export function pageStreamInMap(layer: Pick<PageLayer, "stream" | "transform">): PassStream {
  return transformPassStream(layer.stream, inverseMapLayerTransform(layer.transform));
}
