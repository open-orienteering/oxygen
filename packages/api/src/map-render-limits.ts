/**
 * Resource limits for the windowed map-tile renderer (see map-tiles.ts).
 *
 * Peak memory per render is roughly
 *
 *   4 bytes x (blockTiles x 256 x supersample x rotationSlack)^2
 *
 * doubled while the rasteriser hands its pixels over, times
 * `renderConcurrency`. The defaults put that near 300 MB, which leaves
 * plenty of headroom in a 4 GiB container — unlike the whole-map raster
 * this replaced, which needed gigabytes for a single large map and had to
 * be starved down to a blurry resolution to fit.
 *
 * `supersample` is why deep zoom looks crisp: the window is rendered
 * denser than the tiles that come out of it, so the sampler in
 * map-tiles.ts always reads from a source finer than its output.
 */

export const DEFAULTS = {
  /** Tiles per side in one render window. Amortizes the ~70 ms SVG parse. */
  blockTiles: 4,
  /** Window density relative to the tiles' own resolution. */
  supersample: 2,
  /** Backstop against a pathological projection blowing up a window. */
  windowMaxPixels: 64_000_000,
  /** Concurrent window renders per process. */
  renderConcurrency: 2,
  /** Parsed map SVGs kept in memory (a few MB each). */
  svgCacheEvents: 4,
} as const;

export function intSetting(
  raw: string | undefined,
  fallback: number,
  min: number,
): number {
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < min) return fallback;
  return parsed;
}

export function blockTiles(): number {
  return intSetting(process.env.MAP_TILE_BLOCK_TILES, DEFAULTS.blockTiles, 1);
}

export function supersample(): number {
  return intSetting(process.env.MAP_TILE_SUPERSAMPLE, DEFAULTS.supersample, 1);
}

export function windowMaxPixels(): number {
  return intSetting(
    process.env.MAP_WINDOW_MAX_PIXELS,
    DEFAULTS.windowMaxPixels,
    1_000_000,
  );
}

export function renderConcurrency(): number {
  return intSetting(
    process.env.MAP_RENDER_CONCURRENCY,
    DEFAULTS.renderConcurrency,
    1,
  );
}

export function svgCacheEvents(): number {
  return intSetting(
    process.env.MAP_SVG_CACHE_EVENTS,
    DEFAULTS.svgCacheEvents,
    1,
  );
}

/**
 * Whether a first tile request kicks off background pre-rendering of the
 * overview zooms. On by default: it makes panning and zooming out instant
 * for the next viewer. Worth turning off where background CPU is not free
 * (a scale-to-zero container only gets CPU while a request is in flight,
 * so a large pre-cache competes with the requests that keep it awake).
 */
export function precacheEnabled(): boolean {
  return (process.env.MAP_TILE_PRECACHE ?? "on").trim().toLowerCase() !== "off";
}

/**
 * Make room in an insertion-ordered cache so one more entry fits within
 * `cap`. Evicting before the work starts (rather than after) keeps the
 * outgoing entry from coexisting with the incoming one's allocation peak.
 */
export function evictForInsert<K, V>(cache: Map<K, V>, cap: number): void {
  while (cache.size >= cap) {
    const oldest = cache.keys().next();
    if (oldest.done) return;
    cache.delete(oldest.value);
  }
}

/** Counting semaphore bounding concurrent renders. */
export class Semaphore {
  private available: number;
  private readonly waiting: Array<() => void> = [];

  constructor(limit: number) {
    this.available = Math.max(1, limit);
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await task();
    } finally {
      this.release();
    }
  }

  private async acquire(): Promise<void> {
    if (this.available > 0) {
      this.available--;
      return;
    }
    await new Promise<void>((resolve) => this.waiting.push(resolve));
  }

  private release(): void {
    const next = this.waiting.shift();
    if (next) {
      next();
      return;
    }
    this.available++;
  }
}
