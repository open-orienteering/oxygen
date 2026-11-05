import { test, expect, type Page } from "@playwright/test";
import { reseed } from "./helpers/reseed";
import { waitForTrpc } from "./helpers/trpc";
import { editorReady, placeOneShot, select, selectedCode } from "./helpers/editor";

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
    // for the map's import — more than the 30 s default.
    test.setTimeout(120_000);
    await page.goto("/");
    await page.getByTestId("settings-link").click();
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
    await page.getByRole("button", { name: /New Event/ }).click();
    await page.getByPlaceholder(/Klubbmästerskap/).fill(eventName);
    await page.getByRole("button", { name: "Create" }).click();
    await expect(page.getByRole("link", { name: "Dashboard" })).toBeVisible({
      timeout: 15000,
    });

    await importCoursesAndMap(page);

    await openEditor(page);

    await placeControl(page);
    await page.getByTestId("editor-inventory-panel-toggle").click();
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
    await expect(siteByCode(page, "40")).toBeAttached({ timeout: 15000 });
    await expect(page.getByTestId("editor-inventory-code-32")).toHaveAttribute(
      "data-used",
      "false",
    );
    await page.getByTestId("editor-alloc-series").selectOption({ index: 0 });

    await select(page, "31");
    await page.getByTestId("editor-action-radio").click();
    await expect(page.getByTestId("editor-context-info")).toContainText(
      "Swap code 31 → 33",
    );
    await page.getByTestId("editor-action-radio-swap-confirm").click();
    await expect(siteByCode(page, "33")).toBeAttached({ timeout: 15000 });

    await clickTab(page, "Controls");
    let row33 = page.getByRole("row").filter({ hasText: /^33\b/ }).first();
    await expect(row33.getByText("Internal Radio")).toBeVisible({ timeout: 15000 });

    await openEditor(page);
    await select(page, "33");
    const radioOff = waitForTrpc(page, "control.upsertConfig");
    await page.getByTestId("editor-action-radio").click();
    await radioOff;
    await clickTab(page, "Controls");
    row33 = page.getByRole("row").filter({ hasText: /^33\b/ }).first();
    await expect(row33.getByRole("cell").nth(4)).toHaveText("—", {
      timeout: 15000,
    });

    await openEditor(page);
    for (let i = 0; i < 3; i++) {
      await placeControl(page);
    }
    for (const code of ["31", "32", "33", "40", "41"]) {
      await expect(siteByCode(page, code)).toBeAttached({ timeout: 15000 });
    }

    await placeControl(page);
    await expect(page.getByTestId("series-exhausted")).toBeVisible({ timeout: 15000 });
    await expect(siteByCode(page, "34")).toBeAttached({ timeout: 15000 });
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
  await expect(page.getByText("Import Courses (IOF XML, Purple Pen, or OCAD)")).toBeVisible();
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

/** The new course editor (docs/course-editor.md), its course layer drawn and the view settled. */
async function openEditor(page: Page) {
  await clickTab(page, "Course Editor");
  await editorReady(page);
}

/** An editor site by control code (the viewer's `editor-site` mirror). */
function siteByCode(page: Page, code: string) {
  return page.locator(`[data-testid="editor-site"][data-control-code="${code}"]`);
}

/** In `V`: a control on an empty map point, then Escape drops the selection. */
async function placeControl(page: Page) {
  await placeOneShot(page);
  await page.keyboard.press("Escape");
  await expect(selectedCode(page)).toHaveCount(0);
}
