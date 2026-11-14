/**
 * The device's PDF is the server's (docs/course-print.md §8.6, G16; slice G
 * answer 3): the browser's print worker (`packages/web/src/print/worker.ts`,
 * driven as its main thread drives it — the faces in `lib/map-fonts.ts`'s
 * order, the document's bytes, each graphic as `print.png` serves it) and
 * the server's print worker (`renderCoursePagesInWorker`: `worker_threads`,
 * the bundled faces, resvg) compose the fixture job — every sheet kind, a
 * rotated window, a PNG and two SVG graphics — to the same bytes, both
 * `deterministic` (equal writer options, §8.5).
 *
 * Here because only this package holds both workers: the web package's
 * build type-checks its tests and cannot import API code. The engine and
 * the bundle are `e2e/course-maps.spec.ts`'s comparison against `maps.pdf`.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { resetPreparedDocuments } from "@oxygen/shared/print";
import { FIXTURE_HASH, fixtureGraphics, fixturePrintJob, printDocumentBytes } from "../../../shared/src/print/__tests__/print-job-fixture.js";
import { createPrintWorker } from "../../../web/src/print/worker.js";
import type { PrintWorkerResponse } from "../../../web/src/print/protocol.js";
import { rasteriseSvgGraphic } from "../course-maps/pdf-page.js";
import { renderCoursePagesInWorker, resetPrintWorkers } from "../course-maps/print-worker-host.js";

const fontsDir = resolve(__dirname, "../../../shared/fonts");
const face = (file: string): ArrayBuffer => new Uint8Array(readFileSync(resolve(fontsDir, file))).buffer as ArrayBuffer;
const own = (b: Uint8Array): ArrayBuffer => b.slice().buffer as ArrayBuffer;

/** The browser's worker, its main side answering as `print/client.ts` does: the document by hash, `print.png` per graphic and box. */
async function composeOnDevice(): Promise<{ bytes: Uint8Array; pageCount: number; warnings: string[] }> {
  resetPreparedDocuments();
  const job = fixturePrintJob();
  return new Promise((done, fail) => {
    const worker = createPrintWorker((msg: PrintWorkerResponse) => {
      if (msg.type === "need") {
        void (async () => {
          let bytes: Uint8Array;
          if (msg.what === "document") {
            expect(msg.hash).toBe(FIXTURE_HASH);
            bytes = printDocumentBytes();
          } else {
            const g = fixtureGraphics.get(msg.graphicId)!;
            // print.png: a PNG as stored, an SVG rasterised by resvg at exactly the asked box (§8.5).
            bytes = g.mime === "image/png" ? g.data : await rasteriseSvgGraphic(g.data, msg.box![0], msg.box![1]);
          }
          worker.handle({ type: "reply", reqId: msg.reqId, bytes: own(bytes) });
        })().catch(fail);
      } else if (msg.type === "done") done({ bytes: new Uint8Array(msg.bytes), pageCount: msg.pageCount, warnings: msg.warnings });
      else if (msg.type === "error") fail(new Error(msg.message));
    });
    worker.handle({
      type: "init",
      faces: [
        { family: "liberation-sans", data: face("LiberationSans-Regular.ttf") },
        { family: "liberation-sans-narrow", data: face("LiberationSansNarrow-Regular.ttf") },
        { family: "liberation-sans", data: face("LiberationSans-Bold.ttf") },
      ],
    });
    worker.handle({ type: "compose", id: 1, job, deterministic: true });
  });
}

afterAll(() => resetPrintWorkers());

describe("the device's PDF is the server's (§8.6)", () => {
  it("the browser's print worker composes the fixture job to the server print worker's bytes", async () => {
    const job = fixturePrintJob();
    const server = await renderCoursePagesInWorker({
      document: { hash: job.document.hash, bytes: async () => printDocumentBytes() },
      rotationCorrectionDeg: job.document.rotationCorrectionDeg,
      sheets: job.sheets,
      graphics: new Map([...fixtureGraphics].map(([id, g]) => [id, { mime: g.mime, data: g.data }])),
      mode: job.mode,
      info: job.info,
      deterministic: true,
    });
    const device = await composeOnDevice();
    expect(server.warnings).toEqual([]);
    expect(device.warnings).toEqual(server.warnings);
    expect(device.pageCount).toBe(server.pageCount);
    expect(device.pageCount).toBe(6);
    expect(Buffer.from(device.bytes).equals(Buffer.from(server.bytes))).toBe(true);
  }, 120_000);
});
