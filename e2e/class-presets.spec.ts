import { expect, test, type Page } from "@playwright/test";
import { reseed } from "./helpers/reseed";

test.describe("club class presets", () => {
  test.beforeAll(reseed);
  test.afterAll(reseed);

  test("bulk adds presets and auto-links a matching new course", async ({ page }) => {
    // Library setup, a fresh event, a bulk add and a map upload in one
    // flow: the upload alone waits up to 60 s for server-side tile
    // rendering, which the 30 s default would cut short under the
    // parallel-shard load.
    test.setTimeout(120_000);
    await page.goto("/");
    await page.getByTestId("library-link").click();
    await page.getByTestId("library-tab-classes").click();

    await addPreset(page, "H21", {
      sex: "M",
      lowAge: "21",
      highAge: "39",
      type: "Elite",
      noTiming: true,
      freeStart: true,
      quickEntry: true,
      sortIndex: "10",
    });
    await addPreset(page, "D21", {
      sex: "F",
      lowAge: "21",
      highAge: "39",
      type: "Elite",
      sortIndex: "20",
    });
    await expect(page.getByTestId("preset-row-H21")).toBeVisible();
    await expect(page.getByTestId("preset-row-D21")).toBeVisible();

    const eventName = `E2E Presets ${Date.now()}`;
    await page.goto("/");
    await page.getByRole("button", { name: /New Competition/ }).click();
    await page.getByPlaceholder(/Klubbmästerskap/).fill(eventName);
    await page.getByRole("button", { name: "Create" }).click();
    await expect(page.getByRole("link", { name: "Dashboard" })).toBeVisible({
      timeout: 15_000,
    });

    await clickTab(page, "Classes");
    await page.getByTestId("classes-add-presets").click();
    await page.getByTestId("preset-check-all").check();
    await page.getByTestId("presets-apply").click();
    await expect(page.getByText("2 added, 0 skipped")).toBeVisible({
      timeout: 15_000,
    });

    const h21 = page.getByRole("row").filter({ hasText: "H21" }).first();
    await expect(h21).toContainText("Elite");
    await expect(h21).toContainText("Free start");
    await expect(h21).toContainText("No timing");
    await expect(h21).toContainText("Direct registration");
    await expect(h21).toContainText("Men");
    await h21.click();
    const detailNumbers = h21
      .locator("xpath=following-sibling::tr[1]")
      .locator('input[type="number"]');
    await expect(detailNumbers.nth(1)).toHaveValue("21");
    await expect(detailNumbers.nth(2)).toHaveValue("39");
    await expect(page.getByRole("row").filter({ hasText: "D21" }).first()).toBeVisible();

    await page.getByTestId("classes-add-presets").click();
    await expect(page.getByTestId("preset-check-H21")).toBeDisabled();
    await expect(page.getByTestId("preset-check-D21")).toBeDisabled();
    await page.getByRole("button", { name: "Cancel" }).click();

    await clickTab(page, "Courses");
    const chooserPromise = page.waitForEvent("filechooser");
    await page.getByTestId("map-panel").getByRole("button", { name: "Upload map" }).click();
    await (await chooserPromise).setFiles("e2e/test.ocd");
    await expect(page.getByTestId("map-viewer")).toBeVisible({ timeout: 60_000 });

    await clickTab(page, "Course Editor");
    await expect(page.getByTestId("course-editor-page")).toBeVisible({
      timeout: 15_000,
    });
    const suggestions = page.getByTestId("editor-new-course-suggestions");
    await expect(suggestions.locator('option[value="H21"]')).toHaveCount(1);
    await expect(suggestions.locator('option[value="D21"]')).toHaveCount(1);
    await page.getByTestId("editor-new-course-name").fill("H21");
    await page.getByTestId("editor-create-course").click();
    await expect(page.getByTestId("editor-sequence")).toBeVisible({
      timeout: 15_000,
    });

    await clickTab(page, "Classes");
    await expect(
      page.getByRole("row").filter({ hasText: "H21" }).first().getByText("H21", {
        exact: true,
      }),
    ).toHaveCount(2);
  });
});

async function addPreset(
  page: Page,
  name: string,
  values: {
    sex: "M" | "F";
    lowAge: string;
    highAge: string;
    type: string;
    noTiming?: boolean;
    freeStart?: boolean;
    quickEntry?: boolean;
    sortIndex: string;
  },
) {
  await page.getByTestId("preset-add-name").fill(name);
  await page.getByLabel("Sex").selectOption(values.sex);
  await page.getByLabel("Minimum age").fill(values.lowAge);
  await page.getByLabel("Maximum age").fill(values.highAge);
  await page.getByLabel("Type", { exact: true }).fill(values.type);
  if (values.noTiming) await page.getByLabel("No timing").check();
  if (values.freeStart) await page.getByLabel("Free start").check();
  if (values.quickEntry) await page.getByLabel("Direct registration").check();
  await page.getByLabel("Sort index").fill(values.sortIndex);
  await page.getByTestId("preset-add-submit").click();
  await expect(page.getByTestId(`preset-row-${name}`)).toBeVisible({
    timeout: 10_000,
  });
}

async function clickTab(page: Page, name: string) {
  const main = page
    .locator("nav[aria-label='Tabs']")
    .getByRole("link", { name, exact: true });
  if (await main.isVisible()) {
    await main.click();
  } else {
    await page.getByTestId("more-menu-button").click();
    await page
      .getByTestId("more-menu-content")
      .getByRole("link", { name, exact: true })
      .click();
  }
}
