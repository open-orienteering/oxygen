/**
 * Concurrency-capped tile fetch queue.
 *
 * Replaces bare `<img src>` loads so we can:
 * - cap in-flight requests and stop Cloud Run 429 storms,
 * - abort fetches that scroll out of view,
 * - read HTTP status (429 / Retry-After) for the retry book.
 */

/**
 * Cached tiles are a cheap DB read, and uncached ones queue behind the
 * server's own render semaphore no matter how many the client asks for,
 * so the cap exists to bound connection pressure rather than render
 * load. Twelve keeps a viewport-sized burst moving without approaching
 * the browser's own per-host HTTP/1.1 ceiling.
 */
export const DEFAULT_TILE_FETCH_CONCURRENCY = 12;

export type TileFetchRequest = {
  key: string;
  url: string;
  /** Lower = higher priority (distance to viewport center). */
  priority: number;
};

export type TileFetchResult =
  | { ok: true; blob: Blob }
  | {
      ok: false;
      status: number | null;
      retryAfter: string | null;
      aborted: boolean;
    };

type Queued = TileFetchRequest & {
  controller: AbortController;
  resolve: (result: TileFetchResult) => void;
};

export class TileFetcher {
  private readonly concurrency: number;
  private readonly fetchImpl: typeof fetch;
  private readonly queue: Queued[] = [];
  private readonly inFlight = new Map<string, Queued>();
  private readonly pending = new Map<string, Promise<TileFetchResult>>();
  private active = 0;

  constructor(
    opts: {
      concurrency?: number;
      fetchImpl?: typeof fetch;
    } = {},
  ) {
    this.concurrency = opts.concurrency ?? DEFAULT_TILE_FETCH_CONCURRENCY;
    this.fetchImpl = opts.fetchImpl ?? fetch.bind(globalThis);
  }

  /** Number of queued + in-flight requests (for tests). */
  get pendingCount(): number {
    return this.queue.length + this.inFlight.size;
  }

  /**
   * Enqueue (or re-priority) a tile fetch. Calling again with the same
   * key while pending returns the same promise.
   */
  enqueue(req: TileFetchRequest): Promise<TileFetchResult> {
    const existingPromise = this.pending.get(req.key);
    if (existingPromise) {
      const job =
        this.inFlight.get(req.key) ?? this.queue.find((q) => q.key === req.key);
      if (job && req.priority < job.priority) {
        job.priority = req.priority;
        this.queue.sort((a, b) => a.priority - b.priority);
      }
      return existingPromise;
    }

    let resolve!: (result: TileFetchResult) => void;
    const promise = new Promise<TileFetchResult>((r) => {
      resolve = r;
    });
    this.pending.set(req.key, promise);

    const controller = new AbortController();
    this.queue.push({ ...req, controller, resolve });
    this.queue.sort((a, b) => a.priority - b.priority);
    this.pump();
    return promise;
  }

  /** Cancel a queued or in-flight fetch (tile scrolled out of view). */
  cancel(key: string): void {
    const inflight = this.inFlight.get(key);
    if (inflight) {
      inflight.controller.abort();
      return;
    }
    const idx = this.queue.findIndex((q) => q.key === key);
    if (idx >= 0) {
      const [removed] = this.queue.splice(idx, 1);
      this.pending.delete(key);
      removed!.resolve({
        ok: false,
        status: null,
        retryAfter: null,
        aborted: true,
      });
    }
  }

  /** Cancel every key not in `keep`. */
  cancelExcept(keep: Set<string>): void {
    for (const key of [...this.inFlight.keys()]) {
      if (!keep.has(key)) this.cancel(key);
    }
    for (const q of [...this.queue]) {
      if (!keep.has(q.key)) this.cancel(q.key);
    }
  }

  private pump(): void {
    while (this.active < this.concurrency && this.queue.length > 0) {
      const next = this.queue.shift()!;
      this.active += 1;
      this.inFlight.set(next.key, next);
      void this.run(next);
    }
  }

  private async run(job: Queued): Promise<void> {
    try {
      const res = await this.fetchImpl(job.url, {
        signal: job.controller.signal,
        credentials: "same-origin",
      });
      if (!res.ok) {
        job.resolve({
          ok: false,
          status: res.status,
          retryAfter: res.headers.get("retry-after"),
          aborted: false,
        });
        return;
      }
      const blob = await res.blob();
      job.resolve({ ok: true, blob });
    } catch (err) {
      const aborted =
        (err instanceof DOMException && err.name === "AbortError") ||
        (err instanceof Error && err.name === "AbortError");
      job.resolve({
        ok: false,
        status: null,
        retryAfter: null,
        aborted,
      });
    } finally {
      this.inFlight.delete(job.key);
      this.pending.delete(job.key);
      this.active -= 1;
      this.pump();
    }
  }
}
