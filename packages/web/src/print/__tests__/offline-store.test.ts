/** The device's print store (docs/course-print.md §8.6 "Offline", G17). */

import { describe, expect, it } from "vitest";
import { fixturePrintJob } from "../../../../shared/src/print/__tests__/print-job-fixture";
import { createOfflinePrintStore, graphicUrl, jobKey, manifestKey, normaliseQuery, type OfflinePrintManifest } from "../offline-store";
import { MemoryCaches } from "./memory-caches";

const manifest = (storedAt: string, queries: string[] = [""]): OfflinePrintManifest => ({
  storedAt,
  documentHash: "a".repeat(64),
  jobVersion: 2,
  queries,
  skipped: [],
  complete: true,
});

describe("offline print store", () => {
  it("normalises a query: parameters sorted by name then value, none → empty", () => {
    expect(normaliseQuery("")).toBe("");
    expect(normaliseQuery("?")).toBe("");
    expect(normaliseQuery("?courses=3&copies=runners")).toBe(normaliseQuery("?copies=runners&courses=3"));
    expect(normaliseQuery("?b=2&a=1")).toBe("?a=1&b=2");
    expect(normaliseQuery("?variants=3:AB")).toBe(normaliseQuery(`?${new URLSearchParams({ variants: "3:AB" })}`));
    expect(jobKey("ev 1", "?maps=4")).toBe("/api/maps/ev%201/print-job?maps=4");
    expect(manifestKey("ev 1")).toBe("/offline-print/ev%201");
    expect(graphicUrl("ev", 7)).toBe("/api/maps/ev/graphics/7/print.png");
    expect(graphicUrl("ev", 8, [120, 80])).toBe("/api/maps/ev/graphics/8/print.png?w=120&h=80");
  });

  it("round-trips a job with its stored time, looked up by any order of the same query", async () => {
    const caches = new MemoryCaches();
    const store = createOfflinePrintStore(() => caches);
    const job = fixturePrintJob();
    await store.putJob("ev", "?courses=3&copies=runners", job, "2026-11-14T10:00:00.000Z");
    const got = await store.getJob("ev", "?copies=runners&courses=3");
    expect(got).toEqual({ job, storedAt: "2026-11-14T10:00:00.000Z" });
    expect(await store.getJob("ev", "?courses=3")).toBeNull();
    expect(await store.getJob("other", "?courses=3&copies=runners")).toBeNull();
  });

  it("stores graphics by their print.png request and the manifest", async () => {
    const caches = new MemoryCaches();
    const store = createOfflinePrintStore(() => caches);
    await store.putGraphic(graphicUrl("ev", 8, [10, 20]), new Uint8Array([1, 2, 3]).buffer);
    expect(new Uint8Array((await store.getGraphic(graphicUrl("ev", 8, [10, 20])))!)).toEqual(new Uint8Array([1, 2, 3]));
    expect(await store.getGraphic(graphicUrl("ev", 8))).toBeNull();
    expect(await store.readManifest("ev")).toBeNull();
    await store.writeManifest("ev", manifest("2026-11-14T10:00:00.000Z"));
    expect(await store.readManifest("ev")).toEqual(manifest("2026-11-14T10:00:00.000Z"));
  });

  it("retain deletes the event's entries outside the new set, and no other event's", async () => {
    const caches = new MemoryCaches();
    const store = createOfflinePrintStore(() => caches);
    const job = fixturePrintJob();
    await store.putJob("ev", "?courses=1", job, "t");
    await store.putJob("ev", "?courses=2", job, "t");
    await store.putGraphic(graphicUrl("ev", 7), new ArrayBuffer(1));
    await store.putJob("ev2", "?courses=2", job, "t");
    await store.writeManifest("ev", manifest("t"));
    await store.retain("ev", new Set([jobKey("ev", "?courses=1"), graphicUrl("ev", 7)]));
    expect(caches.get("offline-print").paths().sort()).toEqual(
      ["/api/maps/ev/graphics/7/print.png", "/api/maps/ev/print-job?courses=1", "/api/maps/ev2/print-job?courses=2", "/offline-print/ev"].sort(),
    );
  });

  it("keeps the events stored most recently and deletes every entry of the others", async () => {
    const caches = new MemoryCaches();
    const store = createOfflinePrintStore(() => caches);
    for (const [i, ev] of ["a", "b", "c"].entries()) {
      await store.putJob(ev, "", fixturePrintJob(), "t");
      await store.writeManifest(ev, manifest(`2026-11-1${i}T00:00:00.000Z`));
    }
    await store.pruneEvents(2);
    expect(await store.readManifest("a")).toBeNull();
    expect(await store.getJob("a", "")).toBeNull();
    expect(await store.readManifest("b")).not.toBeNull();
    expect(await store.getJob("c", "")).not.toBeNull();
  });

  it("holds nothing where Cache Storage is missing: reads are null, writes reject", async () => {
    const store = createOfflinePrintStore(() => null);
    expect(await store.getJob("ev", "")).toBeNull();
    expect(await store.readManifest("ev")).toBeNull();
    await expect(store.putJob("ev", "", fixturePrintJob(), "t")).rejects.toThrow(/Cache Storage/);
    await store.pruneEvents();
  });
});
