/**
 * Field mode on a phone: the course setter in the forest with a GPS fix.
 */
import { expect, test } from "@playwright/test";
import { EVENT, mapDrawn, pickCourse, selectEvent, shot, showcaseGuards } from "./shot";

showcaseGuards();

test("field mode", async ({ page, context }) => {
  await selectEvent(page);
  await page.goto(`/${EVENT}/course-editor?mode=field`);
  await expect(page.getByTestId("editor-page")).toBeVisible({ timeout: 30_000 });
  await mapDrawn(page);
  await pickCourse(page);
  await expect(page.getByTestId("editor-field-row").first()).toBeAttached({ timeout: 30_000 });
  const viewer = page.getByTestId("map-viewer");
  const lat = Number(await viewer.getAttribute("data-center-lat"));
  const lng = Number(await viewer.getAttribute("data-center-lng"));
  await context.grantPermissions(["geolocation"]);
  await context.setGeolocation({ latitude: lat, longitude: lng, accuracy: 6 });
  await page.reload();
  await expect(page.getByTestId("editor-field-row").first()).toBeAttached({ timeout: 30_000 });
  await mapDrawn(page);
  await page.getByTestId("editor-sheet-handle").click();
  await page.waitForTimeout(2000);
  await shot(page, "field-mode");
});
