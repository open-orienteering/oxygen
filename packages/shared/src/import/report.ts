/**
 * Import report (docs/map-import.md §5, docs/map-storage.md §3): what stages 3–8 did to a file,
 * stored next to the document and asserted on by tests. Warning codes are
 * stable identifiers, never prose. The slice-A shape carries what the
 * OCAD stages produce; the matcher, colour alignment and analysis stages
 * add their sections when they land (optional until then).
 */

import { z } from "zod";

export const importWarningSchema = z.object({
  code: z.string(),
  message: z.string().optional(),
  count: z.number().int().min(1),
});

/**
 * One warning emission (docs/map-import.md §3.6): the code, the full message
 * and, for warnings about one symbol, its index in the document's symbol list.
 */
export const importWarningDetailSchema = z.object({
  code: z.string(),
  message: z.string(),
  symbolIdx: z.number().int().min(0).optional(),
});

/** At most this many `warningDetails` entries are kept per import (the rest are still counted in `warnings`). */
export const WARNING_DETAILS_MAX = 500;

/**
 * What a warning code means for the import (docs/map-import.md §7):
 * - `unsupported`: a drawing construct of the source was dropped or approximated because the document
 *   cannot represent it — the "unsupported primitive" of 09 §7's exit criterion; the S0 gate fails on these;
 * - `by-design`: something the pipeline drops on purpose (templates, layout objects, tags, parts, helper symbols);
 * - `source-error`: the source file is inconsistent (stale or missing references, duplicate numbers,
 *   unknown colours, empty geometry or symbols, missing scale or CRS);
 * - `substitution`: a font was replaced;
 * - `outcome`: a matching, colour-stack, decision or CRT result, not a conversion problem;
 * - `reader`: noise from the file reader (its texts are in `readerWarnings`).
 */
export type WarningClass = "unsupported" | "by-design" | "source-error" | "substitution" | "outcome" | "reader";

/** Every warning code the importers, the matcher and the CRT parser emit, classified. */
export const WARNING_CLASS: Readonly<Record<string, WarningClass>> = {
  SYMBOL_TYPE_UNSUPPORTED: "unsupported",
  SYMBOL_FEATURE_DROPPED: "unsupported",
  UNKNOWN_OBJECT_TYPE: "unsupported",
  IRREGULAR_PATTERN_REGULARISED: "unsupported",
  TEXT_BOX_DROPPED: "unsupported",
  COLOUR_OPACITY_IGNORED: "unsupported",
  TEMPLATES_DROPPED: "by-design",
  LAYOUT_OBJECTS_DROPPED: "by-design",
  OBJECT_TAGS_DROPPED: "by-design",
  PARTS_MERGED: "by-design",
  HELPER_SYMBOLS_HIDDEN: "by-design",
  RECTANGLE_GRID_DROPPED: "by-design",
  SYMBOL_REFERENCE_INVALID: "source-error",
  MISSING_SYMBOL: "source-error",
  DUPLICATE_SYMBOL_NUMBER: "source-error",
  SYMBOL_COLOUR_UNKNOWN: "source-error",
  SYMBOL_EMPTY: "source-error",
  EMPTY_GEOMETRY_DROPPED: "source-error",
  EMPTY_TEXT_DROPPED: "source-error",
  MAP_SCALE_MISSING: "source-error",
  CRS_UNRESOLVED: "source-error",
  FONT_SUBSTITUTED: "substitution",
  SYMBOL_UNMATCHED: "outcome",
  SYMBOL_SCALE_ANOMALY: "outcome",
  DECISION_UNKNOWN_ENTRY: "outcome",
  COLOUR_ORDER_CONFLICT: "outcome",
  COLOUR_UNCLASSIFIED: "outcome",
  CRT_LINE_INVALID: "outcome",
  CRT_QUERY_UNSUPPORTED: "outcome",
  CRT_LIBRARY_MISMATCH: "outcome",
  CRT_FINGERPRINT_MISMATCH: "outcome",
  CRT_SOURCE_UNKNOWN: "outcome",
  CRT_SOURCE_NOT_REVIEWABLE: "outcome",
  CRT_TARGET_UNKNOWN: "outcome",
  READER_WARNING: "reader",
};

/** The S0 gate's test: does this code mean a source construct could not be represented? */
export function isUnsupportedPrimitive(code: string): boolean {
  return WARNING_CLASS[code] === "unsupported";
}

const latLngSchema = z.object({ lat: z.number(), lng: z.number() });

