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
 * - Images: PNG bytes per graphic id from the caller (SVG logos are
 *   rasterised in the API, 05 §5.7 a — the module stays isomorphic).
 */

import { courseLayer, courseRenderInput } from "../course/layer.js";
import { courseColourStack, withObjectColours } from "../course/colour-stack.js";
import { layoutObjects, objectColours } from "../course/objects.js";
import { courseSymbols } from "../course/symbols.js";
import type { FontMetrics } from "../render/truetype.js";
import type { RenderSymbol } from "../render/symbol.js";
import { symbolise } from "../render/symbolise.js";
import { type ColourMode, colourOperator, pageColour } from "./colour.js";
import { descriptionBlock } from "./description.js";
import { geoViewport } from "./geo.js";
import { type Matrix, UM_TO_PT, cmOperator, fmtMm, mapLayerOperators } from "./operators.js";
import { type ComposedPage, type PageImage, type PageInput, type PageWarning, flipPageObject, frameInMap, frameRectUm, mapLayerTransform } from "./page.js";
import type { PdfWriter } from "./writer.js";

/**
 * How far the outer boundary of a white-out outside lies beyond the frame:
 * the frame clip cuts it back, and no anti-aliased seam of map ink is left
 * between the clip edge and a ring edge on the same line.
 */
export const RING_BLEED_UM = 1000;

const grow = (r: ComposedPage["frameUm"], d: number): ComposedPage["frameUm"] => ({ x: r.x - d, y: r.y - d, width: r.width + 2 * d, height: r.height + 2 * d });

