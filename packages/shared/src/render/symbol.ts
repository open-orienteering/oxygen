/**
 * The `RenderSymbol` IR — what the symbolisation stage reads. Imported
 * OCAD/OMAP symbols are converted into it (06); the canonical IOF library
 * is authored in it (03 §6.4). Normative: docs/map-symbols.md (slice B);
 * research record 03 §6.2.
 *
 * Lengths are µm at the document's reference scale, already multiplied by
 * `documentFactor` (03 §6.6). Colours are indices into the document's
 * colour stack. Angles are degrees, counter-clockwise from +x.
 */

import { z } from "zod";

const um = z.number();
const colourRef = z.number().int().min(0);
const cap = z.enum(["flat", "round", "square", "pointed"]);
const join = z.enum(["bevel", "miter", "round"]);

/** Geometry inside a glyph: x,y pairs in glyph-local µm plus flag bytes. */
export const glyphCoordsSchema = z.object({
  coords: z.array(z.number()),
  flags: z.array(z.number().int().min(0).max(255)).optional(),
  closed: z.boolean().optional(),
});

export const glyphPartSchema = z.object({
  kind: z.enum(["stroke", "fill", "ring", "disc"]),
  colour: colourRef,
  widthUm: um.optional(),
  diameterUm: um.optional(),
  cap: cap.optional(),
  join: join.optional(),
  geometry: glyphCoordsSchema.optional(),
  /** Centre for ring / disc, glyph-local µm. Default origin. */
  cx: um.optional(),
  cy: um.optional(),
});

export const glyphSchema = z.object({
  parts: z.array(glyphPartSchema).min(1),
  /** Follows the object's / tangent's angle; otherwise north-up. */
  rotatable: z.boolean(),
});

export const glyphPlacementSchema = z.discriminatedUnion("at", [
  z.object({ at: z.literal("start") }),
  z.object({ at: z.literal("end") }),
  z.object({ at: z.literal("corners"), ignoreEnds: z.boolean().optional() }),
  z.object({ at: z.literal("dashPoints"), ignoreEnds: z.boolean().optional() }),
  z.object({ at: z.literal("dashCentres") }),
  /** Centre of each dash *before* its secondary split (OCAD main symbol in the secondary gap). */
  z.object({ at: z.literal("dashGroupCentres") }),
  z.object({ at: z.literal("gapCentres") }),
  /** Once at the centre of each section between corner / dash points (OCAD secondary symbol). */
  z.object({ at: z.literal("sectionCentres") }),
  z.object({
    at: z.literal("spaced"),
    distanceUm: um.positive(),
    firstUm: um.optional(),
    lastUm: um.optional(),
    perSpot: z.number().int().min(1).optional(),
    spotSpacingUm: um.optional(),
    minCount: z.number().int().min(0).optional(),
    minCountClosed: z.number().int().min(0).optional(),
  }),
]);

export const dashPatternSchema = z.object({
  layout: z.enum(["ocad", "omap"]),
  dashUm: um.positive(),
  gapUm: um.nonnegative(),
  endDashUm: um.optional(),
  secondaryGapUm: um.optional(),
  dashesInGroup: z.number().int().min(1).optional(),
  /** OCAD `endGap`: the secondary gap applied to the *end* dashes (0 / absent = end dashes stay whole). */
  endGapUm: um.optional(),
  minGaps: z.number().int().min(0).optional(),
  /** OMAP `half_outer_dashes`. */
  halfOuterDashes: z.boolean().optional(),
  /** OMAP `show_at_least_one_symbol` (dash context: draw one dash on very short lines). */
  showAtLeastOne: z.boolean().optional(),
});

