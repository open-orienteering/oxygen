/** *Make maps available offline* (docs/course-print.md §8.6 "Offline", G17): the store step. */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type PrintJob, resetPreparedDocuments } from "@oxygen/shared/print";
import { FIXTURE_PNG, fixturePrintJob, printDocumentBytes } from "../../../../shared/src/print/__tests__/print-job-fixture";
import { printCost } from "../capability";
import { composeToStore, DEVICE_PRINT_JOB_VERSION, type PrintClientDeps, printMapsPdf, resetPrintClient, type WorkerLike } from "../client";
import type { OfflineQueryInput } from "../../lib/editor/export-menu";
import { boxLearningJobs, OfflinePrepareError, type PrepareDeps, prepareOfflinePrint, resetOfflinePrepare } from "../offline-prepare";
import { createOfflinePrintStore, graphicUrl, jobKey, offlinePrintProgress, subscribeOfflinePrint } from "../offline-store";
import type { PrintFace, PrintWorkerRequest, PrintWorkerResponse } from "../protocol";
import { createPrintWorker } from "../worker";
import { MemoryCaches } from "./memory-caches";

const fontsDir = resolve(import.meta.dirname, "../../../../shared/fonts");
const buf = (file: string): ArrayBuffer => new Uint8Array(readFileSync(resolve(fontsDir, file))).buffer as ArrayBuffer;
const faces = (): PrintFace[] => [
  { family: "liberation-sans", data: buf("LiberationSans-Regular.ttf") },
  { family: "liberation-sans-narrow", data: buf("LiberationSansNarrow-Regular.ttf") },
  { family: "liberation-sans", data: buf("LiberationSans-Bold.ttf") },
];

class InlineWorker implements WorkerLike {
  onmessage: ((e: MessageEvent<PrintWorkerResponse>) => void) | null = null;
  onerror: ((e: ErrorEvent) => void) | null = null;
  private core = createPrintWorker((msg) => queueMicrotask(() => this.onmessage?.({ data: msg } as MessageEvent<PrintWorkerResponse>)));
  postMessage(msg: PrintWorkerRequest): void {
    queueMicrotask(() => this.core.handle(msg));
  }
  terminate(): void {}
}

