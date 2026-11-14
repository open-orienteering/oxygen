/**
 * The height field (docs/map-terrain.md §5.1): a paper-space int16 raster.
 */

import { z } from "zod";

/** Bumped whenever §1–5 change the field a document derives; H4 keys the stored artifact on it. */
export const TERRAIN_VERSION = 1;

/** The int16 value of a cell outside the mapped area. */
export const HEIGHT_NO_DATA = -32768;

/** Height units per contour interval (§4.0 answer 1). */
export const Z_PER_INTERVAL = 64;

/**
 * A DEM-based field's `source` (§7.0 answer 3): `ground.<provider>` is the
 * DEM resampled onto the field grid, `contours.<provider>` the contours
 * re-derived with the DEM's per-chain heights (§4.9). `<provider>` is the
 * provider id and its resolution, e.g. `lantmateriet-2m`.
 */
export const DEM_FIELD_SOURCE_RE = /^(ground|contours)\.[a-z0-9][a-z0-9-]{0,47}$/;

/** Where a DEM-based field's heights come from (§7.1); travels with the bytes, as CC BY asks (answer 16). */
export const heightFieldProviderSchema = z.object({
  /** Provider and resolution, e.g. `lantmateriet-2m`. */
  id: z.string().min(1).max(48),
  /** Ground cell of the model read, metres. */
  resolutionM: z.number().positive(),
  /** §6.0 answer 1. */
  grade: z.enum(["anchor", "coarse"]),
  /** e.g. `CC BY 4.0`. */
  licence: z.string().min(1).max(200),
  /** The notice shown with the field, e.g. `© Lantmäteriet`. */
  attribution: z.string().min(1).max(400),
  /** The model's vertical datum, e.g. `RH 2000`, `EGM2008`. */
  verticalDatum: z.string().min(1).max(40),
});
export type HeightFieldProvider = z.output<typeof heightFieldProviderSchema>;

export const heightFieldHeaderSchema = z.object({
  /** `TERRAIN_VERSION` of the code that derived the field. */
  version: z.number().int().min(1),
  /** What the heights come from: `contours` (§5.5), or a DEM source (`DEM_FIELD_SOURCE_RE`, §7). */
  source: z.union([z.literal("contours"), z.string().regex(DEM_FIELD_SOURCE_RE)]),
  /** Cell edge, paper mm; the grid's lower-left corner `(x0, y0)`; y up, row-major from the lower-left (§2's `Grid`). */
  cellMm: z.number().positive(),
  x0: z.number(),
  y0: z.number(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  /** Ground metres per paper mm (`mapScale / 1000`). */
  groundMPerMm: z.number().positive(),
  /** The contour interval the heights count in, metres. */
  intervalM: z.number().positive(),
  /** Metres per height unit: `intervalM / Z_PER_INTERVAL`. */
  zScaleM: z.number().positive(),
  /** metres = z · zScaleM + zOffsetM. */
  zOffsetM: z.number(),
  /** `relative`: 0 is the lowest region of each connected set (§4.8); `absolute`: metres above the DEM's datum (§4.9). */
  datum: z.enum(["relative", "absolute"]),
  /** Smallest and largest value over data cells; both 0 when no cell has data. */
  zMin: z.number().int().min(-32767).max(32767),
  zMax: z.number().int().min(-32767).max(32767),
  /** A DEM-based field's provider (§7.1); absent on `contours`. */
  provider: heightFieldProviderSchema.optional(),
});
export type HeightFieldHeader = z.output<typeof heightFieldHeaderSchema>;

export interface HeightField {
  header: HeightFieldHeader;
  /** `width · height` heights at cell centres; `HEIGHT_NO_DATA` outside the mapped area. */
  z: Int16Array;
  /** `⌈width · height / 8⌉` bytes: bit `i % 8` of byte `i >> 3` is cell i's confidence (§4.7), least significant bit first. */
  confident: Uint8Array;
}

/** Bytes of the bit-packed confidence plane for `cells` cells. */
export const confidenceBytes = (cells: number): number => (cells + 7) >> 3;

/** Cell i's confidence bit. */
export const isConfident = (f: Pick<HeightField, "confident">, i: number): boolean => ((f.confident[i >> 3] >> (i & 7)) & 1) === 1;
