/**
 * The page composer (docs/course-print.md §4–7; research 05 §5.1):
 * `composePage` builds the layers of one page from its `PageInput`,
 * `writePage` emits them onto a `PdfWriter` page.
 *
 * - Map layer: the pinned document's window objects and the course layer
 *   (C0) in **one** `symbolise` call, so lower purple, line art,
 *   map-anchored white-outs and upper purple come out in colour-stack
 *   order; drawn under `T_map`, clipped to the frame.
 * - Page layer: page-anchored objects and the description block through
 *   the same stage, in page µm; colours appended to the map stack, so a
 *   page white-out and a 709 area print in the stack's own white and
 *   purple and the hex colours of layout objects follow it.
 * - Images: passes in each layer's graphics row (J5); PNG bytes per
 *   graphic id from the caller (SVG logos are rasterised in the API,
 *   05 §5.7 a — the module stays isomorphic).
 */

import { courseLayer, courseRenderInput } from "../course/layer.js";
import { RING_BLEED_UM, mapLayerWindow, pageLayer } from "../course/page-layer.js";
import type { ImageWindow } from "../render/image-window.js";
import type { FontMetrics } from "../render/truetype.js";
import { symbolise } from "../render/symbolise.js";
import { type ColourMode, colourOperator, pageColour } from "./colour.js";
import { geoViewport } from "./geo.js";
import { type Matrix, UM_TO_PT, fmtMm, mapLayerOperators } from "./operators.js";
import { type ComposedPage, type PageImage, type PageInput, type PageWarning, frameRectUm, mapLayerTransform } from "./page.js";
import type { PdfWriter, PdfWriterPage } from "./writer.js";

export { RING_BLEED_UM };

export function composePage(input: PageInput, fonts: FontMetrics[]): ComposedPage {
  const H = input.paper.heightMm;
  const frameUm = frameRectUm(input.frame, H);
  const transform = mapLayerTransform(input.frame, input.window, H);
  const warnings: PageWarning[] = [];

  // Map layer: document window ⊕ course layer, one stream.
  const layer = courseLayer({
    structure: input.course.structure,
    sites: input.course.sites,
    objects: input.course.objects ?? [],
    appearance: input.course.appearance,
    viewOptions: { ...input.course.viewOptions, window: mapLayerWindow(input), textValues: input.textValues },
    document: input.map.context,
    ...(input.map.cutFeatures ? { cutFeatures: input.map.cutFeatures } : {}),
    ...(input.course.regions ? { regions: input.course.regions } : {}),
  });
  for (const w of layer.warnings) warnings.push({ code: w.code, message: w.message });
  const merged = courseRenderInput(input.map, layer);
  const map = symbolise({ objects: merged.objects, symbols: merged.symbols, fonts, regions: merged.regions, regionObjectLimit: merged.regionObjectLimit });
  for (const w of map.warnings) warnings.push({ code: w.code, message: `map layer: ${w.message}` });

  // Page layer: page-anchored objects and the description block, colours appended to the map stack.
  const page = pageLayer({ ...input, context: input.map.context }, layer.colours, fonts);
  warnings.push(...page.warnings);

  const images: PageImage[] = [
    ...layer.images.map((i) => ({ layer: "map" as const, ...i })),
    ...page.images,
  ];

  return {
    paper: input.paper,
    frameUm,
    colours: page.colours,
    mapLayer: { stream: map.stream, transform },
    pageLayer: { stream: page.stream },
    marksLayer: null,
    images,
    geo: input.geo ? geoViewport(frameUm, transform, input.geo) : null,
    label: input.label,
    warnings,
  };
}

/** Page-space number in points, 3 decimals. */
const pt = (um: number) => fmtMm(um * UM_TO_PT);

export interface WritePageOptions {
  mode: ColourMode;
  /** PNG bytes per graphic id; images without bytes are skipped (and reported). */
  images?: ReadonlyMap<number, Uint8Array>;
  /** The part of the graphic a PNG shows, by graphic id (an SVG rasterised over its crops' window, §6.3); absent = all. */
  windows?: ReadonlyMap<number, ImageWindow>;
}

/**
 * One composed page onto a new writer page (research 05 Appendix A):
 *
 * ```
 * <white> 0 0 W H re f                         sheet
 * q <frame> re W n                             map frame clip
 *   q <T_map> cm 4 M <passes> Q                map layer (µm rel. window centre)
 * Q
 * q <µm → pt> cm 4 M <passes> Q                page layer
 * ```
 *
 * Images are passes in their layer's graphics row (J5): every graphic the
 * page names is embedded first (map layer, then page, first-use order
 * `Im<n>`), then both streams are written with the names.
 */
export async function writePage(writer: PdfWriter, page: ComposedPage, opts: WritePageOptions): Promise<{ warnings: string[]; page: PdfWriterPage }> {
  const warnings: string[] = [];
  const W = page.paper.widthMm * (72 / 25.4), Hp = page.paper.heightMm * (72 / 25.4);
  const wp = writer.addPage({ widthPt: W, heightPt: Hp, label: page.label, outlineTitle: page.label });
  const t = page.mapLayer.transform;
  const a = (t.rotationDeg * Math.PI) / 180;
  const s = t.scaleRatio * UM_TO_PT;
  const tMap: Matrix = [Math.cos(a) * s, Math.sin(a) * s, -Math.sin(a) * s, Math.cos(a) * s, t.atUm[0] * UM_TO_PT, t.atUm[1] * UM_TO_PT];
  const pageMatrix: Matrix = [UM_TO_PT, 0, 0, UM_TO_PT, 0, 0];
  const f = page.frameUm;

  const names = new Map<number, string>();
  for (const img of page.images) {
    const png = opts.images?.get(img.graphicId);
    if (!png) {
      warnings.push(`IMAGE_MISSING: graphic ${img.graphicId} has no image data; not drawn`);
      continue;
    }
    if (!names.has(img.graphicId)) names.set(img.graphicId, (await wp.image(png)).name);
  }

  const ops = [
    `${colourOperator(pageColour("#ffffff", opts.mode), "fill")} 0 0 ${fmtMm(W)} ${fmtMm(Hp)} re f`,
    "q",
    `${pt(f.x)} ${pt(f.y)} ${pt(f.width)} ${pt(f.height)} re W n`,
    mapLayerOperators(page.mapLayer.stream, { colours: page.colours, mode: opts.mode, resources: wp.resources, images: names, imageWindows: opts.windows, originUm: t.originUm, matrix: tMap, frame: { x: f.x * UM_TO_PT, y: f.y * UM_TO_PT, width: f.width * UM_TO_PT, height: f.height * UM_TO_PT } }),
    "Q",
    mapLayerOperators(page.pageLayer.stream, { colours: page.colours, mode: opts.mode, resources: wp.resources, images: names, imageWindows: opts.windows, matrix: pageMatrix }),
  ];
  wp.addContent(ops.join("\n"));
  if (page.geo) wp.setGeoViewports([page.geo]);
  return { warnings, page: wp };
}
