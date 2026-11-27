/**
 * The map in 3D: the demo map draped over the terrain derived from its own
 * contours, with the Showcase course on it (Courses page, the course ticked
 * so the map shows it alone). Software WebGL draws it in a few seconds.
 */
import { expect, test } from "@playwright/test";
import { COURSE, EVENT, mapDrawn, selectEvent, shot, showcaseGuards } from "./shot";

showcaseGuards();

test("map in 3D", async ({ page }) => {
  await selectEvent(page);
  await page.goto(`/${EVENT}/courses`);
  await mapDrawn(page);
  if (COURSE) {
    // The name cell's own text, without the "N variants" badge beside it.
    const rows = page.locator("tbody tr");
    const names = await rows.evaluateAll((trs) => trs.map((tr) => (tr.children[1]?.querySelector("span")?.firstChild?.textContent ?? "").trim()));
    const index = names.indexOf(COURSE);
    if (index < 0) throw new Error(`course ${COURSE} not on the Courses page: ${names.filter(Boolean).join(", ")}`);
    await rows.nth(index).locator('input[type="checkbox"]').check();
  }
  await page.addStyleTag({ content: `[data-testid="bulk-action-bar"] { visibility: hidden !important; }` });
  const viewer = page.getByTestId("map-viewer").first();
  await viewer.scrollIntoViewIfNeeded();
  await viewer.getByTestId("map-3d-toggle").click();
  await expect(viewer).toHaveAttribute("data-view-mode", "3d", { timeout: 60_000 });
  await expect(viewer.getByTestId("map-vector-layer")).toHaveAttribute("data-terrain-ready", "true", { timeout: 120_000 });
  // One step closer, the course pulled up to the middle, one more step.
  const zoomIn = viewer.getByRole("button", { name: "Zoom in" }).first();
  await zoomIn.click();
  await page.waitForTimeout(1500);
  const box = (await viewer.boundingBox())!;
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy + 150);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) {
    await page.mouse.move(cx + 3 * i, cy + 150 - 22 * i);
    await page.waitForTimeout(50);
  }
  await page.mouse.up();
  await page.waitForTimeout(1000);
  await zoomIn.click();
  await page.waitForTimeout(3000);
  await shot(page, "map-3d", viewer);
});
