import { test, expect, type Page } from "@playwright/test";
import { reseed } from "./helpers/reseed";
import { uploadEventMap } from "./helpers/map-upload";

/** Event slug from the current URL (`/<nameId>/...`). */
async function currentNameId(page: Page): Promise<string> {
  const path = new URL(page.url()).pathname;
  return path.split("/").filter(Boolean)[0];
}

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
    const viewer = mapPanel.getByTestId("map-viewer");
    await expect(viewer).toBeVisible({ timeout: 20000 });
    // Regression: the map must actually render (viewer mounted and at least
    // one tile image loaded) without a full page reload.
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
    await expect(page.getByTestId("map-panel").first().getByTestId("map-viewer")).toBeVisible({
      timeout: 15000,
    });
  });

  test("Settings → Maps flags stale magnetic-north lines and offers no correction input", async ({
    page,
  }) => {
    await page.goto("/");
    await page.getByTestId("settings-link").click();
    await expect(page.getByTestId("library-tab-maps")).toBeVisible({
      timeout: 15000,
    });

    // The fixture draws its 601 north lines along grid north; the real
    // declination there is ≈ 6.5° E, so the lines are stale.
    await page.getByTestId("library-map-upload").setInputFiles("e2e/test.ocd");
    const card = page.locator('[data-testid^="library-map-card-"]').first();
    await expect(card).toBeVisible({ timeout: 20000 });
    const badge = card.getByTestId("north-lines-badge");
    await expect(badge).toBeVisible({ timeout: 15000 });
    await expect(badge).toHaveAttribute("data-north-lines", "stale");
    const degrees = Number(await badge.getAttribute("data-north-lines-degrees"));
    expect(degrees).toBeGreaterThan(5);
    expect(degrees).toBeLessThan(8);

    // The georeference is authoritative: no manual correction UI anymore.
    await expect(card.getByTestId("library-map-north-correction")).toHaveCount(0);
    await expect(card.getByTestId("library-map-north-save")).toHaveCount(0);
  });

  test("uploading a map with stale north lines warns the course setter", async ({
    page,
  }) => {
    const stamp = Date.now();
    const eventName = `E2E Stale north ${stamp}`;
    await page.goto("/");
    await page.getByRole("button", { name: /New Event/ }).click();
    await page.getByPlaceholder(/Klubbmästerskap/).fill(eventName);
    await page.getByRole("button", { name: "Create" }).click();
    await expect(page.getByRole("link", { name: "Dashboard" })).toBeVisible({
      timeout: 15000,
    });

    await uploadEventMap(page);
    await expect(page.getByTestId("map-viewer").first()).toBeVisible({
      timeout: 60000,
    });

    // One-off notice right after the upload …
    const notice = page.getByTestId("map-upload-notice");
    await expect(notice).toBeVisible({ timeout: 30000 });
    await expect(notice).toContainText(/north lines/i);

    // … and a persistent badge in the course editor's map info row.
    await page.goto(`/${await currentNameId(page)}/course-editor`);
    await expect(page.getByTestId("course-editor-page")).toBeVisible({
      timeout: 15000,
    });
    const badge = page.getByTestId("map-panel").first().getByTestId("north-lines-badge");
    await expect(badge).toBeVisible({ timeout: 30000 });
    await expect(badge).toHaveAttribute("data-north-lines", "stale");
  });
});
