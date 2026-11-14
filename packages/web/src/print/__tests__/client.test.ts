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
import { DEVICE_PRINT_JOB_VERSION, type PrintClientDeps, type WorkerLike, printMapsPdf, resetPrintClient } from "../client";
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

function deps(over: Partial<Omit<PrintClientDeps, "env">> & { job?: PrintJob | Response; device?: DeviceEnv } = {}) {
  const requests: string[] = [];
  const workers: WorkerLike[] = [];
  const { job = fixturePrintJob(), device = { worker: true, deviceMemory: 8, coarsePointer: false }, ...rest } = over;
  const d: PrintClientDeps = {
    env: () => device,
    fetch: vi.fn(async (url: string) => {
      requests.push(url);
      if (url.includes("/print-job")) return job instanceof Response ? job : json(job);
      if (url.includes("/print.png")) return new Response(FIXTURE_PNG.slice(), { status: 200 });
      return new Response("", { status: 404 });
    }),
    server: vi.fn(async (url: string) => {
      requests.push(url);
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

  it("a job HTTP error is the export's error, maps.pdf's message, and maps.pdf is not asked", async () => {
    const { d, requests } = deps({ job: new Response('{"error":"No maps found"}', { status: 400 }) });
    await expect(printMapsPdf("ev", "?setter=1", d)).rejects.toThrow('{"error":"No maps found"}');
    expect(requests).toEqual(["/api/maps/ev/print-job?setter=1"]);
  });

  it("composes the version the shared pipeline writes", () => {
    expect(DEVICE_PRINT_JOB_VERSION).toBe(PRINT_JOB_VERSION);
  });
});
