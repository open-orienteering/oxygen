/**
 * The per-event map pipeline switch (docs/map-pipeline-switch.md §3–§4):
 * **Use new map engine** in the course editor's map-info row flips
 * `events.map_pipeline`, every map of the event follows it, and a vector
 * event requests no tiles. While `map.pipeline.allowLegacy` the toggle
 * carries the report note and a browser without WebGL2 falls back to
 * tiles; once legacy is withdrawn a vector event has no toggle and such a
 * browser gets the layer's message.
 *
 * The E2E API reads the instance flags on every request
 * (`MAP_PIPELINE_FLAGS_TTL_MS=0`), so a flag written here applies at once.
 */
import { test, expect, type Page } from "@playwright/test";
import { reseed } from "./helpers/reseed";
import { uploadEventMap } from "./helpers/map-upload";
import { setAllowLegacy, setMapPipeline } from "./helpers/map-pipeline";

let nameId = "";

/** Make `getContext("webgl2")` answer null, as in a browser without WebGL2. */
async function withoutWebGL2(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, kind: string, ...rest: unknown[]) {
      if (kind === "webgl2") return null;
      return (original as (...a: unknown[]) => unknown).call(this, kind, ...rest);
    } as typeof original;
  });
}

async function openEditor(page: Page) {
  await page.goto(`/${nameId}/course-editor`);
  await expect(page.getByTestId("course-editor-page")).toBeVisible({ timeout: 15_000 });
  const panel = page.getByTestId("map-panel").first();
  const viewer = panel.getByTestId("map-viewer");
  await expect(viewer).toBeVisible({ timeout: 60_000 });
  return { panel, viewer, toggle: panel.getByTestId("map-engine-toggle") };
}

test.describe("map pipeline switch", () => {
  test.describe.configure({ mode: "serial" });

  test.beforeAll(async ({ browser }) => {
    await reseed();
    const page = await browser.newPage();
    await page.goto("/");
    await page.getByRole("button", { name: /New Event/ }).click();
    await page.getByPlaceholder(/Klubbmästerskap/).fill(`E2E Pipeline ${Date.now()}`);
    await page.getByRole("button", { name: "Create" }).click();
    await expect(page.getByRole("link", { name: "Dashboard" })).toBeVisible({ timeout: 15_000 });
    nameId = new URL(page.url()).pathname.split("/").filter(Boolean)[0];
    await uploadEventMap(page);
    await expect(page.getByTestId("map-viewer").first()).toBeVisible({ timeout: 60_000 });
    await page.close();
  });

  test.afterEach(async () => {
    await setAllowLegacy(null);
    await setMapPipeline("legacy", nameId);
  });

  test("the toggle switches the event's maps to the vector engine and back", async ({ page }) => {
    test.setTimeout(120_000);
    const { panel, viewer, toggle } = await openEditor(page);
    await expect(viewer).toHaveAttribute("data-map-pipeline", "legacy");
    await expect(toggle).toContainText("Use new map engine");
    await expect(toggle).toContainText("instead of image tiles");
    await expect(toggle.getByTestId("map-engine-report")).toContainText("instance maintainer");
    const checkbox = toggle.getByRole("checkbox", { name: "Use new map engine" });
    await expect(checkbox).not.toBeChecked();

    const tiles: string[] = [];
    page.on("request", (req) => {
      const path = new URL(req.url()).pathname;
      if (path.startsWith("/api/map-tile")) tiles.push(path);
    });
    // Controlled by the query cache, which the mutation updates a tick later: click, then assert.
    await checkbox.click();
    await expect(checkbox).toBeChecked();
    await expect(panel.getByTestId("map-viewer")).toHaveAttribute("data-map-pipeline", "vector");
    await expect(panel.getByTestId("map-vector-layer")).toHaveAttribute("data-ready", "true", {
      timeout: 30_000,
    });

    // Every map of the event follows: a fresh load of another page draws vector, no tiles.
    tiles.length = 0;
    await page.goto(`/${nameId}/controls`);
    const shellViewer = page.getByTestId("map-viewer").first();
    await expect(shellViewer).toHaveAttribute("data-map-pipeline", "vector", { timeout: 60_000 });
    await expect(page.getByTestId("map-vector-layer").first()).toHaveAttribute("data-ready", "true", {
      timeout: 30_000,
    });
    expect(tiles).toEqual([]);

    const back = await openEditor(page);
    const backBox = back.toggle.getByRole("checkbox", { name: "Use new map engine" });
    await expect(backBox).toBeChecked();
    await backBox.click();
    await expect(backBox).not.toBeChecked();
    await expect(back.panel.getByTestId("map-viewer")).toHaveAttribute("data-map-pipeline", "legacy");
    await expect(back.panel.getByTestId("map-tiles-composite")).toHaveCount(1);
  });

  test("without allowLegacy a vector event has no toggle and a legacy event loses the report note", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await setAllowLegacy(false);
    await setMapPipeline("vector", nameId);
    const vector = await openEditor(page);
    await expect(vector.viewer).toHaveAttribute("data-map-pipeline", "vector");
    await expect(vector.toggle).toHaveCount(0);

    await setMapPipeline("legacy", nameId);
    const legacy = await openEditor(page);
    await expect(legacy.toggle).toBeVisible();
    await expect(legacy.toggle.getByTestId("map-engine-report")).toHaveCount(0);
  });

  test("a browser without WebGL2 falls back to tiles while legacy is allowed", async ({ page }) => {
    test.setTimeout(120_000);
    await withoutWebGL2(page);
    await setMapPipeline("vector", nameId);
    const { panel, viewer } = await openEditor(page);
    await expect(viewer).toHaveAttribute("data-map-pipeline", "legacy");
    await expect(panel.getByTestId("map-tiles-composite")).toHaveCount(1);
    await expect(page.getByTestId("map-engine-fallback").first()).toContainText("classic map");

    await setAllowLegacy(false);
    const strict = await openEditor(page);
    await expect(strict.viewer).toHaveAttribute("data-map-pipeline", "vector");
    await expect(strict.panel.getByTestId("map-vector-layer")).toHaveAttribute("data-status", "webgl", {
      timeout: 30_000,
    });
    await expect(page.getByTestId("map-engine-fallback")).toHaveCount(0);
  });

  test("a lost WebGL context falls back to tiles while legacy is allowed", async ({ page }) => {
    test.setTimeout(120_000);
    await setMapPipeline("vector", nameId);
    const { panel, viewer } = await openEditor(page);
    await expect(viewer).toHaveAttribute("data-map-pipeline", "vector");
    const layer = panel.getByTestId("map-vector-layer");
    await expect(layer).toHaveAttribute("data-ready", "true", { timeout: 30_000 });
    await layer.evaluate((canvas: HTMLCanvasElement) =>
      canvas.getContext("webgl2")?.getExtension("WEBGL_lose_context")?.loseContext(),
    );
    await expect(panel.getByTestId("map-viewer")).toHaveAttribute("data-map-pipeline", "legacy");
    await expect(panel.getByTestId("map-tiles-composite")).toHaveCount(1);
    await expect(panel.getByTestId("map-engine-fallback")).toBeVisible();
  });
});
