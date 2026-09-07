import { describe, expect, it, vi } from "vitest";
import {
  TileRetryBook,
  backoffMsForFailure,
  parseRetryAfterMs,
  nextRetryAtForFailure,
  TILE_RETRY_BACKOFF_MS,
} from "../tile-retry";
import {
  TileFetcher,
  DEFAULT_TILE_FETCH_CONCURRENCY,
} from "../tile-fetcher";

describe("parseRetryAfterMs", () => {
  it("parses delta-seconds", () => {
    expect(parseRetryAfterMs("5", 1_000)).toBe(6_000);
  });

  it("parses HTTP-date", () => {
    const at = Date.parse("Wed, 21 Oct 2015 07:28:00 GMT");
    expect(parseRetryAfterMs("Wed, 21 Oct 2015 07:28:00 GMT", 0)).toBe(at);
  });

  it("returns null for junk", () => {
    expect(parseRetryAfterMs("nope", 0)).toBeNull();
    expect(parseRetryAfterMs(null, 0)).toBeNull();
  });
});

describe("backoffMsForFailure", () => {
  it("follows the schedule and caps at the last step", () => {
    expect(backoffMsForFailure(1)).toBe(TILE_RETRY_BACKOFF_MS[0]);
    expect(backoffMsForFailure(2)).toBe(TILE_RETRY_BACKOFF_MS[1]);
    expect(backoffMsForFailure(3)).toBe(TILE_RETRY_BACKOFF_MS[2]);
    expect(backoffMsForFailure(4)).toBe(TILE_RETRY_BACKOFF_MS[3]);
    expect(backoffMsForFailure(99)).toBe(TILE_RETRY_BACKOFF_MS[3]);
  });
});

describe("TileRetryBook", () => {
  it("is ready until a failure is recorded", () => {
    const book = new TileRetryBook();
    expect(book.decision("a", 0)).toEqual({ action: "ready" });
    book.recordFailure("a", 1_000);
    expect(book.decision("a", 1_000)).toEqual({
      action: "wait",
      nextRetryAt: 1_000 + TILE_RETRY_BACKOFF_MS[0],
    });
    expect(book.failures("a")).toBe(1);
    expect(book.decision("a", 1_000 + TILE_RETRY_BACKOFF_MS[0])).toEqual({
      action: "ready",
    });
  });

  it("honours Retry-After on 429", () => {
    const book = new TileRetryBook();
    const entry = book.recordFailure("a", 1_000, { retryAfterHeader: "10" });
    expect(entry.nextRetryAt).toBe(11_000);
  });

  it("clears on success", () => {
    const book = new TileRetryBook();
    book.recordFailure("a", 0);
    book.clear("a");
    expect(book.decision("a", 0)).toEqual({ action: "ready" });
    expect(book.failures("a")).toBe(0);
  });

  it("reports earliest retry among waiting keys", () => {
    const book = new TileRetryBook();
    book.recordFailure("a", 0); // +2s
    const b = nextRetryAtForFailure(1, 5_000);
    book.recordFailure("b", 5_000); // +2s from 5s = 7s
    expect(book.earliestRetryAt(["a", "b", "c"], 0)).toBe(
      TILE_RETRY_BACKOFF_MS[0],
    );
    expect(book.earliestRetryAt(["b"], 0)).toBe(b);
  });
});

describe("TileFetcher", () => {
  it("defaults to the shared concurrency cap", async () => {
    let inFlight = 0;
    let peak = 0;
    const fetchImpl = vi.fn(async (url: string) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 10));
      inFlight -= 1;
      return new Response(new Blob([url]), { status: 200 });
    });
    const fetcher = new TileFetcher({
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await Promise.all(
      Array.from({ length: DEFAULT_TILE_FETCH_CONCURRENCY + 5 }, (_, i) =>
        fetcher.enqueue({ key: `t${i}`, url: `/t${i}`, priority: i }),
      ),
    );
    expect(peak).toBe(DEFAULT_TILE_FETCH_CONCURRENCY);
  });

  it("caps concurrency and prefers nearer tiles", async () => {
    let inFlight = 0;
    let peak = 0;
    const order: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      order.push(String(url));
      await new Promise((r) => setTimeout(r, 20));
      inFlight -= 1;
      return new Response(new Blob([url]), { status: 200 });
    });
    const fetcher = new TileFetcher({ concurrency: 2, fetchImpl: fetchImpl as unknown as typeof fetch });
    const results = await Promise.all([
      fetcher.enqueue({ key: "far", url: "/far", priority: 100 }),
      fetcher.enqueue({ key: "near", url: "/near", priority: 1 }),
      fetcher.enqueue({ key: "mid", url: "/mid", priority: 50 }),
    ]);
    expect(peak).toBeLessThanOrEqual(2);
    expect(results.every((r) => r.ok)).toBe(true);
    // After the first (far) starts, nearer tiles should outrank mid in the queue.
    expect(order.indexOf("/near")).toBeLessThan(order.indexOf("/mid"));
  });

  it("surfaces 429 + Retry-After", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response("", {
        status: 429,
        headers: { "Retry-After": "7" },
      }),
    );
    const fetcher = new TileFetcher({
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const result = await fetcher.enqueue({
      key: "t",
      url: "/t",
      priority: 0,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(429);
      expect(result.retryAfter).toBe("7");
      expect(result.aborted).toBe(false);
    }
  });

  it("aborts queued tiles that scroll out", async () => {
    const fetchImpl = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 50));
      return new Response(new Blob(["ok"]), { status: 200 });
    });
    const fetcher = new TileFetcher({
      concurrency: 1,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const a = fetcher.enqueue({ key: "a", url: "/a", priority: 0 });
    const b = fetcher.enqueue({ key: "b", url: "/b", priority: 1 });
    fetcher.cancel("b");
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra.ok).toBe(true);
    expect(rb.ok).toBe(false);
    if (!rb.ok) expect(rb.aborted).toBe(true);
  });
});
