/**
 * Import report (docs/map-import.md §5): what stages 3–8 did to a file,
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
  /** Milliseconds per stage. */
  timings: z.record(z.string(), z.number()),
});

export type ImportReport = z.infer<typeof importReportSchema>;
export type ImportWarning = z.infer<typeof importWarningSchema>;
