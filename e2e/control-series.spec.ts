import { test, expect, type Page } from "@playwright/test";
import { reseed } from "./helpers/reseed";

test.describe("club control series", () => {
  test.beforeAll(async () => {
    await reseed();
  });

  test.afterAll(async () => {
    await reseed();
  });

  test("library series allocate codes in the course editor, SRR becomes radio", async ({
    page,
  }) => {
    // Includes a course import and a map upload, which wait up to 60 s
    // for server-side tile rendering — more than the 30 s default.
    test.setTimeout(120_000);
    await page.goto("/");
    await page.getByTestId("library-link").click();
    await page.getByTestId("library-tab-controls").click();
    await expect(page.getByTestId("series-create-form")).toBeVisible({
      timeout: 15000,
    });

    await page.getByTestId("series-create-name").fill("Own");
    await page.getByTestId("series-create-submit").click();
    await expect(page.getByTestId("series-card-Own")).toBeVisible({ timeout: 10000 });
    await page.getByTestId("series-expand-Own").click();
    await page.getByTestId("series-add-from").fill("31");
    await page.getByTestId("series-add-to").fill("33");
    await page.getByTestId("series-add-submit").click();
    await expect(page.getByTestId("series-control-33")).toBeVisible({ timeout: 10000 });
    await page.getByTestId("series-control-type-33").click();
    await expect(page.getByTestId("series-control-type-33")).toHaveText("SRR");

    await page.getByTestId("series-create-name").fill("Lent");
    await page.getByTestId("series-create-owner").fill("Other club");
    await page.getByTestId("series-create-borrowed").check();
    await page.getByTestId("series-create-submit").click();
    await expect(page.getByTestId("series-card-Lent")).toBeVisible({ timeout: 10000 });
    await page.getByTestId("series-expand-Lent").click();
    await page.getByTestId("series-add-from").fill("40");
    await page.getByTestId("series-add-to").fill("41");
    await page.getByTestId("series-add-submit").click();
    await expect(page.getByTestId("series-control-40")).toBeVisible({ timeout: 10000 });

    const stamp = Date.now();
    const eventName = `E2E Series ${stamp}`;
    await page.goto("/");
    await page.getByRole("button", { name: /New Competition/ }).click();
    await page.getByPlaceholder(/Klubbmästerskap/).fill(eventName);
    await page.getByRole("button", { name: "Create" }).click();
    await expect(page.getByRole("link", { name: "Dashboard" })).toBeVisible({
      timeout: 15000,
    });

    await importCoursesAndMap(page);

    await openEditor(page);

    await placeControl(page);
    await page.getByTestId("editor-inventory-panel").getByRole("button").click();
    await expect(page.getByTestId("editor-inventory-code-31")).toHaveAttribute(
      "data-used",
      "true",
    );
    await expect(page.getByTestId("editor-inventory-code-32")).toHaveAttribute(
      "data-used",
      "false",
    );

    // Override the allocation source: with "Lent" selected the next control
    // takes 40 even though 32 is free in the higher-priority own series.
    await page.getByTestId("editor-alloc-series").selectOption({ label: "Lent" });
    await placeControl(page);
    await expect(
      page.locator('[data-testid="editor-control-hit"][data-control-code="40"]'),
    ).toBeAttached({ timeout: 15000 });
    await expect(page.getByTestId("editor-inventory-code-32")).toHaveAttribute(
      "data-used",
      "false",
    );
    await page.getByTestId("editor-alloc-series").selectOption({ index: 0 });

    await page
      .locator('[data-testid="editor-control-hit"][data-control-code="31"]')
      .click();
    await page.getByTestId("editor-action-radio").click();
    await expect(page.getByTestId("editor-context-info")).toContainText(
      "Swap code 31 → 33",
    );
    await page.getByTestId("editor-action-radio-swap-confirm").click();
    await expect(
      page.locator('[data-testid="editor-control-hit"][data-control-code="33"]'),
    ).toBeAttached({ timeout: 15000 });

    await clickTab(page, "Controls");
    let row33 = page.getByRole("row").filter({ hasText: /^33\b/ }).first();
    await expect(row33.getByText("Internal Radio")).toBeVisible({ timeout: 15000 });

    await openEditor(page);
    await page
      .locator('[data-testid="editor-control-hit"][data-control-code="33"]')
      .click();
    await page.getByTestId("editor-action-radio").click();
    await clickTab(page, "Controls");
    row33 = page.getByRole("row").filter({ hasText: /^33\b/ }).first();
    await expect(row33.getByRole("cell").nth(4)).toHaveText("—", {
      timeout: 15000,
    });

    await openEditor(page);
    for (let i = 0; i < 3; i++) {
      await placeControl(page);
    }
    for (const code of [31, 32, 33, 40, 41]) {
      await expect(
        page.locator(`[data-testid="editor-control-hit"][data-control-code="${code}"]`),
      ).toBeAttached({ timeout: 15000 });
    }

    await placeControl(page);
    await expect(page.getByTestId("series-exhausted")).toBeVisible({ timeout: 15000 });
    await expect(
      page.locator(`[data-testid="editor-control-hit"][data-control-code="34"]`),
    ).toBeAttached({ timeout: 15000 });
  });
});

