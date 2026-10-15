/**
 * Whole-document WebGL2 load test (docs/map-rendering.md §5.2 / §6.2).
 *
 * `/dev/map-gl-doc` runs the full pipeline on an OCAD file — decode →
 * `ocadObjectsToRender` → `symbolise` → `prepareStream` → `buildBatches`
 * → upload → first frame — and publishes a `LoadReport` and a
 * `BenchReport` on `window.__mapGlDoc`. This spec feeds it the synthetic
 * `e2e/test.ocd` and checks that every stage runs, that batching really
 * merges passes, and that the pixels are not blank. Timings are reported
 * as annotations only: headless Chromium draws with SwiftShader, so they
 * are not comparable with the measured budgets.
 */

import { test, expect } from "@playwright/test";
import { PNG } from "pngjs";

interface DocWindow {
  __mapGlDoc?: {
    load?: {
      objects: { total: number; matched: number; proxied: number; dropped: number };
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
      await page.goto(`/dev/map-gl-doc?mode=${mode}`);
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

  test("reports a decode error for a file that is not OCAD", async ({ page }) => {
    await page.goto("/dev/map-gl-doc");
    await page.getByTestId("map-gl-doc-file").setInputFiles({ name: "junk.ocd", mimeType: "application/octet-stream", buffer: Buffer.from("not an ocad file") });
    await expect(page.getByTestId("map-gl-doc-error")).toBeVisible({ timeout: 15_000 });
    const err = await page.evaluate(() => (window as unknown as DocWindow).__mapGlDoc?.error);
    expect(err).toBeTruthy();
  });
});
