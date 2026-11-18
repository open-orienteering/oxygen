/**
 * `printMapsPdf` (docs/course-print.md §8.6, G16): the device path with
 * the real worker handler behind a fake `Worker`, and every fallback to
 * `maps.pdf` — no worker or little memory (no job asked), a job above the
 * limit, another job version, a worker that fails, a document that cannot
 * be read — and a job HTTP error that is the export's error, with no
 * second request.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PRINT_JOB_VERSION, type PrintJob, resetPreparedDocuments } from "@oxygen/shared/print";
import { FIXTURE_PNG, fixturePrintJob, printDocumentBytes } from "../../../../shared/src/print/__tests__/print-job-fixture";
import { DEVICE_PRINT_JOB_VERSION, OfflinePrintError, type PrintClientDeps, type WorkerLike, composeToStore, printMapsPdf, resetPrintClient } from "../client";
import { createOfflinePrintStore, graphicUrl, jobKey } from "../offline-store";
import { MemoryCaches } from "./memory-caches";
import type { DeviceEnv } from "../capability";
import type { PrintFace, PrintWorkerRequest, PrintWorkerResponse } from "../protocol";
import { createPrintWorker } from "../worker";

const fontsDir = resolve(import.meta.dirname, "../../../../shared/fonts");
const buf = (file: string): ArrayBuffer => new Uint8Array(readFileSync(resolve(fontsDir, file))).buffer as ArrayBuffer;
const faces = (): PrintFace[] => [
  { family: "liberation-sans", data: buf("LiberationSans-Regular.ttf") },
  { family: "liberation-sans-narrow", data: buf("LiberationSansNarrow-Regular.ttf") },
  { family: "liberation-sans", data: buf("LiberationSans-Bold.ttf") },
];

/** A `Worker` running the real handler inline. */
class InlineWorker implements WorkerLike {
  onmessage: ((e: MessageEvent<PrintWorkerResponse>) => void) | null = null;
  onerror: ((e: ErrorEvent) => void) | null = null;
  terminated = false;
  private core = createPrintWorker((msg) => queueMicrotask(() => this.onmessage?.({ data: msg } as MessageEvent<PrintWorkerResponse>)));
  postMessage(msg: PrintWorkerRequest): void {
    queueMicrotask(() => this.core.handle(msg));
  }
  terminate(): void {
    this.terminated = true;
  }
}

