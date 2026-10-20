/**
 * Whole-document WebGL2 load test (docs/map-rendering.md §5.2 / §6.2).
 *
 * `/dev/map-gl-doc` runs the full pipeline on an OCAD file — read →
 * normalise → encode on the page; decode (docs/map-document-format.md) →
 * render bridge → `symbolise` → mesh atlas → buckets → always-resident
 * layers in the worker; upload → visible set → first frame → the visible
 * cells' detail → complete frame on the page — and publishes a
 * `LoadReport` and a `BenchReport` on `window.__mapGlDoc`. This spec feeds
 * it the synthetic `e2e/test.ocd` (and `e2e/test.xmap`) and checks that
 * every stage runs, that the visible set really merges passes into a draw
 * per (colour, kind) (≤ 300 per frame, 04 §9), that the worker and the
 * inline handler agree, that a tiny budget evicts and still draws, that
 * the arena path draws what the per-pass golden path draws, that the
 * document path and the S1 reader path agree, that a native `.oxvm` loads
 * without the OCAD reader, and that the pixels are not blank. Timings are
 * reported as annotations only: headless Chromium draws with SwiftShader,
 * so they are not comparable with the measured budgets.
 */

import { test, expect } from "@playwright/test";
import { PNG } from "pngjs";

interface Scenario {
  frames: number;
  fps: number;
  drawCalls: number;
  maxDrawCalls: number;
  cpuMs: { avg: number };
  maxResidentBytes?: number;
  evictions?: number;
  overBudgetFrames?: number;
}

interface DocWindow {
  __mapGlDoc?: {
    documentBytes?: Uint8Array;
    load?: {
      mode: "source" | "pilot" | "envelope";
      path: "arena" | "s1";
      via: "document" | "reader";
      document?: {
        bytes: number;
        headerBytes: number;
        sections: { attrs: number; bboxes: number; geometry: number };
        ms: { decode: number; encode: number; match: number; normalise: number; hash: number };
        hash: string;
        objects: number;
        symbols: number;
        canonicalSymbols: number;
        colours: number;
        native: boolean;
      };
      objects: { total: number; matched: number; proxied: number; dropped: number; coordinates: number };
      passes: number;
      colours: number;
      arena?: {
        worker: boolean;
        detailCells: number;
        grid: { cols: number; rows: number };
        engine: { drawnCells: number; residentDetail: number; pending: number; overBudget: boolean };
      };
      ms: { total: number; firstFrame: number; complete: number };
      firstFrame: { drawCalls: number };
      completeFrame: { drawCalls: number };
      gpuBytes: number;
    };
    bench?: Scenario & { paper1x?: Scenario };
    compare?: { fraction: number; differing: number; total: number };
    error?: string;
  };
}

const notBlank = async (page: import("@playwright/test").Page) => {
  const dataUrl = await page.getByTestId("map-gl-doc-canvas").evaluate((c) => (c as HTMLCanvasElement).toDataURL("image/png"));
  const png = PNG.sync.read(Buffer.from(dataUrl.split(",")[1], "base64"));
  const seen = new Set<number>();
  for (let i = 0; i < png.data.length; i += 4 * 97) seen.add((png.data[i] << 16) | (png.data[i + 1] << 8) | png.data[i + 2]);
  expect(seen.size).toBeGreaterThan(1);
};