export const strokeSpecSchema = z.object({
  colour: colourRef,
  widthUm: um.nonnegative(),
  cap: cap.default("flat"),
  join: join.default("miter"),
  dash: dashPatternSchema.optional(),
  shortenStartUm: um.optional(),
  shortenEndUm: um.optional(),
  /**
   * Pointed line ends (`cap: "pointed"`): the width falls linearly to 0
   * over `startUm` from the line's start and `endUm` towards its end
   * (OCAD `distFromStart` / `distToEnd` on a pointed line, Mapper
   * `pointed_cap_length`). Ignored for other caps.
   */
  taper: z.object({ startUm: um.positive().optional(), endUm: um.positive().optional() }).optional(),
  /**
   * Stroke drawn under the main line, `widthUm` wider on each side. Follows
   * the main line's dashes unless `continuous` (OCAD's framing line, which
   * is solid under a dashed main line — 509 railway).
   */
  halo: z
    .object({ colour: colourRef, widthUm: um, continuous: z.boolean().optional() })
    .refine((h) => h.widthUm > 0 || (h.continuous === true && h.widthUm !== 0), {
      message: "halo.widthUm must be positive, or negative with continuous (a framing line narrower than the main line)",
    })
    .optional(),
});

export const borderSpecSchema = z.object({
  colour: colourRef,
  widthUm: um.positive(),
  /** Offset of the border's centre line from the main line's centre. */
  shiftUm: um.positive(),
  dash: dashPatternSchema.optional(),
});

export const lineSymbolBodySchema = z.object({
  main: strokeSpecSchema.optional(),
  /**
   * Rounds the path's polyline corners with this radius before anything
   * is laid out (OCAD rectangle symbols; map-rendering §4.4).
   */
  cornerRadiusUm: um.positive().optional(),
  borders: z
    .object({
      left: borderSpecSchema.optional(),
      right: borderSpecSchema.optional(),
      /** Band drawn under the borders, centred on the main line. */
      backgroundColour: colourRef.optional(),
      /** Width of that band; default `left.shiftUm + right.shiftUm` (edge to edge). OCAD's double-line fill is `dblWidth`. */
      backgroundWidthUm: um.positive().optional(),
      /**
       * Further border pairs drawn like `left` / `right`, after them
       * (Mapper combined symbols with a second pair of borders, 502.2).
       * They take no part in the background band.
       */
      extraPairs: z.array(z.object({ left: borderSpecSchema.optional(), right: borderSpecSchema.optional() })).optional(),
    })
    .optional(),
  glyphs: z
    .array(
      z.object({
        glyph: glyphSchema,
        placement: glyphPlacementSchema,
        scaleAtCorners: z.boolean().optional(),
      }),
    )
    .optional(),
});

const symbolCommon = {
  id: z.string(),
  code: z.string(),
  name: z.string(),
  minimum: z.object({ lengthUm: um.optional(), areaUm2: um.optional() }).optional(),
};

export const lineSymbolSchema = lineSymbolBodySchema.extend({ type: z.literal("line"), ...symbolCommon });

const rotateMode = z.enum(["always", "manual", "never"]);

export const hatchSpecSchema = z.object({
  colour: colourRef,
  widthUm: um.positive(),
  spacingUm: um.positive(),
  offsetUm: um.default(0),
  angleDeg: z.number().default(0),
  rotate: rotateMode.default("manual"),
});

export const patternSpecSchema = z.object({
  glyph: glyphSchema,
  cellWidthUm: um.positive(),
  cellHeightUm: um.positive(),
  angleDeg: z.number().default(0),
  offsetXUm: um.default(0),
  offsetYUm: um.default(0),
  shiftedRows: z.boolean().default(false),
  clip: z.enum(["clip", "completelyInside", "centreInside", "partiallyInside"]).default("centreInside"),
  rotate: rotateMode.default("manual"),
});

export const areaSymbolSchema = z.object({
  type: z.literal("area"),
  ...symbolCommon,
  fill: colourRef.optional(),
  hatches: z.array(hatchSpecSchema).optional(),
  patterns: z.array(patternSpecSchema).optional(),
  border: lineSymbolBodySchema.optional(),
});

export const pointSymbolSchema = z.object({
  type: z.literal("point"),
  ...symbolCommon,
  glyph: glyphSchema,
  orientation: z.enum(["north", "object"]).default("object"),
});