/** A worker that fails to start. */
class BrokenWorker implements WorkerLike {
  onmessage: ((e: MessageEvent<PrintWorkerResponse>) => void) | null = null;
  onerror: ((e: ErrorEvent) => void) | null = null;
  terminated = false;
  postMessage(): void {
    queueMicrotask(() => this.onerror?.({ message: "script error", preventDefault() {} } as ErrorEvent));
  }
  terminate(): void {
    this.terminated = true;
  }
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const serverPdf = { blob: new Blob(["%PDF-server"], { type: "application/pdf" }), filename: "server.pdf" };

function deps(over: Partial<Omit<PrintClientDeps, "env">> & { job?: PrintJob | Response; device?: DeviceEnv; network?: boolean; caches?: MemoryCaches } = {}) {
  const requests: string[] = [];
  const workers: WorkerLike[] = [];
  const { job = fixturePrintJob(), device = { worker: true, deviceMemory: 8, coarsePointer: false }, network = true, caches = new MemoryCaches(), ...rest } = over;
  const d: PrintClientDeps = {
    env: () => device,
    store: createOfflinePrintStore(() => caches),
    online: () => network,
    fetch: vi.fn(async (url: string) => {
      requests.push(url);
      if (!network) throw new TypeError("Failed to fetch");
      if (url.includes("/print-job")) return job instanceof Response ? job : json(job);
      if (url.includes("/print.png")) return new Response(FIXTURE_PNG.slice(), { status: 200 });
      return new Response("", { status: 404 });
    }),
    server: vi.fn(async (url: string) => {
      requests.push(url);
      if (!network) throw new TypeError("Failed to fetch");
      return serverPdf;
    }),
    document: vi.fn(async () => printDocumentBytes().slice().buffer as ArrayBuffer),
    faces: async () => faces(),
    createWorker: () => {
      const w = new InlineWorker();
      workers.push(w);
      return w;
    },
    ...rest,
  };
  return { d, requests, workers };
}

afterEach(() => {
  resetPrintClient();
  resetPreparedDocuments();
});

describe("printMapsPdf (§8.6)", () => {
  it("composes on the device: the job, the document by hash through the event, print.png per graphic, the job's file name", async () => {
    const { d, requests } = deps();
    const out = await printMapsPdf("ev 1", "?courses=3", d);
    expect(out.host).toBe("device");
    expect(out.filename).toBe("Fixture_maps.pdf");
    expect(out.blob.type).toBe("application/pdf");
    const head = new TextDecoder().decode(new Uint8Array(await out.blob.arrayBuffer()).slice(0, 5));
    expect(head).toBe("%PDF-");
    expect(requests[0]).toBe("/api/maps/ev%201/print-job?courses=3");
    expect(requests.filter((r) => r.includes("maps.pdf"))).toEqual([]);
    expect(requests).toContain("/api/maps/ev%201/graphics/7/print.png");
    expect(requests.some((r) => /\/graphics\/8\/print\.png\?w=\d+&h=\d+$/.test(r))).toBe(true);
    expect(d.document).toHaveBeenCalledWith(fixturePrintJob().document.hash, "ev 1");
  });

  it("keeps the worker for the next export and asks the document once", async () => {
    const { d, workers } = deps();
    await printMapsPdf("ev", "", d);
    await printMapsPdf("ev", "", d);
    expect(workers).toHaveLength(1);
    expect(d.document).toHaveBeenCalledTimes(1);
  });

  it("the server prints without a Worker or under 2 GiB, and no job is asked", async () => {
    for (const env of [{ worker: false, deviceMemory: 8, coarsePointer: false }, { worker: true, deviceMemory: 1, coarsePointer: false }]) {
      const { d, requests } = deps({ device: env });
      const out = await printMapsPdf("ev", "?allControls=1", d);
      expect(out).toEqual({ ...serverPdf, host: "server" });
      expect(requests).toEqual(["/api/maps/ev/maps.pdf?allControls=1"]);
    }
  });

  it("the server prints a job above the device's limit, or of another version", async () => {
    const big = { ...fixturePrintJob(), sheets: Array.from({ length: 30 }, () => ({ ...fixturePrintJob().sheets[0], paper: { widthMm: 210, heightMm: 297 } })) };
    const tooBig = deps({ job: big, device: { worker: true, deviceMemory: 4, coarsePointer: false } });
    expect((await printMapsPdf("ev", "", tooBig.d)).host).toBe("server");
    expect(tooBig.requests).toEqual(["/api/maps/ev/print-job", "/api/maps/ev/maps.pdf"]);
    const v2 = deps({ job: { ...fixturePrintJob(), version: 2 } as unknown as PrintJob });
    expect((await printMapsPdf("ev", "", v2.d)).host).toBe("server");
    expect(v2.d.document).not.toHaveBeenCalled();
  });

  it("the server prints once when the worker fails to start or the document cannot be read", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const broken = deps({ createWorker: () => new BrokenWorker() });
    expect((await printMapsPdf("ev", "?maps=2", broken.d)).host).toBe("server");
    expect(broken.requests.filter((r) => r.includes("maps.pdf"))).toEqual(["/api/maps/ev/maps.pdf?maps=2"]);
    const noDoc = deps({ document: async () => { throw new Error("map document 403"); } });
    expect((await printMapsPdf("ev", "", noDoc.d)).host).toBe("server");
    expect(noDoc.workers[0] && (noDoc.workers[0] as InlineWorker).terminated).toBe(true);
    warn.mockRestore();
  });

  it("the server prints when the worker goes silent, and the next export still runs", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    class SilentWorker extends BrokenWorker {
      override postMessage(): void {}
    }
    const silent = deps({ createWorker: () => new SilentWorker(), silenceMs: 30 });
    expect((await printMapsPdf("ev", "", silent.d)).host).toBe("server");
    const next = deps();
    expect((await printMapsPdf("ev", "", next.d)).host).toBe("device");
    warn.mockRestore();
  });

