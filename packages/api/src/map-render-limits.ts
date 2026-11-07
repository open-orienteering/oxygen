/**
 * The process's render gate and the integer-setting helper the print
 * worker pool shares (docs/course-print.md §8.2).
 *
 * The windowed tile renderer these limits were written for went in E4a
 * with its knobs (block size, supersampling, queue cap, pre-cache); what
 * is left bounds the rasterisation `maps.pdf` does per print, which the
 * tiles and the layout-editor preview used to share.
 */

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

/** Concurrent renders per process (`MAP_RENDER_CONCURRENCY`, default 2). */
export function renderConcurrency(): number {
  return intSetting(process.env.MAP_RENDER_CONCURRENCY, 2, 1);
}

/**
 * Counting semaphore: at most `limit` tasks run at once, the rest wait
 * in arrival order. Waiting is unbounded — a print is a browser
 * download, where a 503 would arrive as a broken file.
 */
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

let processGate: Semaphore | null = null;

/**
 * The one render semaphore for the process: every `maps.pdf` takes a
 * permit after its print-worker slot (docs/course-print.md §8.2), so
 * prints never exceed `MAP_RENDER_CONCURRENCY` at once.
 */
export function renderGate(): Semaphore {
  processGate ??= new Semaphore(renderConcurrency());
  return processGate;
}