async function clickTab(page: Page, name: string) {
  const mainTab = page.locator("nav[aria-label='Tabs']").getByRole("link", { name, exact: true });
  if (await mainTab.isVisible()) {
    await mainTab.click();
  } else {
    await page.getByTestId("more-menu-button").click();
    await page.getByTestId("more-menu-content").getByRole("link", { name, exact: true }).click();
  }
}

async function importCoursesAndMap(page: Page) {
  await clickTab(page, "Courses");
  await page.getByRole("button", { name: "Import courses" }).click();
  await expect(page.getByText("Import Courses (IOF XML or OCAD OCD)")).toBeVisible();
  const importChooserPromise = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Browse files" }).click();
  await (await importChooserPromise).setFiles("e2e/test.ocd");
  await expect(page.getByText("Courses and Class Assignments")).toBeVisible({ timeout: 20000 });
  await page.getByRole("button", { name: /Import \d+ courses/ }).click();
  await expect(page.getByText("Import Complete")).toBeVisible({ timeout: 15000 });
  await page.getByRole("button", { name: "Done" }).click();

  const mapPanel = page.getByTestId("map-panel");
  const mapChooserPromise = page.waitForEvent("filechooser");
  await mapPanel.getByRole("button", { name: "Upload map" }).click();
  await (await mapChooserPromise).setFiles("e2e/test.ocd");
  await expect(page.getByTestId("map-viewer")).toBeVisible({ timeout: 60000 });
}

async function openEditor(page: Page) {
  await clickTab(page, "Course Editor");
  await expect(page.getByTestId("course-editor-page")).toBeVisible({ timeout: 10000 });
  await expect(page.getByTestId("map-viewer")).toBeVisible({ timeout: 60000 });
  await expect(page.getByTestId("editor-control-hit").first()).toBeAttached({ timeout: 30000 });
}

async function placeControl(page: Page) {
  const viewer = page.getByTestId("map-viewer");
  await expect(viewer).toBeVisible({ timeout: 20000 });
  const box = await viewer.boundingBox();
  if (!box) throw new Error("map viewer has no box");
  const hitBoxes: Array<{ x: number; y: number; w: number; h: number }> = [];
  for (const testId of ["editor-map-course-selector", "editor-inventory-panel"]) {
    const overlay = page.getByTestId(testId);
    const card = (await overlay.isVisible()) ? await overlay.boundingBox() : null;
    if (card) hitBoxes.push({ x: card.x, y: card.y, w: card.width, h: card.height });
  }
  const hits = page.getByTestId("editor-control-hit");
  const n = await hits.count();
  for (let i = 0; i < n; i++) {
    const b = await hits.nth(i).boundingBox();
    if (b) hitBoxes.push({ x: b.x, y: b.y, w: b.width, h: b.height });
  }

  let spot: { x: number; y: number } | null = null;
  for (let gy = 4; gy <= 16 && !spot; gy++) {
    for (let gx = 4; gx <= 16 && !spot; gx++) {
      const x = box.x + (box.width * gx) / 20;
      const y = box.y + (box.height * gy) / 20;
      const near = hitBoxes.some(
        (h) => x >= h.x - 12 && x <= h.x + h.w + 12 && y >= h.y - 12 && y <= h.y + h.h + 12,
      );
      if (!near) spot = { x, y };
    }
  }
  if (!spot) throw new Error("no empty map point found");
  await page.mouse.click(spot.x, spot.y);
  await expect(page.getByTestId("editor-phantom")).toBeAttached({ timeout: 10000 });
  await page.getByTestId("editor-action-add").click();
  await expect(page.getByTestId("editor-selected-info")).toBeVisible({ timeout: 15000 });
  await page.keyboard.press("Escape");
}
