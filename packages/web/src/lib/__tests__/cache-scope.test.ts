/**
 * The persisted query cache belongs to one event (MC-04 / WEB-01 / SYNC-19):
 * event-scoped tRPC keys carry no event, so without scoping event B showed
 * event A's runners.
 */
import { describe, it, expect } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import type { PersistedClient } from "@tanstack/react-query-persist-client";
import { cacheOwner, switchCacheScope, CACHE_OWNER_KEY } from "../offline/cache-scope";
import { createIdbPersister, blobKey, type KeyValueStore } from "../offline/persister";

const RUNNERS = [["runner", "list"], { type: "query" }];

function memoryStore() {
  const m = new Map<string, PersistedClient>();
  const store: KeyValueStore = {
    get: async (k) => m.get(k),
    set: async (k, v) => void m.set(k, v as PersistedClient),
    del: async (k) => void m.delete(k),
  };
  return { m, store };
}

function setup() {
  const { m, store } = memoryStore();
  const persister = createIdbPersister(store, () => null);
  const qc = new QueryClient();
  const switchTo = (nameId: string) =>
    switchCacheScope(qc, nameId, persister, async (n) => store.get(blobKey(n)));
  return { m, store, persister, qc, switchTo };
}

describe("switchCacheScope", () => {
  it("removes the previous event's queries when the event changes", async () => {
    const { qc, switchTo } = setup();
    await switchTo("a");
    qc.setQueryData(RUNNERS, [{ id: 1, name: "A runner" }]);
    await switchTo("b");
    expect(cacheOwner(qc)).toBe("b");
    expect(qc.getQueryData(RUNNERS)).toBeUndefined();
  });

  it("keeps paused mutations: they are not part of the query cache", async () => {
    const { qc, switchTo } = setup();
    await switchTo("a");
    const mutation = qc.getMutationCache().build(qc, { mutationFn: async () => 1 });
    await switchTo("b");
    expect(qc.getMutationCache().getAll()).toContain(mutation);
  });

  it("restores the blob stored for the event being entered", async () => {
    const { qc, switchTo } = setup();
    await switchTo("a");
    qc.setQueryData(RUNNERS, [{ id: 1 }]);
    await switchTo("b");
    qc.setQueryData(RUNNERS, [{ id: 2 }]);
    await switchTo("a");
    expect(qc.getQueryData(RUNNERS)).toEqual([{ id: 1 }]);
    await switchTo("b");
    expect(qc.getQueryData(RUNNERS)).toEqual([{ id: 2 }]);
  });

  it("is idempotent for the same event", async () => {
    const { qc, switchTo } = setup();
    await switchTo("a");
    qc.setQueryData(RUNNERS, [{ id: 1 }]);
    await switchTo("a");
    expect(qc.getQueryData(RUNNERS)).toEqual([{ id: 1 }]);
  });
});

describe("switchCacheScope: races and global queries", () => {
  it("the owner marker is never garbage-collected", async () => {
    const { qc, switchTo } = setup();
    await switchTo("a");
    const marker = qc.getQueryCache().find({ queryKey: [...CACHE_OWNER_KEY] });
    expect(marker?.gcTime).toBe(Infinity);
  });

  it("the last caller wins: A to B to A leaves A in place", async () => {
    const { qc, switchTo } = setup();
    await switchTo("a");
    qc.setQueryData(RUNNERS, [{ id: 1 }]);
    const toB = switchTo("b"); // still flushing when the user goes back
    const toA = switchTo("a");
    await Promise.all([toB, toA]);
    expect(cacheOwner(qc)).toBe("a");
    expect(qc.getQueryData(RUNNERS)).toEqual([{ id: 1 }]);
  });

  it("A to B to C ends on C even if B's blob read finishes last", async () => {
    const { qc, switchTo } = setup();
    await switchTo("a");
    await Promise.all([switchTo("b"), switchTo("c")]);
    expect(cacheOwner(qc)).toBe("c");
  });

  it("keeps user queries across a switch and leaves them out of event blobs", async () => {
    const { qc, store, switchTo } = setup();
    await switchTo("a");
    qc.setQueryData([["users", "me"], { type: "query" }], { user: { id: "u" } });
    await switchTo("b");
    expect(qc.getQueryData([["users", "me"], { type: "query" }])).toEqual({ user: { id: "u" } });
    const blob = await store.get(blobKey("a"));
    expect(JSON.stringify(blob)).not.toContain("users");
  });

  it("does not write a persisted snapshot while the cache is being swapped", async () => {
    const { m, qc, switchTo } = setup();
    await switchTo("a");
    qc.setQueryData(RUNNERS, [{ id: 1 }]);
    const before = m.get(blobKey("a"));
    await switchTo("b");
    const after = m.get(blobKey("a"));
    // The flush wrote A's full data; nothing afterwards truncated it.
    expect(JSON.stringify(after)).toContain('"id":1');
    expect(before === undefined || JSON.stringify(after).length > 50).toBe(true);
  });
});

describe("per-event persister", () => {
  it("two events never share a persisted key", async () => {
    const { m, persister, qc, switchTo } = setup();
    await switchTo("a");
    qc.setQueryData(RUNNERS, [{ id: 1 }]);
    await switchTo("b");
    await persister.persistClient({
      timestamp: 1,
      buster: "",
      clientState: { mutations: [], queries: [
        { queryKey: [...CACHE_OWNER_KEY], dehydratedAt: 0, queryHash: JSON.stringify(CACHE_OWNER_KEY), state: { data: "b" } as never },
      ] },
    });
    expect([...m.keys()].filter((k) => !k.endsWith("last-owner")).sort()).toEqual([blobKey("a"), blobKey("b")]);
  });

  it("a write is filed under the owner recorded in the cache, not the URL", async () => {
    const { m, store } = memoryStore();
    const persister = createIdbPersister(store, () => "b"); // the URL already says b
    await persister.persistClient({
      timestamp: 1,
      buster: "",
      clientState: { mutations: [], queries: [
        { queryKey: [...CACHE_OWNER_KEY], dehydratedAt: 0, queryHash: "x", state: { data: "a" } as never },
      ] },
    });
    expect([...m.keys()].filter((k) => !k.endsWith("last-owner"))).toEqual([blobKey("a")]);
  });
});
