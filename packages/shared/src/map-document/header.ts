/**
 * Map document header — the JSON half of the hybrid format
 * (docs/map-document-format.md §2; research record 02 §6.3).
 *
 * Everything that is small, readable and changes with the import
 * (provenance, scale, georeferencing, colours, symbols, matches, texts)
 * lives here and is validated with Zod. Geometry and the per-object
 * tables live in the binary sections the header's `objects.sections`
 * directory points at.
 */

import { z } from "zod";
import { colourEntrySchema, renderSymbolSchema } from "../render/symbol.js";

export const MAP_DOCUMENT_MAGIC = "OXVM";
/** Major format version; readers reject anything else (§6). */
export const MAP_DOCUMENT_VERSION = 1;

/** Object types, OCAD numbering kept verbatim (02 §2.1). */
export const OBJECT_TYPE = {
  point: 1,
  line: 2,
  area: 3,
  text: 4,
  formattedText: 5,
  lineText: 6,
  rectangle: 7,
} as const;
export type ObjectType = (typeof OBJECT_TYPE)[keyof typeof OBJECT_TYPE];

export const sectionRangeSchema = z.object({
  /** Bytes from the start of the body (see `bodyOffset`). */
  offset: z.number().int().min(0),
  length: z.number().int().min(0),
});

export const boundsSchema = z.object({
  minX: z.number().int(),
  minY: z.number().int(),
  maxX: z.number().int(),
  maxY: z.number().int(),
});
export type DocumentBounds = z.output<typeof boundsSchema>;

export const documentColourSchema = colourEntrySchema.extend({
  /** Source colour number; absent for palette entries inserted by alignment (03 §6.3). */
  sourceNumber: z.number().int().optional(),
  /** IOF palette ids this stack entry stands for (03 §6.3 step 2–3); canonical renders resolve through them. */
  paletteIds: z.array(z.string()).optional(),
});
export type DocumentColour = z.output<typeof documentColourSchema>;

export const symbolMatchSchema = z.object({
  canonicalId: z.string().nullable(),
  /** `variant`: numbered into a known family but of another kind (minimum-size point, outline line) — kept as source, nothing to suggest. */
  method: z.enum(["explicit", "code+geometry", "family+geometry", "geometry", "description", "variant", "none"]),
  /** `auto` is drawn canonically; `suggested` waits for review; `unmatched` draws from source. */
  state: z.enum(["auto", "suggested", "unmatched"]),
  confidence: z.number().min(0).max(1),
  reasons: z.array(z.string()).default([]),
  reviewed: z.boolean().default(false),
  libraryVersion: z.string(),
  /** Runner-up candidates for the review UI, best first. */
  alternatives: z.array(z.object({ canonicalId: z.string(), confidence: z.number().min(0).max(1) })).optional(),
});
export type SymbolMatch = z.output<typeof symbolMatchSchema>;

export const documentSymbolSchema = z.object({
  /** Source symbol number as written, e.g. "505.1"; "graphic" for synthesised entries. */
  code: z.string(),
  name: z.string(),
  /** Source symbol type. */
  kind: z.enum(["point", "line", "area", "text", "rectangle", "unknown"]),
  /**
   * `source`   — from the source symbol table;
   * `graphic`  — synthesised for OCAD graphic/image objects (`sym` −2/−3), one per (type, colour, width);
   * `missing`  — referenced by objects but absent from the source table.
   */
  origin: z.enum(["source", "graphic", "missing"]).default("source"),
  /** Default visibility (OCAD status bit 1). Consumers may override. */
  hidden: z.boolean().default(false),
  /** Position in the source symbol table (provenance / export). */
  sourceIndex: z.number().int().optional(),
  /** Font name as the source wrote it (text symbols). */
  sourceFont: z.string().optional(),
  /** The definition in the render IR; `null` when the normaliser could not express it (drawn as a proxy, warned). */
  render: renderSymbolSchema.nullable(),
  match: symbolMatchSchema.optional(),
});
export type DocumentSymbol = z.output<typeof documentSymbolSchema>;
export type DocumentSymbolInput = z.input<typeof documentSymbolSchema>;

export const georeferencingSchema = z.object({
  crs: z.object({ authority: z.string(), code: z.number().int(), name: z.string() }).nullable(),
  /** Projected easting / northing of paper (0, 0); null when not georeferenced. */
  paperOrigin: z.object({ x: z.number(), y: z.number() }).nullable(),
  /** Grivation: grid north → paper +y, clockwise positive, degrees. */
  gridRotationDeg: z.number().default(0),
  gridScaleFactor: z.number().default(1),
  declinationDeg: z.number().optional(),
  realWorldEnabled: z.boolean().optional(),
  /** OCAD grid id (ScalePar `i`) as written, for export. */
  sourceGridId: z.number().int().optional(),
});
export type Georeferencing = z.output<typeof georeferencingSchema>;

export const printWindowSchema = z.object({
  /** Print scale denominator. */
  scale: z.number().positive().optional(),
  /** Paper mm, y-up. */
  left: z.number(),
  bottom: z.number(),
  right: z.number(),
  top: z.number(),
});

export const documentWarningSchema = z.object({
  /** Stable code (06 §4.4), e.g. `TEMPLATES_DROPPED`. */
  code: z.string(),
  count: z.number().int().min(1),
  message: z.string().optional(),
});
export type DocumentWarning = z.output<typeof documentWarningSchema>;

export const mapDocumentHeaderSchema = z.object({
  format: z.object({
    version: z.literal(MAP_DOCUMENT_VERSION),
    /** Importer version string; bumped whenever the same file would encode differently (06 §4.3). */
    importer: z.string(),
  }),
  /**
   * Source file identity. Deliberately without the upload name: the same
   * bytes must produce the same document whatever the file was called
   * (06 §4.2 dedup); the name lives on the source row and in the report.
   */
  source: z.object({
    kind: z.enum(["ocad", "omap"]),
    version: z.string(),
    /** SHA-256 hex of the source file. */
    hash: z.string(),
    bytes: z.number().int().min(0),
  }),
  /** Native paper unit: OCAD 100, OMAP 1000. */
  unitsPerMm: z.number().int().positive(),
  mapScale: z.number().positive(),
  /** 03 §6.6: library reference scale / map scale × symbol scale; 1 until the matcher sets it. */
  documentFactor: z.number().positive().default(1),
  /** Canonical library the matches refer to; null before matching. */
  library: z.object({ id: z.string(), version: z.string() }).nullable().default(null),
  georeferencing: georeferencingSchema,
  /** Union of object bounding boxes, native units. */
  bounds: boundsSchema,
  printWindow: printWindowSchema.nullable().default(null),
  exportRectangles: z.array(printWindowSchema.extend({ name: z.string() })).default([]),
  /** Colour stack: index = draw order, 0 drawn first. */
  colours: z.array(documentColourSchema),
  symbols: z.array(documentSymbolSchema),
  /** Texts; `attrs.stringIdx` is 1-based into this list (0 = none). */
  strings: z.array(z.string()),
  warnings: z.array(documentWarningSchema).default([]),
  objects: z.object({
    count: z.number().int().min(0),
    sections: z.object({
      attrs: sectionRangeSchema,
      bboxes: sectionRangeSchema,
      geometry: sectionRangeSchema,
    }),
  }),
});
export type MapDocumentHeader = z.output<typeof mapDocumentHeaderSchema>;
export type MapDocumentHeaderInput = z.input<typeof mapDocumentHeaderSchema>;

export function parseMapDocumentHeader(input: unknown): MapDocumentHeader {
  return mapDocumentHeaderSchema.parse(input);
}
