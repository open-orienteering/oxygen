/**
 * The print worker (docs/course-print.md §8.2): `maps.pdf` composing on a
 * worker thread returns what `renderCoursePages` returns in-process, reuses
 * the document it prepared, reports pages as they finish, marshals
 * `CourseStackError`, and leaves the event loop free.
 */

import { readFileSync } from "node:fs";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { course, mapDocument, type SheetInput, resolveSheet } from "@oxygen/shared";
import { importMapToDocument } from "../import/ocad.js";
import { rasteriseSvgGraphic, renderCoursePages } from "../course-maps/pdf-page.js";
import { printGate, printWorkerCount, rasteriseSvgInWorker, renderCoursePagesInWorker, resetPrintWorkers } from "../course-maps/print-worker-host.js";
import { printSheetFor, syntheticCourse } from "./helpers/print-sheet.js";
import { prepareDocument, type PreparedDocument, type PrintPatch } from "@oxygen/shared/print";

const fixture = resolve(__dirname, "../../../../e2e/test.ocd");

let bytes: Uint8Array;
let hash: string;
let doc: PreparedDocument;
let sheets: SheetInput[];

function sheet(label: string, paper?: { size: "A3" | "A4"; orientation: "portrait" | "landscape" }): SheetInput {
  const spec = printSheetFor(doc.header, paper ? { paper } : {});
  const frame = (spec.template.settings as { mapFrame: { width: number; height: number } }).mapFrame;
  const ratio = spec.mapScale / spec.printScale;
  const resolved = resolveSheet({
    kind: "course",
    template: spec.template,
    course: syntheticCourse(spec.centre, { width: frame.width / ratio, height: frame.height / ratio }, spec.mapScale),
    windowCenter: spec.centre,
    mapScale: spec.mapScale,
    meridianTiltDeg: 0,
    event: { name: "Worker test", date: new Date(Date.UTC(2026, 9, 24)) },
    mapName: label,
    courseId: label,
  }).sheet;
  return { ...resolved, label };
}

beforeAll(async () => {
  const imported = await importMapToDocument(readFileSync(fixture), "test.ocd", "ocad");
  bytes = imported.bytes;
  hash = imported.documentHash;
  doc = await prepareDocument(hash, () => bytes);
  sheets = [sheet("one"), sheet("two", { size: "A3", orientation: "landscape" })];
}, 60_000);

afterAll(async () => {
  await resetPrintWorkers();
});