export const textSymbolSchema = z.object({
  type: z.literal("text"),
  ...symbolCommon,
  fontFamily: z.enum(["liberation-sans", "liberation-sans-narrow", "liberation-serif", "liberation-mono"]),
  /** Em size. Ignored when `digitHeightUm` is given. */
  fontSizeUm: um.positive(),
  /** Size by digit height (ISOM 704 "4.0 mm"); em derived from the font. */
  digitHeightUm: um.positive().optional(),
  weight: z.number().int().default(400),
  italic: z.boolean().default(false),
  colour: colourRef,
  align: z.enum(["left", "centre", "right", "justify"]).default("left"),
  /**
   * Where the object's anchor sits vertically: on the first line's
   * baseline (default), at the first line's ascent (`top`), at the last
   * line's descent (`bottom`), or midway between the two (`middle`).
   * No default on purpose: a parsed symbol must stay byte-identical when
   * the field is absent (document hashes and decision fingerprints are
   * over the parsed IR, map-rendering §4.9).
   */
  verticalAlign: z.enum(["baseline", "top", "middle", "bottom"]).optional(),
  /** Baseline-to-baseline distance as a multiple of em. */
  lineSpacing: z.number().positive().default(1.2),
  paragraphSpacingUm: um.default(0),
  /** Extra advance per glyph as a fraction of em. */
  charSpacing: z.number().default(0),
  wordSpacing: z.number().optional(),
  halo: z.object({ colour: colourRef, widthUm: um.positive() }).optional(),
  /**
   * A copy of the text in `colour`, offset by (`offsetXUm`, `offsetYUm`)
   * — paper µm, y-up, rotated with the text — and drawn as its own pass
   * (OCAD shadow framing, Mapper framing mode "shadow").
   */
  shadow: z.object({ colour: colourRef, offsetXUm: um, offsetYUm: um }).optional(),
});

export const renderSymbolSchema = z.discriminatedUnion("type", [
  pointSymbolSchema,
  lineSymbolSchema,
  areaSymbolSchema,
  textSymbolSchema,
]);

export type GlyphPart = z.output<typeof glyphPartSchema>;
export type Glyph = z.output<typeof glyphSchema>;
export type GlyphPlacement = z.output<typeof glyphPlacementSchema>;
export type DashPattern = z.output<typeof dashPatternSchema>;
export type StrokeSpec = z.output<typeof strokeSpecSchema>;
export type BorderSpec = z.output<typeof borderSpecSchema>;
export type LineSymbolBody = z.output<typeof lineSymbolBodySchema>;
export type LineSymbol = z.output<typeof lineSymbolSchema>;
export type HatchSpec = z.output<typeof hatchSpecSchema>;
export type PatternSpec = z.output<typeof patternSpecSchema>;
export type AreaSymbol = z.output<typeof areaSymbolSchema>;
export type PointSymbol = z.output<typeof pointSymbolSchema>;
export type TextSymbol = z.output<typeof textSymbolSchema>;
export type RenderSymbol = z.output<typeof renderSymbolSchema>;
export type RenderSymbolInput = z.input<typeof renderSymbolSchema>;

/** Parse and apply defaults; throws on invalid input. */
export function parseRenderSymbol(input: unknown): RenderSymbol {
  return renderSymbolSchema.parse(input);
}

export const colourEntrySchema = z.object({
  id: z.string(),
  name: z.string(),
  cmyk: z.tuple([z.number(), z.number(), z.number(), z.number()]),
  spot: z.object({ name: z.string().optional(), knockout: z.boolean().optional() }).optional(),
  overprint: z.boolean().optional(),
  purpleRole: z.enum(["lower", "upper"]).optional(),
});
export type ColourEntry = z.output<typeof colourEntrySchema>;
/** Index = draw order, 0 drawn first. */
export type ColourStack = ColourEntry[];

/** Naive CMYK → sRGB hex, the shared screen conversion (03 §2.3). */
export function cmykToHex([c, m, y, k]: readonly [number, number, number, number]): string {
  const ch = (v: number) => Math.round(255 * (1 - Math.min(1, v)) * (1 - Math.min(1, k)));
  const h = (v: number) => v.toString(16).padStart(2, "0");
  return `#${h(ch(c))}${h(ch(m))}${h(ch(y))}`;
}
