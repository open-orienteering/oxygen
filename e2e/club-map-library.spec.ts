import { test, expect } from "@playwright/test";
import { reseed } from "./helpers/reseed";

test.describe("club map library", () => {
  test.beforeAll(async () => {
    await reseed();
  });

  test("upload, copy into an event, delete library row without affecting the event", async ({
    page,
  }) => {
    const stamp = Date.now();
    const mapName = `E2E Map ${stamp}`;
    const eventName = `E2E Library ${stamp}`;

    await page.goto("/");
    await page.getByTestId("settings-link").click();
    await expect(page.getByTestId("library-tab-maps")).toBeVisible({
      timeout: 15000,
    });

    await page.getByTestId("library-map-upload").setInputFiles("e2e/test.ocd");
    await expect(page.getByTestId("library-map-name")).toBeVisible({
      timeout: 20000,
    });
    const preview = page.getByTestId("club-map-preview").first();
    await expect(preview).toBeVisible({ timeout: 20000 });
    await expect
      .poll(() => preview.evaluate((img: HTMLImageElement) => img.naturalWidth), {
        timeout: 20000,
      })
      .toBeGreaterThan(0);

    await page.getByTestId("library-map-name").click();
    const rename = page.getByTestId("library-map-rename");
    await expect(rename).toBeVisible();
    await rename.fill(mapName);
    await rename.press("Enter");
    await expect(page.getByTestId("library-map-name")).toHaveText(mapName, {
      timeout: 10000,
    });

    await page.goto("/");
    await page.getByRole("button", { name: /New Event/ }).click();
    await page.getByPlaceholder(/Klubbmästerskap/).fill(eventName);
    await page.getByRole("button", { name: "Create" }).click();
    await expect(page.getByRole("link", { name: "Dashboard" })).toBeVisible({
      timeout: 15000,
    });

    const mapPanel = page.getByTestId("map-panel").first();
    await expect(mapPanel.getByTestId("use-club-map")).toBeVisible({
      timeout: 15000,
    });
    await mapPanel.getByTestId("use-club-map").click();
    await expect(page.getByTestId("club-map-picker")).toBeVisible();
    await page.getByRole("button", { name: mapName }).click();
    await expect(mapPanel.getByText("test.ocd")).toBeVisible({ timeout: 20000 });
    // Regression: the map must actually render (viewer mounted and at least
    // one tile image loaded) without a full page reload.
    const viewer = mapPanel.getByTestId("map-viewer");
    await expect(viewer).toBeVisible({ timeout: 20000 });
    await expect
      .poll(
        async () =>
          viewer.locator("img").evaluateAll((imgs) =>
            imgs.filter((el) => (el as HTMLImageElement).naturalWidth > 0).length,
          ),
        { timeout: 30000 },
      )
      .toBeGreaterThan(0);

    await page.goto("/settings");
    await expect(page.getByTestId("library-map-name")).toHaveText(mapName);
    await page.getByTestId("library-map-delete").click();
    await expect(page.getByTestId("library-delete-confirm")).toBeVisible();
    await page.getByTestId("library-delete-confirm-btn").click();
    await expect(page.getByText(mapName)).toHaveCount(0, { timeout: 10000 });

    await page.goto("/");
    await page.getByText(eventName).click();
    await expect(page.getByTestId("map-panel").first().getByText("test.ocd")).toBeVisible({
      timeout: 15000,
    });
  });
});
