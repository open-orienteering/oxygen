/**
 * Course editor bootstrap on a fresh event:
 *
 *   - With a map but ZERO controls, empty-map clicks must still resolve
 *     (the mm↔WGS84 affine comes from the map's calibration metadata,
 *     not from existing control positions — regression for the "clicking
 *     the map does nothing on a new event" bug).
 *   - Start and finish controls can be placed from the context menu
 *     (code-less rows, auto-named Start N / Mål N).
 *   - Multiple starts: a course can be pointed at a specific start.
 */
import { test, expect, type Page } from "@playwright/test";
import { reseed } from "./helpers/reseed";

test.describe("editor start/finish on a fresh event", () => {
  test.beforeAll(async () => {
    await reseed();
  });

  test("place start/control/finish from scratch, reassign multi-start", async ({
    page,
  }) => {
    // The map upload waits up to 60 s for server-side tile rendering,
    // which the 30 s default would cut short.
    test.setTimeout(120_000);
    const stamp = Date.now();
    const eventName = `E2E StartFinish ${stamp}`;

    await page.goto("/");
    await page.getByRole("button", { name: /New Competition/ }).click();
    await page.getByPlaceholder(/Klubbmästerskap/).fill(eventName);
    await page.getByRole("button", { name: "Create" }).click();
    await expect(page.getByRole("link", { name: "Dashboard" })).toBeVisible({
      timeout: 15000,
    });

    // Upload the map — the event has no controls at all.
    const mapPanel = page.getByTestId("map-panel").first();
    const chooserPromise = page.waitForEvent("filechooser");
    await mapPanel.getByRole("button", { name: "Upload map" }).click();
    await (await chooserPromise).setFiles("e2e/test.ocd");
    await expect(page.getByTestId("map-viewer").first()).toBeVisible({
      timeout: 60000,
    });

    await clickTab(page, "Course Editor");
    await expect(page.getByTestId("course-editor-page")).toBeVisible({
      timeout: 10000,
    });
    await expect(page.getByTestId("map-viewer")).toBeVisible({ timeout: 60000 });

    // A click on the empty map must produce a phantom even though no
    // control exists to derive the transform from.
    await clickEmptySpot(page);
    await page.getByTestId("editor-action-add-start").click();
    await expect(hitByCode(page, "Start 1")).toBeAttached({ timeout: 15000 });
    await page.keyboard.press("Escape");

    await clickEmptySpot(page);
    await page.getByTestId("editor-action-add-finish").click();
    await expect(hitByCode(page, "Mål 1")).toBeAttached({ timeout: 15000 });
    await page.keyboard.press("Escape");

    // Create a course and add one numbered control to it.
    await page.getByTestId("editor-new-course-name").fill("Bana A");
    await page.getByTestId("editor-create-course").click();
    await expect(
      page.getByTestId("editor-course-item").filter({ hasText: "Bana A" }),
    ).toBeVisible({ timeout: 15000 });

    await clickEmptySpot(page);
    await page.getByTestId("editor-action-add-to-course").click();
    await expect(page.getByTestId("editor-selected-info")).toBeVisible({
      timeout: 15000,
    });
    await page.keyboard.press("Escape");

    // Sequence shows start + control + finish.
    const seqRows = page.getByTestId("editor-seq-row");
    await expect(seqRows).toHaveCount(3, { timeout: 15000 });
    await expect(seqRows.nth(0)).toHaveAttribute("data-kind", "start");
    await expect(seqRows.nth(0)).toHaveAttribute("data-code", "Start 1");
    await expect(seqRows.nth(1)).toHaveAttribute("data-kind", "control");
    await expect(seqRows.nth(2)).toHaveAttribute("data-kind", "finish");
    await expect(seqRows.nth(2)).toHaveAttribute("data-code", "Mål 1");

    // Second start; the freshly placed control is selected, so the
    // context menu directly offers assigning it to the selected course.
    await clickEmptySpot(page);
    await page.getByTestId("editor-action-add-start").click();
    await expect(hitByCode(page, "Start 2")).toBeAttached({ timeout: 15000 });
    await page.getByTestId("editor-action-use-as-start").click();
    await expect(seqRows.nth(0)).toHaveAttribute("data-code", "Start 2", {
      timeout: 15000,
    });

    // Undo the assignment → back to the default Start 1.
    await page.getByTestId("editor-undo").click();
    await expect(seqRows.nth(0)).toHaveAttribute("data-code", "Start 1", {
      timeout: 15000,
    });
  });
});

async function clickTab(page: Page, name: string) {
  const mainTab = page
    .locator("nav[aria-label='Tabs']")
    .getByRole("link", { name, exact: true });
  if (await mainTab.isVisible()) {
    await mainTab.click();
  } else {
    await page.getByTestId("more-menu-button").click();
    await page
      .getByTestId("more-menu-content")
      .getByRole("link", { name, exact: true })
      .click();
  }
}

function hitByCode(page: Page, code: string) {
  return page.locator(
    `[data-testid="editor-control-hit"][data-control-code="${code}"]`,
  );
}

/** Click a map point away from existing controls and the overlay cards. */
async function clickEmptySpot(page: Page) {
  const viewer = page.getByTestId("map-viewer");
  await expect(viewer).toBeVisible({ timeout: 20000 });
  const box = await viewer.boundingBox();
  if (!box) throw new Error("map viewer has no box");
  const obstacles: Array<{ x: number; y: number; w: number; h: number }> = [];
  for (const testId of ["editor-map-course-selector", "editor-inventory-panel"]) {
    const overlay = page.getByTestId(testId);
    const card = (await overlay.isVisible()) ? await overlay.boundingBox() : null;
    if (card) obstacles.push({ x: card.x, y: card.y, w: card.width, h: card.height });
  }
  const hits = page.getByTestId("editor-control-hit");
  const n = await hits.count();
  for (let i = 0; i < n; i++) {
    const b = await hits.nth(i).boundingBox();
    if (b) obstacles.push({ x: b.x, y: b.y, w: b.width, h: b.height });
  }

  let spot: { x: number; y: number } | null = null;
  for (let gy = 4; gy <= 16 && !spot; gy++) {
    for (let gx = 4; gx <= 16 && !spot; gx++) {
      const x = box.x + (box.width * gx) / 20;
      const y = box.y + (box.height * gy) / 20;
      const near = obstacles.some(
        (h) =>
          x >= h.x - 12 && x <= h.x + h.w + 12 && y >= h.y - 12 && y <= h.y + h.h + 12,
      );
      if (!near) spot = { x, y };
    }
  }
  if (!spot) throw new Error("no empty map point found");
  await page.mouse.click(spot.x, spot.y);
  await expect(page.getByTestId("editor-phantom")).toBeAttached({
    timeout: 10000,
  });
}
