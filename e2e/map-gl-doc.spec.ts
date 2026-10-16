/**
 * Whole-document WebGL2 load test (docs/map-rendering.md §5.2 / §6.2).
 *
 * `/dev/map-gl-doc` runs the full pipeline on an OCAD file — read →
 * normalise → encode → decode (docs/map-document-format.md) → render
 * bridge → `symbolise` → `prepareStream` → `buildBatches` → upload →
 * first frame — and publishes a `LoadReport` and a `BenchReport` on
 * `window.__mapGlDoc`. This spec feeds it the synthetic `e2e/test.ocd`
 * and checks that every stage runs, that batching really merges passes,
 * that the document path and the S1 reader path agree, that a native
 * `.oxvm` loads without the OCAD reader, and that the pixels are not
 * blank. Timings are reported as annotations only: headless Chromium
 * draws with SwiftShader, so they are not comparable with the measured
 * budgets.
 */

import { test, expect } from "@playwright/test";
import { PNG } from "pngjs";

interface DocWindow {
  __mapGlDoc?: {
    documentBytes?: Uint8Array;
    load?: {
      mode: "source" | "pilot" | "envelope";
      via: "document" | "reader";
      document?: {
        bytes: number;
        headerBytes: number;
        sections: { attrs: number; bboxes: number; geometry: number };
        ms: { decode: number; encode: number; normalise: number; hash: number };
        hash: string;
        objects: number;
        symbols: number;
        colours: number;
        native: boolean;
      };
      objects: { total: number; matched: number; proxied: number; dropped: number; coordinates: number };
      passes: number;
      batch: { batches: number; passes: number };
      ms: { total: number };
      firstFrame: { drawCalls: number };
      gpuBytes: number;
    };
    bench?: { frames: number; fps: number; drawCalls: number; cpuMs: { avg: number } };
    error?: string;
  };
}

