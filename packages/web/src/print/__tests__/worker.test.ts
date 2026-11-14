/**
 * The print worker's handler (docs/course-print.md §8.6, G16), driven as
 * the main thread drives it: the fixture job composes to the bytes the
 * shared `renderPrintJob` gives in process for the same document, faces
 * and graphics (the server's side of that equality is
 * `packages/api/src/__tests__/print-device.test.ts`); the document is asked
 * once per worker, a PNG once without a box, an SVG once per box; an
 * unfetchable graphic still gives a PDF; a document that cannot be read and
 * another job version answer `error`.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { type PrintJob, printFontsFromFaces, renderPrintJob, resetPreparedDocuments } from "@oxygen/shared/print";
import { FIXTURE_PNG, fixturePrintJob, printDocumentBytes } from "../../../../shared/src/print/__tests__/print-job-fixture";
import { createPrintWorker } from "../worker";
import type { PrintFace, PrintWorkerNeed, PrintWorkerResponse } from "../protocol";

const fontsDir = resolve(import.meta.dirname, "../../../../shared/fonts");
const buf = (file: string): ArrayBuffer => {
  const b = readFileSync(resolve(fontsDir, file));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
};
/** `lib/map-fonts.ts`'s order: regular, narrow, bold. */
const faces = (): PrintFace[] => [
  { family: "liberation-sans", data: buf("LiberationSans-Regular.ttf") },
  { family: "liberation-sans-narrow", data: buf("LiberationSansNarrow-Regular.ttf") },
  { family: "liberation-sans", data: buf("LiberationSans-Bold.ttf") },
];

const copy = (b: Uint8Array): ArrayBuffer => b.slice().buffer as ArrayBuffer;

interface Harness {
  out: PrintWorkerResponse[];
  needs: PrintWorkerNeed[];
  compose(job: PrintJob, id?: number): Promise<PrintWorkerResponse>;
}

/** A worker and a main side that answers its requests with `answer`. */
function harness(answer: (n: PrintWorkerNeed) => ArrayBuffer | string): Harness {
  const out: PrintWorkerResponse[] = [];
  const needs: PrintWorkerNeed[] = [];
  const waiting = new Map<number, (m: PrintWorkerResponse) => void>();
  const w = createPrintWorker((msg) => {
    out.push(msg);
    if (msg.type === "need") {
      needs.push(msg);
      const a = answer(msg);
      queueMicrotask(() => w.handle(typeof a === "string" ? { type: "reply", reqId: msg.reqId, error: a } : { type: "reply", reqId: msg.reqId, bytes: a }));
    } else if (msg.type === "done" || msg.type === "error") waiting.get(msg.id)?.(msg);
  });
  w.handle({ type: "init", faces: faces() });
  let next = 1;
  return {
    out,
    needs,
    compose: (job, id = next++) =>
      new Promise((res) => {
        waiting.set(id, res);
        w.handle({ type: "compose", id, job, deterministic: true });
      }),
  };
}

const serve = (n: PrintWorkerNeed): ArrayBuffer => (n.what === "document" ? copy(printDocumentBytes()) : copy(FIXTURE_PNG));

beforeEach(() => resetPreparedDocuments());

describe("print worker (§8.6)", () => {
  it("composes the fixture job to renderPrintJob's bytes, pages reported in order", async () => {
    const h = harness(serve);
    const job = fixturePrintJob();
    const done = await h.compose(job);
    expect(done.type).toBe("done");
    if (done.type !== "done") return;

    resetPreparedDocuments();
    const fonts = printFontsFromFaces(faces().map((f) => ({ family: f.family, data: new Uint8Array(f.data) })));
    const local = await renderPrintJob(job, { fonts, deterministic: true, document: () => printDocumentBytes(), graphic: async () => FIXTURE_PNG });
    expect(new Uint8Array(done.bytes)).toEqual(local.bytes);
    expect(done.pageCount).toBe(6);
    expect(done.warnings).toEqual([]);
    expect(h.out.filter((m) => m.type === "page").map((m) => (m.type === "page" ? `${m.index}:${m.label}` : ""))).toEqual(["0:Blue", "1:Blue", "2:All controls", "3:Setter 1"]);
  });

  it("asks the document once per worker, a PNG once without a box and an SVG once per box", async () => {
    const h = harness(serve);
    const job = fixturePrintJob();
    await h.compose(job);
    const graphics = h.needs.flatMap((n) => (n.what === "graphic" ? [`${n.graphicId}${n.box ? `@${n.box.join("x")}` : ""}`] : []));
    expect(graphics.filter((g) => g === "7")).toHaveLength(1);
    expect(graphics.filter((g) => g.startsWith("8@"))).toHaveLength(1);
    expect(graphics.filter((g) => g.startsWith("9@")).length).toBeGreaterThanOrEqual(1);
    expect(new Set(graphics).size).toBe(graphics.length);
    await h.compose(job);
    expect(h.needs.filter((n) => n.what === "document")).toHaveLength(1);
  });

  it("a graphic the main thread cannot fetch is left out with the server's warnings; the PDF is still written", async () => {
    const h = harness((n) => (n.what === "document" ? copy(printDocumentBytes()) : "print.png 404"));
    const done = await h.compose(fixturePrintJob());
    expect(done.type).toBe("done");
    if (done.type !== "done") return;
    expect(done.pageCount).toBe(6);
    expect(done.warnings.some((w) => /SVG_RASTER: graphic 8: print.png 404/.test(w))).toBe(true);
    expect(done.warnings.some((w) => /IMAGE_MISSING: graphic 7/.test(w))).toBe(true);
  });

  it("answers error for a document it cannot read and for another job version, and keeps working", async () => {
    const h = harness((n) => (n.what === "document" ? "map document 403" : copy(FIXTURE_PNG)));
    expect(await h.compose(fixturePrintJob())).toEqual({ type: "error", id: 1, message: "map document 403" });
    expect(await h.compose({ ...fixturePrintJob(), version: 2 } as unknown as PrintJob)).toEqual({ type: "error", id: 2, message: "Unsupported print job version 2" });
    const ok = harness(serve);
    expect((await ok.compose(fixturePrintJob())).type).toBe("done");
  });

  it("refuses to compose before init", async () => {
    const out: PrintWorkerResponse[] = [];
    const w = createPrintWorker((m) => out.push(m));
    w.handle({ type: "compose", id: 9, job: fixturePrintJob() });
    await w.idle();
    expect(out).toEqual([{ type: "error", id: 9, message: "print worker: no faces (init first)" }]);
  });
});
