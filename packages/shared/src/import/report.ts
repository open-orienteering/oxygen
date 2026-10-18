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
  /** Milliseconds per stage. */
  timings: z.record(z.string(), z.number()),
});

export type ImportReport = z.infer<typeof importReportSchema>;
export type ImportWarning = z.infer<typeof importWarningSchema>;
