import { describe, expect, it, vi } from "vitest";
import { scopeTrpcUrl, trpcClientForEvent } from "../lib/trpc";

describe("scopeTrpcUrl", () => {
  it("separates service-worker cache URLs by event", () => {
    const request = "/trpc/course.mapMetadata?batch=1";

    expect(scopeTrpcUrl(request, "event-a")).toBe(
      "/trpc/course.mapMetadata?batch=1&event=event-a",
    );
    expect(scopeTrpcUrl(request, "event-b")).not.toBe(
      scopeTrpcUrl(request, "event-a"),
    );
  });

  it("leaves non-event requests unchanged", () => {
    expect(scopeTrpcUrl("/trpc/competition.list?batch=1", null)).toBe(
      "/trpc/competition.list?batch=1",
    );
  });
});

describe("trpcClientForEvent", () => {
  it("sends the header and ?event= of its own event, whatever the URL says", async () => {
    vi.stubGlobal("window", { location: { pathname: "/b/race" } });
    const seen: Array<{ url: string; header: string | null }> = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push({
        url: `http://x${String(input)}`,
        header: new Headers(init?.headers).get("x-competition-id"),
      });
      return new Response(
        JSON.stringify({ result: { data: { synced: [], failed: [] } } }),
        { headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;
    try {
      await trpcClientForEvent("a").events.push.mutate({ events: [] });
    } finally {
      globalThis.fetch = realFetch;
      vi.unstubAllGlobals();
    }
    expect(seen).toHaveLength(1);
    expect(seen[0].header).toBe("a");
    expect(new URL(seen[0].url).searchParams.get("event")).toBe("a");
  });

  it("caches one client per event", () => {
    expect(trpcClientForEvent("a")).toBe(trpcClientForEvent("a"));
    expect(trpcClientForEvent("a")).not.toBe(trpcClientForEvent("b"));
  });
});