describe("print worker", () => {
  it("returns the in-process bytes", async () => {
    const local = await renderCoursePages({ document: doc, sheets, deterministic: true });
    const remote = await renderCoursePagesInWorker({ document: { hash, bytes: async () => bytes }, sheets, deterministic: true });
    expect(remote.pageCount).toBe(2);
    expect(Buffer.from(remote.bytes).equals(Buffer.from(local.bytes))).toBe(true);
    expect(remote.warnings).toEqual(local.warnings);
  }, 120_000);

  it("reads and sends the document once per worker, and reports pages in order", async () => {
    await resetPrintWorkers();
    const read = vi.fn(async () => bytes);
    const first: string[] = [];
    const a = await renderCoursePagesInWorker({ document: { hash, bytes: read }, sheets, deterministic: true, onPage: (p) => first.push(`${p.index}:${p.label}`) });
    const b = await renderCoursePagesInWorker({ document: { hash, bytes: read }, sheets, deterministic: true });
    expect(read).toHaveBeenCalledTimes(1);
    expect(first).toEqual(["0:one", "1:two"]);
    expect(Buffer.from(b.bytes).equals(Buffer.from(a.bytes))).toBe(true);
  }, 120_000);

  it("sends the document again to a fresh worker", async () => {
    await resetPrintWorkers();
    const read = vi.fn(async () => bytes);
    await renderCoursePagesInWorker({ document: { hash, bytes: read }, sheets: [sheets[0]], deterministic: true });
    expect(read).toHaveBeenCalledTimes(1);
    await resetPrintWorkers();
    await renderCoursePagesInWorker({ document: { hash, bytes: read }, sheets: [sheets[0]], deterministic: true });
    expect(read).toHaveBeenCalledTimes(2);
  }, 120_000);

  it("prints the effective document: keyed by hash + patch version, the worker's bytes equal the in-process ones (G14)", async () => {
    await resetPrintWorkers();
    const sourceIndices = [...mapDocument.decodeMapDocument(bytes).attrs.sourceIndex];
    const hideOf = (version: string, every: number): PrintPatch => ({
      version,
      patch: mapDocument.mapPatchSchema.parse({
        documentHash: hash,
        ops: Object.fromEntries(sourceIndices.filter((_, i) => i % every === 0).map((s) => [`hide:${s}`, { op: "hide", sourceIndex: s }])),
      }),
    });
    const v1 = hideOf("101", 2);
    const v2 = hideOf("102", 3);
    const read = vi.fn(async () => bytes);
    const one = [sheets[0]];

    const plain = await renderCoursePagesInWorker({ document: { hash, bytes: read }, sheets: one, deterministic: true });
    const a = await renderCoursePagesInWorker({ document: { hash, bytes: read, patch: v1 }, sheets: one, deterministic: true });
    expect(read).toHaveBeenCalledTimes(2);
    const local = await renderCoursePages({ document: await prepareDocument(hash, () => bytes, v1), sheets: one, deterministic: true });
    expect(Buffer.from(a.bytes).equals(Buffer.from(local.bytes))).toBe(true);
    expect(Buffer.from(a.bytes).equals(Buffer.from(plain.bytes))).toBe(false);

    // The same version is held; a new one is prepared again and shows.
    const again = await renderCoursePagesInWorker({ document: { hash, bytes: read, patch: v1 }, sheets: one, deterministic: true });
    expect(read).toHaveBeenCalledTimes(2);
    expect(Buffer.from(again.bytes).equals(Buffer.from(a.bytes))).toBe(true);
    const b = await renderCoursePagesInWorker({ document: { hash, bytes: read, patch: v2 }, sheets: one, deterministic: true });
    expect(read).toHaveBeenCalledTimes(3);
    expect(Buffer.from(b.bytes).equals(Buffer.from(a.bytes))).toBe(false);

    // A disabled patch is the unpatched document, byte for byte.
    const off = await renderCoursePagesInWorker({ document: { hash, bytes: read, patch: { ...v2, patch: { ...v2.patch, enabled: false } } }, sheets: one, deterministic: true });
    expect(Buffer.from(off.bytes).equals(Buffer.from(plain.bytes))).toBe(true);
  }, 180_000);

  it("surfaces a worker error with its message", async () => {
    await expect(renderCoursePagesInWorker({ document: { hash: "bad", bytes: async () => new Uint8Array([1, 2, 3]) }, sheets, deterministic: true })).rejects.toBeInstanceOf(Error);
    // The worker survives and prints the next request.
    const ok = await renderCoursePagesInWorker({ document: { hash, bytes: async () => bytes }, sheets: [sheets[0]], deterministic: true });
    expect(ok.pageCount).toBe(1);
  }, 120_000);

  it("rethrows CourseStackError as one", async () => {
    // The same document with its palette ids stripped: the colour stack is not aligned.
    const { header: h } = mapDocument.decodeMapDocument(bytes);
    const { bounds: _b, strings: _s, objects: _o, ...rest } = h as unknown as Record<string, unknown>;
    const stripped = mapDocument.encodeMapDocument({
      header: { ...rest, colours: h.colours.map((c) => ({ ...c, paletteIds: undefined })) } as never,
      objects: [{ symbolIdx: 0, type: 1, sourceIndex: 0, coords: [0, 0], flags: [0] }],
    });
    await expect(
      renderCoursePagesInWorker({ document: { hash: "stackless", bytes: async () => stripped }, sheets: [sheets[0]], deterministic: true }),
    ).rejects.toBeInstanceOf(course.CourseStackError);
  }, 60_000);

  it("rejects an in-flight print when the workers are reset, then recovers", async () => {
    const many = Array.from({ length: 60 }, (_, i) => sheet(`p${i}`));
    let resetting: Promise<void> | undefined;
    const pending = renderCoursePagesInWorker({ document: { hash, bytes: async () => bytes }, sheets: many, deterministic: true, onPage: () => (resetting ??= resetPrintWorkers()) });
    const settled = pending.then(() => "ok", (e: Error) => e.message);
    await settled;
    await resetting;
    expect(await settled).toMatch(/reset|exited|terminated/i);
    const ok = await renderCoursePagesInWorker({ document: { hash, bytes: async () => bytes }, sheets: [sheets[0]], deterministic: true });
    expect(ok.pageCount).toBe(1);
  }, 120_000);

  it("keeps the event loop free while composing", async () => {
    await resetPrintWorkers();
    const many = Array.from({ length: 10 }, (_, i) => sheet(`q${i}`, { size: "A3", orientation: "landscape" }));
    // Warm the worker (font load, decode), then measure.
    await renderCoursePagesInWorker({ document: { hash, bytes: async () => bytes }, sheets: [many[0]], deterministic: true });
    const t0 = performance.now();
    await renderCoursePages({ document: doc, sheets: [many[0]], deterministic: true });
    const perPageMs = performance.now() - t0;

    const h = monitorEventLoopDelay({ resolution: 1 });
    h.enable();
    const out = await printGate(() => renderCoursePagesInWorker({ document: { hash, bytes: async () => bytes }, sheets: many, deterministic: true }));
    h.disable();
    expect(out.pageCount).toBe(10);
    const maxMs = h.max / 1e6;
    // In-process, one page stalls the loop for its whole compose + write.
    expect(maxMs).toBeLessThan(Math.max(25, perPageMs / 2));
  }, 180_000);

  it("rasterises an SVG logo as the in-process resvg does, at the exact box (print.png, §8.5)", async () => {
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 10"><rect width="20" height="10" fill="#c00"/><text x="2" y="8" font-size="6">Ox</text></svg>');
    const local = await rasteriseSvgGraphic(svg, 473, 236);
    const remote = await rasteriseSvgInWorker(svg, 473, 236);
    expect(Buffer.from(remote).equals(Buffer.from(local))).toBe(true);
    expect(Buffer.from(remote).readUInt32BE(16)).toBe(473);
    expect(Buffer.from(remote).readUInt32BE(20)).toBe(236);
    // The caller's bytes are not transferred away.
    expect(svg.byteLength).toBeGreaterThan(0);
    await expect(rasteriseSvgInWorker(new TextEncoder().encode("not svg"), 10, 10)).rejects.toThrow();
  });

  it("sizes the pool from PRINT_WORKERS", () => {
    const prev = process.env.PRINT_WORKERS;
    try {
      delete process.env.PRINT_WORKERS;
      expect(printWorkerCount()).toBe(1);
      process.env.PRINT_WORKERS = "2";
      expect(printWorkerCount()).toBe(2);
      process.env.PRINT_WORKERS = "99";
      expect(printWorkerCount()).toBe(4);
      process.env.PRINT_WORKERS = "0";
      expect(printWorkerCount()).toBe(1);
    } finally {
      if (prev === undefined) delete process.env.PRINT_WORKERS;
      else process.env.PRINT_WORKERS = prev;
    }
  });
});