test.describe("WebGL2 map backend — whole document", () => {
  for (const mode of ["pilot", "envelope"] as const) {
    test(`loads e2e/test.ocd in ${mode} mode, buckets it, draws the visible set and benchmarks`, async ({ page }, testInfo) => {
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
      expect(load.path).toBe("arena");
      expect(load.arena?.worker).toBe(true);
      // Buckets: the fixture spans several 50 mm cells, and at the fit view every cell's detail is resident.
      expect(load.arena!.grid.cols * load.arena!.grid.rows).toBeGreaterThan(1);
      expect(load.arena!.detailCells).toBeGreaterThan(0);
      expect(load.arena!.engine.pending).toBe(0);
      expect(load.arena!.engine.overBudget).toBe(false);
      // The first frame is the always-resident layers; the complete frame adds the detail.
      expect(load.completeFrame.drawCalls).toBeGreaterThan(load.firstFrame.drawCalls);
      // The visible set is the point: one draw per (colour, kind), well below one per pass, ≤ 300 (04 §9).
      expect(load.completeFrame.drawCalls).toBeLessThan(load.passes);
      expect(load.completeFrame.drawCalls).toBeLessThanOrEqual(300);
      expect(load.gpuBytes).toBeGreaterThan(0);

      await expect(page.getByTestId("map-gl-doc-stats")).toContainText(`passes ${load.passes}`);
      await expect(page.getByTestId("map-gl-doc-arena")).toContainText("with detail");
      await notBlank(page);

      await page.getByTestId("map-gl-doc-bench").click();
      await expect(canvas).toHaveAttribute("data-bench", "done", { timeout: 90_000 });
      const bench = await page.evaluate(() => (window as unknown as DocWindow).__mapGlDoc?.bench);
      expect(bench).toBeDefined();
      if (!bench) return;
      testInfo.annotations.push({ type: "map-gl-doc-bench", description: JSON.stringify(bench) });
      for (const sc of [bench, bench.paper1x!]) {
        expect(sc.frames).toBe(240);
        expect(sc.fps).toBeGreaterThan(0);
        expect(sc.maxDrawCalls).toBeGreaterThan(0);
        expect(sc.maxDrawCalls).toBeLessThanOrEqual(300);
        expect(sc.maxResidentBytes).toBeGreaterThan(0);
      }
      await expect(page.getByTestId("map-gl-doc-bench-result")).toContainText("fps");
    });
  }

  test("the worker and the inline handler agree; a tiny budget evicts and still draws", async ({ page }, testInfo) => {
    const run = async (query: string, bench: boolean) => {
      await page.goto(`/dev/map-gl-doc?mode=envelope&${query}`);
      await page.getByTestId("map-gl-doc-file").setInputFiles("e2e/test.ocd");
      await expect(page.getByTestId("map-gl-doc-canvas")).toHaveAttribute("data-ready", "true", { timeout: 30_000 });
      await expect(page.getByTestId("map-gl-doc-error")).toHaveCount(0);
      if (bench) {
        await page.getByTestId("map-gl-doc-bench").click();
        await expect(page.getByTestId("map-gl-doc-canvas")).toHaveAttribute("data-bench", "done", { timeout: 90_000 });
      }
      return (await page.evaluate(() => (window as unknown as DocWindow).__mapGlDoc))!;
    };
    const worker = await run("worker=1", false);
    const inline = await run("worker=0", false);
    expect(inline.load!.arena!.worker).toBe(false);
    expect(inline.load!.passes).toBe(worker.load!.passes);
    expect(inline.load!.completeFrame.drawCalls).toBe(worker.load!.completeFrame.drawCalls);
    expect(inline.load!.arena!.detailCells).toBe(worker.load!.arena!.detailCells);

    // 0.05 MB is below the always-resident layers alone: the drawn set is kept (reported over budget),
    // everything else is evicted as the bench zooms in and pans.
    const tiny = await run("budget=0.05", true);
    testInfo.annotations.push({ type: "map-gl-doc-tiny-budget", description: JSON.stringify({ load: tiny.load!.arena!.engine, bench: tiny.bench }) });
    expect(tiny.bench!.evictions! + tiny.bench!.paper1x!.evictions!).toBeGreaterThan(0);
    expect(tiny.bench!.overBudgetFrames).toBeGreaterThan(0);
    await notBlank(page);
  });

  test("the arena path draws what the per-pass golden path draws", async ({ page }, testInfo) => {
    // The per-pass path is the one the golden spec checks against the reference raster (§6.2).
    for (const mode of ["envelope", "source"]) {
      await page.goto(`/dev/map-gl-doc?mode=${mode}&compare=1`);
      await page.getByTestId("map-gl-doc-file").setInputFiles("e2e/test.ocd");
      await page.waitForFunction(() => (window as unknown as DocWindow).__mapGlDoc?.compare || (window as unknown as DocWindow).__mapGlDoc?.error, null, { timeout: 60_000 });
      const cmp = await page.evaluate(() => (window as unknown as DocWindow).__mapGlDoc?.compare);
      testInfo.annotations.push({ type: `map-gl-doc-compare-${mode}`, description: JSON.stringify(cmp) });
      expect(cmp).toBeDefined();
      // 04 §9: ≤ 0.5 % of pixels differing beyond the AA tolerance.
      expect(cmp!.fraction).toBeLessThanOrEqual(0.005);
    }
  });

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

  test("source mode draws the fixture through the matcher: canonical where matched, its own definitions otherwise, no proxies", async ({ page }, testInfo) => {
    // Default mode: the OCAD → IR conversion (docs/map-import.md §3.3) plus stages 6–7 (docs/map-symbols.md §8–9) in the browser.
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
    // Stages 6–7 ran: some fixture symbols are drawn from the ISOM library, the single
    // purple was split into lower + upper, and the fixture's non-standard colour order is flagged.
    expect(load!.document!.canonicalSymbols).toBeGreaterThan(0);
    expect(load!.document!.canonicalSymbols).toBeLessThan(load!.document!.symbols);
    expect(load!.document!.warnings).toHaveProperty("COLOUR_ORDER_CONFLICT");
    expect(load!.document!.warnings).not.toHaveProperty("SYMBOL_UNMATCHED");
    await expect(page.getByTestId("map-gl-doc-document")).toContainText("canonical");
    // Something was drawn: the canvas is not uniformly the paper colour.
    await notBlank(page);
  });

  test("loads the synthetic Mapper fixture e2e/test.xmap client-side without the OCAD reader", async ({ page }, testInfo) => {
    // The OMAP path (docs/map-import.md §3.4): readOmap → omapToDocumentInput → stages 6–8 unchanged.
    await page.goto("/dev/map-gl-doc");
    await page.getByTestId("map-gl-doc-file").setInputFiles("e2e/test.xmap");
    await expect(page.getByTestId("map-gl-doc-canvas")).toHaveAttribute("data-ready", "true", { timeout: 30_000 });
    await expect(page.getByTestId("map-gl-doc-error")).toHaveCount(0);
    // The fixture's one dangling-symbol object is drawn as a proxy; its two hidden-symbol objects are not drawn.
    await expect(page.getByTestId("map-gl-doc-stats")).toContainText("proxied 1, dropped 2");
    const load = await page.evaluate(() => (window as unknown as DocWindow).__mapGlDoc?.load);
    expect(load).toBeDefined();
    testInfo.annotations.push({ type: "map-gl-doc-omap", description: JSON.stringify({ objects: load!.objects, warnings: load!.document?.warnings }) });
    expect(load!.mode).toBe("source");
    expect(load!.via).toBe("document");
    expect(load!.document!.native).toBe(false);
    expect(load!.objects.matched).toBe(21);
    expect(load!.objects.proxied).toBe(1);
    expect(load!.objects.dropped).toBe(2);
    expect(load!.passes).toBeGreaterThan(0);
    expect(load!.document!.canonicalSymbols).toBeGreaterThan(0);
    // OMAP-specific normalisation warnings surfaced through the same document header.
    expect(load!.document!.warnings).toHaveProperty("TEMPLATES_DROPPED");
    expect(load!.document!.warnings).toHaveProperty("PARTS_MERGED");
    expect(load!.document!.warnings).toHaveProperty("MISSING_SYMBOL");
    expect(load!.document?.warnings ?? {}).not.toHaveProperty("SYMBOL_COLOUR_UNKNOWN");
    await notBlank(page);
  });

  test("reports a decode error for a file that is not OCAD", async ({ page }) => {
    await page.goto("/dev/map-gl-doc");
    await page.getByTestId("map-gl-doc-file").setInputFiles({ name: "junk.ocd", mimeType: "application/octet-stream", buffer: Buffer.from("not an ocad file") });
    await expect(page.getByTestId("map-gl-doc-error")).toBeVisible({ timeout: 15_000 });
    const err = await page.evaluate(() => (window as unknown as DocWindow).__mapGlDoc?.error);
    expect(err).toBeTruthy();
  });
});
