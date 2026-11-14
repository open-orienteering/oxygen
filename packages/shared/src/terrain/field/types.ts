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

export const heightFieldHeaderSchema = z.object({
  /** `TERRAIN_VERSION` of the code that derived the field. */
  version: z.number().int().min(1),
  /** What the heights come from; H10 adds DEM sources. */
  source: z.enum(["contours"]),
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