  it("the server prints when a 2xx print-job answer is not a job", async () => {
    const { d, requests } = deps({ job: new Response("<html>login</html>", { status: 200 }) });
    expect((await printMapsPdf("ev", "?courses=1", d)).host).toBe("server");
    expect(requests).toEqual(["/api/maps/ev/print-job?courses=1", "/api/maps/ev/maps.pdf?courses=1"]);
  });

  it("a job HTTP error is the export's error, maps.pdf's message, and maps.pdf is not asked", async () => {
    const { d, requests } = deps({ job: new Response('{"error":"No maps found"}', { status: 400 }) });
    await expect(printMapsPdf("ev", "?setter=1", d)).rejects.toThrow('{"error":"No maps found"}');
    expect(requests).toEqual(["/api/maps/ev/print-job?setter=1"]);
  });

  it("composes the version the shared pipeline writes", () => {
    expect(DEVICE_PRINT_JOB_VERSION).toBe(PRINT_JOB_VERSION);
  });
});

describe("printMapsPdf offline (§8.6 \"Offline\", G17)", () => {
  /** The store step's work for `?courses=3`: the job, and its graphics learned by composing once. */
  async function storeFixture(caches: MemoryCaches, storedAt = "2026-11-14T09:30:00.000Z") {
    const { d } = deps({ caches });
    await d.store.putJob("ev", "?courses=3", fixturePrintJob(), storedAt);
    await composeToStore("ev", fixturePrintJob(), d);
    await d.store.writeManifest("ev", { storedAt, documentHash: fixturePrintJob().document.hash, jobVersion: 2, queries: ["?courses=3"], skipped: [], complete: true });
    resetPrintClient();
    return d;
  }

  it("composing to store keeps every print.png the composer asks: the PNG without a box, each SVG at its box", async () => {
    const caches = new MemoryCaches();
    await storeFixture(caches);
    const paths = caches.get("offline-print").paths();
    expect(paths).toContain(graphicUrl("ev", 7));
    expect(paths.some((p) => /\/graphics\/8\/print\.png\?w=\d+&h=\d+$/.test(p))).toBe(true);
  });

  it("with no network composes the stored job and its stored graphics, says when it was stored, and asks no maps.pdf", async () => {
    const caches = new MemoryCaches();
    await storeFixture(caches);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { d, requests } = deps({ caches, network: false });
    const out = await printMapsPdf("ev", "?courses=3", d);
    expect(out).toMatchObject({ host: "device", filename: "Fixture_maps.pdf", storedAt: "2026-11-14T09:30:00.000Z" });
    expect(new TextDecoder().decode(new Uint8Array(await out.blob.arrayBuffer()).slice(0, 5))).toBe("%PDF-");
    // The job was asked once (it failed); every graphic came from the store.
    expect(requests).toEqual(["/api/maps/ev/print-job?courses=3"]);
    expect(warn.mock.calls.flat().join(" ")).not.toMatch(/IMAGE_MISSING|SVG_RASTER/);
    warn.mockRestore();
  });

  it("the device's stored job prints the same bytes as the online export (deterministic aside)", async () => {
    const caches = new MemoryCaches();
    await storeFixture(caches);
    const online = deps();
    const a = await printMapsPdf("ev", "?courses=3", online.d);
    resetPrintClient();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const b = await printMapsPdf("ev", "?courses=3", deps({ caches, network: false }).d);
    warn.mockRestore();
    // Same size: only CreationDate and /ID differ between two compositions (§3.2).
    expect(b.blob.size).toBe(a.blob.size);
  });

  it("a query that was not stored, a stored job above the limit, and a device that cannot compose are typed errors", async () => {
    const caches = new MemoryCaches();
    await storeFixture(caches);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const miss = deps({ caches, network: false });
    await expect(printMapsPdf("ev", "?courses=4", miss.d)).rejects.toMatchObject({ code: "notStored" });
    expect(miss.requests.filter((r) => r.includes("maps.pdf"))).toEqual([]);
    // A job stored by the version-2 client (before J5) must be stored again.
    await miss.d.store.putJob("ev", "?old=1", { ...fixturePrintJob(), version: 2 } as unknown as PrintJob, "t");
    await expect(printMapsPdf("ev", "?old=1", miss.d)).rejects.toMatchObject({ code: "notStored" });
    const big = { ...fixturePrintJob(), sheets: Array.from({ length: 30 }, () => ({ ...fixturePrintJob().sheets[0], paper: { widthMm: 210, heightMm: 297 } })) };
    await miss.d.store.putJob("ev", "", big, "t");
    await expect(printMapsPdf("ev", "", deps({ caches, network: false, device: { worker: true, deviceMemory: 4, coarsePointer: false } }).d)).rejects.toMatchObject({ code: "tooLarge" });
    const weak = deps({ caches, network: false, device: { worker: false, deviceMemory: 8, coarsePointer: false } });
    const err = await printMapsPdf("ev", "?courses=3", weak.d).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OfflinePrintError);
    expect((err as OfflinePrintError).code).toBe("unsupported");
    expect(weak.requests).toEqual([]);
    warn.mockRestore();
  });

  it("a stored job that cannot be composed is 'failed', with no maps.pdf request", async () => {
    const caches = new MemoryCaches();
    await storeFixture(caches);
    // The worker's prepared document (in process here) would spare the read.
    resetPreparedDocuments();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { d, requests } = deps({ caches, network: false, document: async () => { throw new Error("map document offline"); } });
    await expect(printMapsPdf("ev", "?courses=3", d)).rejects.toMatchObject({ code: "failed" });
    expect(requests.filter((r) => r.includes("maps.pdf"))).toEqual([]);
    warn.mockRestore();
  });

  it("an HTTP error is never replaced by the stored job", async () => {
    const caches = new MemoryCaches();
    await storeFixture(caches);
    const { d } = deps({ caches, job: new Response("No requested maps found", { status: 400 }) });
    await expect(printMapsPdf("ev", "?courses=3", d)).rejects.toThrow("No requested maps found");
  });

  it("online, a stored event's job and graphics are written through; an event not stored is left alone", async () => {
    const caches = new MemoryCaches();
    await storeFixture(caches, "2026-11-14T08:00:00.000Z");
    const { d } = deps({ caches });
    await printMapsPdf("ev", "?courses=3&copies=runners", d);
    const fresh = await d.store.getJob("ev", "?copies=runners&courses=3");
    expect(fresh?.storedAt).not.toBe("");
    expect(fresh!.storedAt > "2026-11-14T08:00:00.000Z").toBe(true);
    // The manifest's time is the run's, not the write-through's.
    expect((await d.store.readManifest("ev"))?.storedAt).toBe("2026-11-14T08:00:00.000Z");
    const other = deps({ caches });
    await printMapsPdf("ev2", "?courses=3", other.d);
    expect(caches.get("offline-print").paths().some((p) => p.startsWith("/api/maps/ev2/"))).toBe(false);
    expect(jobKey("ev", "?copies=runners&courses=3")).toBe("/api/maps/ev/print-job?copies=runners&courses=3");
  });
});
