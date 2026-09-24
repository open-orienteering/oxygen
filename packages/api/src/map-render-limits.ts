/**
 * Resource limits for the windowed map-tile renderer (see map-tiles.ts).
 *
 * Peak memory per render is roughly
 *
 *   4 bytes x (blockTiles x 256 x supersample x rotationSlack)^2
 *
 * doubled while the rasteriser hands its pixels over, doubled again
 * because one permit rasterises the composite and the ink layer side by
 * side, times `renderConcurrency`. The defaults put that near 600 MB,
 * which leaves plenty of headroom in a 4 GiB container — unlike the
 * whole-map raster this replaced, which needed gigabytes for a single
 * large map and had to be starved down to a blurry resolution to fit.
 *
 * `supersample` is why deep zoom looks crisp: the window is rendered
 * denser than the tiles that come out of it, so the sampler in
 * map-tiles.ts always reads from a source finer than its output.
 */

import { PRECACHE_MAX_ZOOM, PRECACHE_MIN_ZOOM } from "./map-window.js";

export const DEFAULTS = {
  /** Tiles per side in one render window. Amortizes the ~70 ms SVG parse. */
  blockTiles: 4,
  /** Window density relative to the tiles' own resolution. */
  supersample: 2,
  /** Backstop against a pathological projection blowing up a window. */
  windowMaxPixels: 64_000_000,
  /** Concurrent block renders per process (each rasterises composite + ink). */
  renderConcurrency: 2,
  /**
   * Foreground blocks allowed to wait for a permit before further tile
   * requests are refused with 503 + Retry-After. A cold block costs
   * roughly 10–15 s on a 2 vCPU Cloud Run instance, so four waiters keep
   * the worst case near a minute — far inside the platform's 300 s cap,
   * which is where unbounded queueing ended up in September 2026.
   */
  renderMaxQueue: 4,
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

export function renderMaxQueue(): number {
  return intSetting(
    process.env.MAP_RENDER_MAX_QUEUE,
    DEFAULTS.renderMaxQueue,
    0,
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

export function precacheMinZoom(): number {
  return intSetting(process.env.MAP_PRECACHE_MIN_ZOOM, PRECACHE_MIN_ZOOM, 0);
}

export function precacheMaxZoom(): number {
  return Math.max(
    precacheMinZoom(),
    intSetting(process.env.MAP_PRECACHE_MAX_ZOOM, PRECACHE_MAX_ZOOM, 0),
  );
}

/**
 * Pause between pre-cache blocks. The pre-cache is background work and
 * must not crowd out the requests it is meant to speed up: without a
 * gap it renders blocks back to back, and on a busy host that shows up
 * as latency everywhere else.
 */
export function precacheBlockDelayMs(): number {
  return intSetting(process.env.MAP_PRECACHE_BLOCK_DELAY_MS, 50, 0);
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

/**
 * Thrown by `Semaphore.run` when a bounded foreground task finds the
 * queue already full. Callers turn it into a fast 503 + Retry-After so
 * the client backs off instead of the request sitting in the platform's
 * admission queue until it is killed.
 */
export class RenderBusyError extends Error {
  constructor(readonly waiting: number) {
    super(`render queue full (${waiting} waiting)`);
    this.name = "RenderBusyError";
  }
}

/**
 * Counting semaphore bounding concurrent renders, with two priorities.
 *
 * Background work (the pre-cache) must never make a user wait longer than
 * the one block already in flight, so foreground waiters are always served
 * first. Without this a pre-cache sweep can hold every permit and a tile
 * request queues behind the entire sweep.
 *
 * Foreground tasks may also pass `maxQueue`: if that many foreground
 * tasks are already waiting, the call fails immediately with
 * `RenderBusyError` rather than joining the line. Background tasks are
 * never refused — they are polite by construction and nothing is waiting
 * on them.
 */
export class Semaphore {
  private available: number;
  private readonly foreground: Array<() => void> = [];
  private readonly background: Array<() => void> = [];

  constructor(limit: number) {
    this.available = Math.max(1, limit);
  }

  /** Foreground tasks currently waiting for a permit. */
  get foregroundWaiting(): number {
    return this.foreground.length;
  }

  async run<T>(
    task: () => Promise<T>,
    opts: { background?: boolean; maxQueue?: number } = {},
  ): Promise<T> {
    await this.acquire(opts.background === true, opts.maxQueue);
    try {
      return await task();
    } finally {
      this.release();
    }
  }

  private async acquire(
    isBackground: boolean,
    maxQueue: number | undefined,
  ): Promise<void> {
    if (this.available > 0) {
      this.available--;
      return;
    }
    if (
      !isBackground &&
      maxQueue !== undefined &&
      this.foreground.length >= maxQueue
    ) {
      throw new RenderBusyError(this.foreground.length);
    }
    const queue = isBackground ? this.background : this.foreground;
    await new Promise<void>((resolve) => queue.push(resolve));
  }

  private release(): void {
    const next = this.foreground.shift() ?? this.background.shift();
    if (next) {
      next();
      return;
    }
    this.available++;
  }
}