export const importReportSchema = z.object({
  importer: z.string(),
  source: z.object({
    kind: z.enum(["ocad", "omap"]),
    version: z.string(),
    fileName: z.string(),
    bytes: z.number().int().min(0),
    fileHash: z.string().regex(/^[0-9a-f]{64}$/),
  }),
  counts: z.object({
    objects: z.number().int().min(0),
    coordinates: z.number().int().min(0),
    symbols: z.number().int().min(0),
    symbolsRendered: z.number().int().min(0),
    symbolsUnrendered: z.number().int().min(0),
    colours: z.number().int().min(0),
    texts: z.number().int().min(0),
    graphicObjects: z.number().int().min(0),
    missingSymbolObjects: z.number().int().min(0),
  }),
  warnings: z.array(importWarningSchema),
  /**
   * OCAD only (docs/map-import.md §3.6): the reader's own warning texts behind
   * `READER_WARNING`, in reader order, at most 50. Absent when there are none
   * and in reports from before `ocad-7`.
   */
  readerWarnings: z.array(z.string()).optional(),
  /**
   * Both sources (docs/map-import.md §3.6): one entry per warning emission that carries a message, in
   * emission order, at most `WARNING_DETAILS_MAX`. `warnings` keeps the header's form (first message per
   * code, a count); this is the per-symbol detail behind it. Absent when empty and in reports from
   * before `ocad-10` / `omap-4`. Not part of the document identity.
   */
  warningDetails: z.array(importWarningDetailSchema).optional(),
  /** Stage 6 (03 §6.5); absent for documents imported before the matcher. */
  matching: z
    .object({
      library: z.object({ id: z.string(), version: z.string() }),
      edition: z.enum(["iof2022", "iof2024"]),
      thresholds: z.object({ auto: z.number(), suggest: z.number(), strict: z.number() }),
      factor: z.object({
        factor: z.number(),
        scaleFactor: z.number(),
        symbolScale: z.number(),
        method: z.enum(["lines", "codes", "scale", "override"]),
        samples: z.array(z.object({ code: z.string(), ratio: z.number() })),
        rawMedian: z.number().nullable(),
      }),
      symbols: z.object({ auto: z.number().int(), suggested: z.number().int(), unmatched: z.number().int(), variant: z.number().int(), reviewed: z.number().int() }),
      objects: z.object({ auto: z.number().int(), suggested: z.number().int(), unmatched: z.number().int(), variant: z.number().int() }),
      byMethod: z.record(z.string(), z.number().int()),
      scaleAnomalies: z.array(z.object({ code: z.string(), name: z.string(), factor: z.number(), canonicalId: z.string() })),
    })
    .optional(),
  /** Stage 7 (03 §6.3). */
  colourStack: z
    .object({
      source: z.number().int(),
      inserted: z.array(z.string()),
      aliased: z.array(z.object({ paletteId: z.string(), viaPaletteId: z.string(), sourceNumber: z.number().int().optional() })),
      conflicts: z.array(z.object({ colour: z.string(), reason: z.string() })),
      unclassified: z.array(z.object({ sourceNumber: z.number().int().optional(), name: z.string() })),
    })
    .optional(),
  /** Stage 5 (docs/map-import.md §3.8): the header's georeference projected to WGS 84. Absent before `ocad-5` / `omap-2`. */
  georeference: z
    .object({
      crs: z.string().nullable(),
      method: z.enum(["epsg", "none"]),
      projectable: z.boolean(),
      gridRotationDeg: z.number(),
      gridConvergenceDeg: z.number().nullable(),
      originWgs84: latLngSchema.nullable(),
      wgs84Bounds: z.object({ north: z.number(), south: z.number(), east: z.number(), west: z.number() }).nullable(),
    })
    .optional(),
  /**
   * Stage 5 north lines plus the WMM view at `asOf` (06 §4.4: the legacy
   * `NorthDetection`, with the meridian keyed by symbol index and code).
   * Not part of the document identity: `declinationDeg`,
   * `meridianStalenessDeg` and `asOf` depend on the import date.
   */
  north: z
    .object({
      meridian: z.object({ symbolIdx: z.number().int(), code: z.string(), count: z.number().int(), medianTiltDeg: z.number(), stddevDeg: z.number() }).nullable(),
      paperNorthBearingDeg: z.number().nullable(),
      displayNorthOffsetDeg: z.number().nullable(),
      declaredGrivationDeg: z.number(),
      trueNorthFromGridDeg: z.number().nullable(),
      centerLat: z.number().nullable(),
      centerLng: z.number().nullable(),
      declinationDeg: z.number().nullable(),
      meridianStalenessDeg: z.number().nullable(),
      asOf: z.string(),
    })
    .optional(),
  /** Milliseconds per stage. */
  timings: z.record(z.string(), z.number()),
});

export type ImportReport = z.infer<typeof importReportSchema>;
export type ImportWarning = z.infer<typeof importWarningSchema>;
export type ImportWarningDetail = z.infer<typeof importWarningDetailSchema>;