export function composePage(input: PageInput, fonts: FontMetrics[]): ComposedPage {
  const H = input.paper.heightMm;
  const frameUm = frameRectUm(input.frame, H);
  const transform = mapLayerTransform(input.frame, input.window, H);
  const warnings: PageWarning[] = [];

  // Map layer: document window ⊕ course layer, one stream.
  const layer = courseLayer({
    structure: input.course.structure,
    sites: input.course.sites,
    objects: [...input.objects, ...(input.course.objects ?? [])],
    appearance: input.course.appearance,
    viewOptions: { ...input.course.viewOptions, window: frameInMap(transform, grow(frameUm, RING_BLEED_UM)), textValues: input.textValues },
    document: input.map.context,
    ...(input.map.cutFeatures ? { cutFeatures: input.map.cutFeatures } : {}),
    ...(input.course.regions ? { regions: input.course.regions } : {}),
  });
  for (const w of layer.warnings) warnings.push({ code: w.code, message: w.message });
  const merged = courseRenderInput(input.map, layer);
  const map = symbolise({ objects: merged.objects, symbols: merged.symbols, fonts, regions: merged.regions, regionObjectLimit: merged.regionObjectLimit });
  for (const w of map.warnings) warnings.push({ code: w.code, message: `map layer: ${w.message}` });

  // Page layer: page-anchored objects, flipped to y-up page mm, through the course layer's object builder.
  const pageObjects = input.objects.filter((o) => o.anchor === "page").map((o) => flipPageObject(o, H));
  const ink = input.description?.colour ?? "#000000";
  const palette = withObjectColours(layer.colours, [...(input.description ? ["#ffffff", ink] : []), ...objectColours(pageObjects)]);
  // White-out and 709 on the page in the map's own entries, at the size they print on the map.
  const stackIndex = courseColourStack(layer.colours).index;
  const set = courseSymbols(
    { libraryId: input.map.context.libraryId, documentFactor: input.map.context.documentFactor * transform.scaleRatio },
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
  const pageRender = built.objects.map(({ ref: _ref, ...o }) => o);
  if (input.description) {
    const block = descriptionBlock(input.description, H, palette.indexOf);
    const offset = pageSymbols.length;
    pageSymbols.push(...block.symbols);
    for (const o of block.objects) pageRender.push({ ...o, symbolIdx: o.symbolIdx + offset });
  }
  const page = symbolise({ objects: pageRender, symbols: pageSymbols, fonts });
  for (const w of page.warnings) warnings.push({ code: w.code, message: `page layer: ${w.message}` });

  const images: PageImage[] = [
    ...layer.images.map((i) => ({ layer: "map" as const, graphicId: i.object.graphicId, rectUm: i.rectUm, ...(i.object.crop ? { crop: i.object.crop } : {}) })),
    ...built.images.map((i) => ({ layer: "page" as const, graphicId: i.object.graphicId, rectUm: i.rectUm, ...(i.object.crop ? { crop: i.object.crop } : {}) })),
  ];

  return {
    paper: input.paper,
    frameUm,
    colours: palette.colours,
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

/** `cm` placing an image's unit square on `rect` (layer µm), the crop's part filling it (schema crop: top-left fractions). */
function imageOperators(img: PageImage, name: string): string {
  const { x, y, width, height } = img.rectUm;
  const c = img.crop ?? { x: 0, y: 0, width: 1, height: 1 };
  // Source unit square scaled so the crop window fills the rect; source y-up, crop y measured from the top.
  const sw = width / c.width, sh = height / c.height;
  const ox = x - c.x * sw, oy = y - (1 - c.y - c.height) * sh;
  const clip = img.crop ? `${x} ${y} ${width} ${height} re W n ` : "";
  return `q ${clip}${cmOperator([sw, 0, 0, sh, ox, oy], 3)} /${name} Do Q`;
}

export interface WritePageOptions {
  mode: ColourMode;
  /** PNG bytes per graphic id; images without bytes are skipped (and reported). */
  images?: ReadonlyMap<number, Uint8Array>;
}

/**
 * One composed page onto a new writer page (research 05 Appendix A):
 *
 * ```
 * <white> 0 0 W H re f                         sheet
 * q <frame> re W n                             map frame clip
 *   q <T_map> cm 4 M <passes> Q                map layer (µm rel. window centre)
 *   q <T_map> cm <map images> Q
 * Q
 * q <µm → pt> cm 4 M <passes> <page images> Q   page layer
 * ```
 */
export async function writePage(writer: PdfWriter, page: ComposedPage, opts: WritePageOptions): Promise<{ warnings: string[] }> {
  const warnings: string[] = [];
  const W = page.paper.widthMm * (72 / 25.4), Hp = page.paper.heightMm * (72 / 25.4);
  const wp = writer.addPage({ widthPt: W, heightPt: Hp, label: page.label, outlineTitle: page.label });
  const t = page.mapLayer.transform;
  const a = (t.rotationDeg * Math.PI) / 180;
  const s = t.scaleRatio * UM_TO_PT;
  const tMap: Matrix = [Math.cos(a) * s, Math.sin(a) * s, -Math.sin(a) * s, Math.cos(a) * s, t.atUm[0] * UM_TO_PT, t.atUm[1] * UM_TO_PT];
  const pageMatrix: Matrix = [UM_TO_PT, 0, 0, UM_TO_PT, 0, 0];
  const f = page.frameUm;

  const imageOps = async (layer: PageImage["layer"], origin: [number, number]) => {
    const out: string[] = [];
    for (const img of page.images.filter((i) => i.layer === layer)) {
      const png = opts.images?.get(img.graphicId);
      if (!png) {
        warnings.push(`IMAGE_MISSING: graphic ${img.graphicId} has no image data; not drawn`);
        continue;
      }
      const { name } = await wp.image(png);
      out.push(imageOperators({ ...img, rectUm: { ...img.rectUm, x: img.rectUm.x - origin[0], y: img.rectUm.y - origin[1] } }, name));
    }
    return out;
  };
  const mapImages = await imageOps("map", t.originUm);
  const pageImages = await imageOps("page", [0, 0]);

  const ops = [
    `${colourOperator(pageColour("#ffffff", opts.mode), "fill")} 0 0 ${fmtMm(W)} ${fmtMm(Hp)} re f`,
    "q",
    `${pt(f.x)} ${pt(f.y)} ${pt(f.width)} ${pt(f.height)} re W n`,
    mapLayerOperators(page.mapLayer.stream, { colours: page.colours, mode: opts.mode, resources: wp.resources, originUm: t.originUm, matrix: tMap }),
    ...(mapImages.length ? ["q", cmOperator(tMap, 9), ...mapImages, "Q"] : []),
    "Q",
    mapLayerOperators(page.pageLayer.stream, { colours: page.colours, mode: opts.mode, resources: wp.resources, matrix: pageMatrix }),
    ...(pageImages.length ? ["q", cmOperator(pageMatrix, 9), ...pageImages, "Q"] : []),
  ];
  wp.addContent(ops.join("\n"));
  if (page.geo) wp.setGeoViewports([page.geo]);
  return { warnings };
}
