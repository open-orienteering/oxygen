/**
 * Memory limits for the OCAD map rasterizer (see map-tiles.ts).
 *
 * The full-map bitmap is RGBA, so a budget of N pixels costs 4·N bytes —
 * and during rendering the peak is roughly double that, because resvg
 * holds its own copy of the pixels before we buffer them. The historical
 * 800M-pixel budget (3.2 GB bitmap, ~6.5 GB peak) is fine on a dev
 * machine but OOM-kills a 4 GiB Cloud Run container, so deployments with
 * a hard memory cap set MAP_RASTER_MAX_PIXELS to fit:
 *
 *   peak ≈ 2 × 4 bytes × MAP_RASTER_MAX_PIXELS  (+ ~500 MB Node baseline)
 *
 * e.g. 200_000_000 → ~1.6 GB peak, comfortable inside 4 GiB.
 *
 * MAP_RASTER_CACHE_EVENTS bounds how many rendered event bitmaps stay
 * resident: each cached bitmap is up to 4·budget bytes, so an unbounded
 * cache OOMs a container as soon as a few events' maps get viewed.
 */

export const DEFAULT_RASTER_PIXEL_BUDGET = 800_000_000;
const MIN_RASTER_PIXEL_BUDGET = 1_000_000;
const DEFAULT_RASTER_CACHE_EVENTS = 4;

export function rasterPixelBudget(
  raw: string | undefined = process.env.MAP_RASTER_MAX_PIXELS,
): number {
  if (!raw) return DEFAULT_RASTER_PIXEL_BUDGET;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < MIN_RASTER_PIXEL_BUDGET) {
    return DEFAULT_RASTER_PIXEL_BUDGET;
  }
  return Math.floor(parsed);
}

/**
 * Pixels-per-OCAD-unit for the full-map raster: the ideal 1 px/unit when
 * that fits the budget, otherwise scaled down so width·height lands
 * exactly on the budget.
 */
export function rasterPxPerUnit(
  ocadW: number,
  ocadH: number,
  maxPixels: number,
  idealPxPerUnit = 1,
): number {
  const idealPixels = ocadW * idealPxPerUnit * (ocadH * idealPxPerUnit);
  return idealPixels > maxPixels
    ? Math.sqrt(maxPixels / (ocadW * ocadH))
    : idealPxPerUnit;
}

export function rasterCacheCap(
  raw: string | undefined = process.env.MAP_RASTER_CACHE_EVENTS,
): number {
  if (!raw) return DEFAULT_RASTER_CACHE_EVENTS;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) return DEFAULT_RASTER_CACHE_EVENTS;
  return parsed;
}

/**
 * Make room in an insertion-ordered cache so one more entry fits within
 * `cap`. Evicting *before* the render starts (rather than after) matters:
 * it keeps the old bitmap from coexisting with the new render's peak.
 */
export function evictForInsert<V>(cache: Map<bigint, V>, cap: number): void {
  while (cache.size >= cap) {
    const oldest = cache.keys().next();
    if (oldest.done) return;
    cache.delete(oldest.value);
  }
}