test.describe("WebGL2 map backend — whole document", () => {
  for (const mode of ["pilot", "envelope"] as const) {
    test(`loads e2e/test.ocd in ${mode} mode, batches it and benchmarks`, async ({ page }, testInfo) => {
      await page.goto(`/dev/map-gl-doc?mode=${mode}&via=reader`);
      await page.getByTestId("map-gl-doc-file").setInputFiles("e2e/test.ocd");

      const canvas = page.getByTestId("map-gl-doc-canvas");
      await expect(canvas).toHaveAttribute("data-ready", "true", { timeout: 30_000 });
      await expect(page.getByTestId("map-gl-doc-error")).toHaveCount(0);

      const load = await page.evaluate(() => (window as unknown as DocWindow).__mapGlDoc?.load);
      expect(load).toBeDefined();
      if (!load) return;
      testInfo.annotations.push({ type: "map-gl-doc", description: JSON.stringify(load) });

      expect(load.objects.total).toBeGreaterThan(0);
      expect(load.objects.matched + load.objects.proxied).toBeGreaterThan(0);
      if (mode === "envelope") {
        // Envelope mode draws every object; nothing but empty geometry may be dropped.
        expect(load.objects.matched + load.objects.proxied + load.objects.dropped).toBe(load.objects.total);
        expect(load.objects.proxied).toBeGreaterThan(0);
      }
      expect(load.passes).toBeGreaterThan(0);
      expect(load.batch.passes).toBe(load.passes);
      // Batching is the point: draws must be well below one per pass.
      expect(load.batch.batches).toBeLessThan(load.passes);
      expect(load.firstFrame.drawCalls).toBeGreaterThan(0);
      expect(load.firstFrame.drawCalls).toBeLessThanOrEqual(load.batch.batches * 2);
      expect(load.gpuBytes).toBeGreaterThan(0);

      await expect(page.getByTestId("map-gl-doc-stats")).toContainText(`passes ${load.passes}`);

      // Something was drawn: the canvas is not uniformly the paper colour.
      const dataUrl = await canvas.evaluate((c) => (c as HTMLCanvasElement).toDataURL("image/png"));
      const png = PNG.sync.read(Buffer.from(dataUrl.split(",")[1], "base64"));
      const seen = new Set<number>();
      for (let i = 0; i < png.data.length; i += 4 * 97) seen.add((png.data[i] << 16) | (png.data[i + 1] << 8) | png.data[i + 2]);
      expect(seen.size).toBeGreaterThan(1);

      await page.getByTestId("map-gl-doc-bench").click();
      await expect(canvas).toHaveAttribute("data-bench", "done", { timeout: 60_000 });
      const bench = await page.evaluate(() => (window as unknown as DocWindow).__mapGlDoc?.bench);
      expect(bench).toBeDefined();
      if (!bench) return;
      testInfo.annotations.push({ type: "map-gl-doc-bench", description: JSON.stringify(bench) });
      expect(bench.frames).toBe(240);
      expect(bench.fps).toBeGreaterThan(0);
      expect(bench.drawCalls).toBe(load.firstFrame.drawCalls);
      await expect(page.getByTestId("map-gl-doc-bench-result")).toContainText("fps");
    });
  }

  test("the document path agrees with the reader path and a native .oxvm skips the reader", async ({ page }, testInfo) => {
    const load = async (query: string, file: string | { name: string; mimeType: string; buffer: Buffer }) => {
      await page.goto(`/dev/map-gl-doc?${query}`);
      await page.getByTestId("map-gl-doc-file").setInputFiles(file);
      await expect(page.getByTestId("map-gl-doc-canvas")).toHaveAttribute("data-ready", "true", { timeout: 30_000 });
      await expect(page.getByTestId("map-gl-doc-error")).toHaveCount(0);
      const w = await page.evaluate(() => {
        const d = (window as unknown as DocWindow).__mapGlDoc;
        return { load: d?.load, bytes: d?.documentBytes ? Array.from(d.documentBytes) : undefined };
      });
      expect(w.load).toBeDefined();
      return w as { load: NonNullable<DocWindow["__mapGlDoc"]>["load"] & object; bytes?: number[] };
    };

    const viaReader = await load("mode=envelope&via=reader", "e2e/test.ocd");
    expect(viaReader.load.via).toBe("reader");
    expect(viaReader.load.document).toBeUndefined();

    const viaDocument = await load("mode=envelope&via=document", "e2e/test.ocd");
    expect(viaDocument.load.via).toBe("document");
    const doc = viaDocument.load.document!;
    testInfo.annotations.push({ type: "map-document", description: JSON.stringify(doc) });
    expect(doc.native).toBe(false);
    expect(doc.bytes).toBeGreaterThan(doc.headerBytes);
    expect(doc.bytes).toBe(doc.headerBytes + doc.sections.attrs + doc.sections.bboxes + doc.sections.geometry);
    expect(doc.sections.attrs).toBe(doc.objects * 24);
    expect(doc.sections.bboxes).toBe(doc.objects * 16);
    expect(doc.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(doc.symbols).toBeGreaterThan(0);
    expect(doc.colours).toBeGreaterThan(0);
    await expect(page.getByTestId("map-gl-doc-document")).toContainText("decode");
    // Same drawable content as the reader path (envelope draws every non-hidden object).
    expect(viaDocument.load.objects.coordinates).toBe(viaReader.load.objects.coordinates);
    expect(viaDocument.load.objects.matched + viaDocument.load.objects.proxied).toBe(viaReader.load.objects.matched + viaReader.load.objects.proxied);
    expect(viaDocument.load.passes).toBe(viaReader.load.passes);
    expect(viaDocument.bytes).toBeDefined();
    expect(viaDocument.bytes!.length).toBe(doc.bytes);

    // Feed the encoded document back in: no OCAD reader, identical hash and content.
    const native = await load("mode=envelope", { name: "test.oxvm", mimeType: "application/octet-stream", buffer: Buffer.from(viaDocument.bytes!) });
    expect(native.load.via).toBe("document");
    expect(native.load.document!.native).toBe(true);
    expect(native.load.document!.hash).toBe(doc.hash);
    expect(native.load.document!.ms.encode).toBe(0);
    expect(native.load.passes).toBe(viaDocument.load.passes);
    expect(native.load.objects.coordinates).toBe(viaDocument.load.objects.coordinates);
    await expect(page.getByTestId("map-gl-doc-document")).toContainText("native");
  });

  test("source mode draws the fixture with its own converted symbol definitions, no proxies", async ({ page }, testInfo) => {
    // Default mode: the OCAD → IR conversion (docs/map-import.md §3.3) renders every fixture symbol natively.
    await page.goto("/dev/map-gl-doc");
    await page.getByTestId("map-gl-doc-file").setInputFiles("e2e/test.ocd");
    await expect(page.getByTestId("map-gl-doc-canvas")).toHaveAttribute("data-ready", "true", { timeout: 30_000 });
    await expect(page.getByTestId("map-gl-doc-error")).toHaveCount(0);
    await expect(page.getByTestId("map-gl-doc-stats")).toContainText("proxied 0");
    const load = await page.evaluate(() => (window as unknown as DocWindow).__mapGlDoc?.load);
    expect(load).toBeDefined();
    testInfo.annotations.push({ type: "map-gl-doc-source", description: JSON.stringify({ objects: load!.objects, warnings: load!.document?.warnings }) });
    expect(load!.mode).toBe("source");
    expect(load!.via).toBe("document");
    expect(load!.objects.matched).toBeGreaterThan(0);
    expect(load!.objects.proxied).toBe(0);
    expect(load!.objects.dropped).toBe(0);
    expect(load!.passes).toBeGreaterThan(0);
    expect(load!.document?.warnings ?? {}).not.toHaveProperty("SYMBOL_COLOUR_UNKNOWN");
    expect(load!.document?.warnings ?? {}).not.toHaveProperty("SYMBOL_EMPTY");
    // Something was drawn: the canvas is not uniformly the paper colour.
    const dataUrl = await page.getByTestId("map-gl-doc-canvas").evaluate((c) => (c as HTMLCanvasElement).toDataURL("image/png"));
    const png = PNG.sync.read(Buffer.from(dataUrl.split(",")[1], "base64"));
    const seen = new Set<number>();
    for (let i = 0; i < png.data.length; i += 4 * 97) seen.add((png.data[i] << 16) | (png.data[i + 1] << 8) | png.data[i + 2]);
    expect(seen.size).toBeGreaterThan(1);
  });

  test("reports a decode error for a file that is not OCAD", async ({ page }) => {
    await page.goto("/dev/map-gl-doc");
    await page.getByTestId("map-gl-doc-file").setInputFiles({ name: "junk.ocd", mimeType: "application/octet-stream", buffer: Buffer.from("not an ocad file") });
    await expect(page.getByTestId("map-gl-doc-error")).toBeVisible({ timeout: 15_000 });
    const err = await page.evaluate(() => (window as unknown as DocWindow).__mapGlDoc?.error);
    expect(err).toBeTruthy();
  });
});