const LISTS: OfflineQueryInput = {
  nameId: "ev",
  courses: [{ seq: 3, parentSeq: null }],
  variants: new Map(),
  classes: [],
  sheetSeqs: [],
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function setup(over: { lists?: OfflineQueryInput; job?: (query: string) => Response | PrintJob; graphic?: (url: string) => Response | null; network?: boolean; deviceMemory?: number; now?: Date } = {}) {
  const caches = new MemoryCaches();
  const store = createOfflinePrintStore(() => caches);
  const requests: string[] = [];
  let network = over.network ?? true;
  const fetch = vi.fn(async (url: string) => {
    requests.push(url);
    if (!network) throw new TypeError("Failed to fetch");
    if (url.includes("/print-job")) {
      const q = url.slice(url.indexOf("print-job") + "print-job".length);
      const j = over.job ? over.job(q) : fixturePrintJob();
      return j instanceof Response ? j : json(j);
    }
    if (url.includes("/print.png")) {
      const r = over.graphic?.(url);
      if (r === null) throw new TypeError("Failed to fetch");
      return r ?? new Response(FIXTURE_PNG.slice(), { status: 200 });
    }
    return new Response("", { status: 404 });
  });
  const print: PrintClientDeps = {
    env: () => ({ worker: true, deviceMemory: over.deviceMemory ?? 8, coarsePointer: false }),
    online: () => network,
    fetch,
    server: async () => { throw new Error("no server in this test"); },
    document: async () => printDocumentBytes().slice().buffer as ArrayBuffer,
    faces: async () => faces(),
    createWorker: () => new InlineWorker(),
    store,
  };
  const compose = vi.fn(composeToStore);
  const warm = vi.fn(async () => {});
  const deps: PrepareDeps = {
    env: print.env,
    online: () => network,
    now: () => over.now ?? new Date("2026-11-14T10:00:00.000Z"),
    lists: async () => over.lists ?? LISTS,
    fetch,
    store,
    document: vi.fn(async () => undefined),
    faces: vi.fn(async () => undefined),
    print,
    compose,
    warm,
  };
  return { caches, store, deps, print, requests, compose, warm, goOffline: () => (network = false) };
}

afterEach(() => {
  resetPrintClient();
  resetPreparedDocuments();
  resetOfflinePrepare();
});

describe("prepareOfflinePrint (§8.6 \"Offline\")", () => {
  it("stores every query's job, the PNGs once, the SVG boxes by composing once, the document, the faces, then the manifest", async () => {
    const s = setup();
    const r = await prepareOfflinePrint("ev", {}, s.deps);
    expect(r.status).toBe("stored");
    // all, all controls, setter, the course.
    expect(r.manifest).toMatchObject({ storedAt: "2026-11-14T10:00:00.000Z", jobVersion: DEVICE_PRINT_JOB_VERSION, complete: true, skipped: [] });
    expect(r.manifest!.queries.sort()).toEqual(["", "?allControls=1", "?courses=3", "?setter=1"].sort());
    for (const q of r.manifest!.queries) expect((await s.store.getJob("ev", q))?.storedAt).toBe("2026-11-14T10:00:00.000Z");
    const paths = s.caches.get("offline-print").paths();
    expect(paths).toContain(graphicUrl("ev", 7));
    expect(paths.some((p) => /\/graphics\/8\/print\.png\?w=\d+&h=\d+$/.test(p))).toBe(true);
    // The same SVG sheet under four queries is composed once.
    expect(s.compose).toHaveBeenCalledTimes(1);
    expect(s.deps.document).toHaveBeenCalledWith(fixturePrintJob().document.hash, "ev");
    expect(s.deps.faces).toHaveBeenCalled();
    expect(s.warm).not.toHaveBeenCalled();
  });

  it("then the device composes every stored export offline", async () => {
    const s = setup();
    await prepareOfflinePrint("ev", {}, s.deps);
    resetPrintClient();
    resetPreparedDocuments();
    s.goOffline();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const out = await printMapsPdf("ev", "?setter=1", s.print);
    expect(out.storedAt).toBe("2026-11-14T10:00:00.000Z");
    expect(warn.mock.calls.flat().join(" ")).not.toMatch(/IMAGE_MISSING|SVG_RASTER/);
    warn.mockRestore();
  });

  it("an HTTP error is skipped and listed; a job without SVG needs no compose, the worker is warmed instead", async () => {
    const plain = { ...fixturePrintJob(), graphics: fixturePrintJob().graphics.filter((g) => g.mime === "image/png") };
    const s = setup({ job: (q) => (q === "?setter=1" ? new Response("No setter maps found", { status: 400 }) : plain) });
    const r = await prepareOfflinePrint("ev", {}, s.deps);
    expect(r.manifest!.skipped).toEqual([{ query: "?setter=1", status: 400, message: "No setter maps found" }]);
    expect(r.manifest!.queries).not.toContain("?setter=1");
    expect(s.compose).not.toHaveBeenCalled();
    expect(s.warm).toHaveBeenCalledTimes(1);
  });

  it("the network going mid-run leaves a partial manifest and keeps what an earlier run stored", async () => {
    const s = setup();
    await prepareOfflinePrint("ev", {}, s.deps);
    let n = 0;
    const flaky = setup({ job: () => fixturePrintJob() });
    flaky.deps.store = s.store;
    flaky.deps.fetch = async (url) => {
      if (++n > 2) throw new TypeError("Failed to fetch");
      return s.deps.fetch(url);
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = await prepareOfflinePrint("ev", {}, flaky.deps);
    warn.mockRestore();
    expect(r.status).toBe("partial");
    expect(r.manifest!.complete).toBe(false);
    expect(await s.store.getJob("ev", "?courses=3")).not.toBeNull();
    expect(s.caches.get("offline-print").paths()).toContain(graphicUrl("ev", 7));
  });

  it("a graphic the server refuses, or the network dropping during the SVG compose, leaves the run partial and the earlier copy kept", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const s = setup();
    await prepareOfflinePrint("ev", {}, s.deps);
    const svgKey = s.caches.get("offline-print").paths().find((p) => /\/graphics\/8\/print\.png\?w=/.test(p))!;
    // The PNG answered 404.
    const png404 = setup({ graphic: (url) => (url.endsWith("/graphics/7/print.png") ? new Response("gone", { status: 404 }) : undefined as unknown as Response) });
    png404.deps.store = s.store;
    const a = await prepareOfflinePrint("ev", {}, png404.deps);
    expect(a.status).toBe("partial");
    expect(a.manifest!.skipped).toContainEqual({ query: graphicUrl("ev", 7), status: 404, message: "gone" });
    expect(s.caches.get("offline-print").paths()).toContain(graphicUrl("ev", 7));
    // The SVG's box request with no network.
    resetPrintClient();
    resetPreparedDocuments();
    const svgDown = setup({ graphic: (url) => (url.includes("/graphics/8/") ? null : undefined as unknown as Response) });
    svgDown.deps.store = s.store;
    const b = await prepareOfflinePrint("ev", {}, svgDown.deps);
    expect(b.status).toBe("partial");
    expect(b.manifest!.complete).toBe(false);
    expect(s.caches.get("offline-print").paths()).toContain(svgKey);
    warn.mockRestore();
  });

  it("the document going with the network ends the run partial, under a manifest", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const s = setup();
    s.deps.document = async () => { throw Object.assign(new Error("not cached"), { name: "MapDocumentError", kind: "offline" }); };
    const r = await prepareOfflinePrint("ev", {}, s.deps);
    expect(r.status).toBe("partial");
    expect(await s.store.readManifest("ev")).toMatchObject({ complete: false });
    expect(r.manifest!.queries.length).toBe(4);
    warn.mockRestore();
  });

  it("any other failure is an OfflinePrepareError, after the manifest of what was stored", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const s = setup();
    s.deps.faces = async () => { throw new Error("font liberation-sans: 500"); };
    await expect(prepareOfflinePrint("ev", {}, s.deps)).rejects.toBeInstanceOf(OfflinePrepareError);
    expect(await s.store.readManifest("ev")).toMatchObject({ complete: false });
    const refused = setup();
    refused.deps.lists = async () => { throw Object.assign(new Error("FORBIDDEN"), { data: { code: "FORBIDDEN" } }); };
    await expect(prepareOfflinePrint("ev", {}, refused.deps)).rejects.toMatchObject({ name: "OfflinePrepareError" });
    expect(await refused.store.readManifest("ev")).toBeNull();
    warn.mockRestore();
  });

  it("an explicit action that finds a silent run waits for it and runs its own, with the ensure step", async () => {
    const s = setup();
    const ensure = vi.fn(async () => {});
    const silent = prepareOfflinePrint("ev", { auto: true }, s.deps);
    const explicit = prepareOfflinePrint("ev", { ensure }, s.deps);
    expect(explicit).not.toBe(silent);
    expect(prepareOfflinePrint("ev", { auto: true }, s.deps)).toBe(explicit);
    await silent;
    expect((await explicit).status).toBe("stored");
    expect(ensure).toHaveBeenCalledTimes(1);
  });

  it("a re-run deletes the event's entries outside the new set", async () => {
    const s = setup({ lists: { ...LISTS, sheetSeqs: [5] } });
    await prepareOfflinePrint("ev", {}, s.deps);
    expect(await s.store.getJob("ev", "?maps=5")).not.toBeNull();
    s.deps.lists = async () => LISTS;
    await prepareOfflinePrint("ev", {}, s.deps);
    expect(await s.store.getJob("ev", "?maps=5")).toBeNull();
    expect(s.caches.get("offline-print").paths()).toContain(jobKey("ev", "?courses=3"));
  });

  it("stores nothing where the device cannot compose, or offline", async () => {
    const weak = setup({ deviceMemory: 1 });
    expect((await prepareOfflinePrint("ev", {}, weak.deps)).status).toBe("unsupported");
    const off = setup({ network: false });
    expect((await prepareOfflinePrint("ev", {}, off.deps)).status).toBe("offline");
    expect(weak.requests).toEqual([]);
    expect(off.requests).toEqual([]);
  });

  it("the silent run skips an event stored within 30 minutes and never ensures; the explicit action ensures first", async () => {
    const s = setup();
    const ensure = vi.fn(async () => {});
    await prepareOfflinePrint("ev", { ensure }, s.deps);
    expect(ensure).toHaveBeenCalledTimes(1);
    s.deps.now = () => new Date("2026-11-14T10:20:00.000Z");
    expect((await prepareOfflinePrint("ev", { auto: true, ensure }, s.deps)).status).toBe("fresh");
    s.deps.now = () => new Date("2026-11-14T10:31:00.000Z");
    expect((await prepareOfflinePrint("ev", { auto: true, ensure }, s.deps)).status).toBe("stored");
    expect(ensure).toHaveBeenCalledTimes(1);
  });

  it("a second caller joins the run, and progress is reported until it ends", async () => {
    const s = setup();
    const seen: (number | null)[] = [];
    const off = subscribeOfflinePrint(() => seen.push(offlinePrintProgress("ev")?.total ?? null));
    const a = prepareOfflinePrint("ev", {}, s.deps);
    const b = prepareOfflinePrint("ev", {}, s.deps);
    expect(b).toBe(a);
    await a;
    off();
    expect(seen.length).toBeGreaterThan(2);
    expect(seen.at(-1)).toBeNull();
    expect(offlinePrintProgress("ev")).toBeNull();
  });
});

describe("boxLearningJobs", () => {
  it("the distinct SVG sheets without copies, chunked within the limit, each with the graphics it draws", () => {
    const job = fixturePrintJob();
    const jobs = boxLearningJobs([job, { ...job, sheets: job.sheets.map((s) => ({ ...s, copies: 5 })) }], 64);
    expect(jobs).toHaveLength(1);
    const svgSheets = jobs[0].sheets;
    expect(svgSheets.every((s) => s.copies === 1)).toBe(true);
    expect(svgSheets.length).toBeGreaterThan(0);
    expect(svgSheets.length).toBeLessThan(job.sheets.length + 1);
    expect(jobs[0].graphics.some((g) => g.mime === "image/svg+xml")).toBe(true);
    // Each job within the limit (a lone sheet above it is still composed once).
    const tiny = boxLearningJobs([job], 1);
    expect(tiny.flatMap((j) => j.sheets)).toEqual(svgSheets);
    for (const j of tiny) expect(j.sheets.length === 1 || printCost(j) <= 1).toBe(true);
  });
});
