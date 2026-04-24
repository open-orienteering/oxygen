import { test, expect } from "@playwright/test";

async function selectCompetition(page: import("@playwright/test").Page) {
  await page.goto("/");
  await page.getByText("My example tävling").click();
  await expect(page.getByRole("link", { name: "Dashboard" })).toBeVisible({
    timeout: 10000,
  });
}

async function clickTab(page: import("@playwright/test").Page, name: string) {
  const mainTab = page.locator("nav[aria-label='Tabs']").getByRole("link", { name, exact: true });
  if (await mainTab.isVisible()) {
    await mainTab.click();
  } else {
    await page.getByTestId("more-menu-button").click();
    await page.getByTestId("more-menu-content").getByRole("link", { name, exact: true }).click();
  }
}

test.describe("Controls Page", () => {
  test("should navigate to controls tab and display control list", async ({ page }) => {
    await selectCompetition(page);
    await clickTab(page, "Controls");
    expect(page.url()).toContain("/controls");

    await expect(page.getByText("23 controls")).toBeVisible({ timeout: 10000 });
    await expect(page.getByRole("cell", { name: "Radio 1" })).toBeVisible();
    await expect(page.getByRole("cell", { name: "Radio 2" })).toBeVisible();
    await expect(page.getByRole("cell", { name: "Pre-start" })).toBeVisible();
  });

  test("should expand a control to show course usage and editable fields", async ({
    page,
  }) => {
    await selectCompetition(page);
    await clickTab(page, "Controls");
    await expect(page.getByText("23 controls")).toBeVisible({ timeout: 10000 });

    await page.getByRole("cell", { name: "Radio 1" }).click();

    await expect(page.getByText("Used in Courses")).toBeVisible({ timeout: 5000 });
    await expect(page.getByText("Bana 1")).toBeVisible();
    await expect(page.getByText("Bana 2")).toBeVisible();
    await expect(page.getByText("Bana 3")).toBeVisible();
    await expect(page.locator("label", { hasText: "Name" })).toBeVisible();
    await expect(page.locator("label", { hasText: "Punch Code(s)" })).toBeVisible();
    expect(page.url()).toContain("control=50");
  });

  test("should deep link to controls with expanded control", async ({ page }) => {
    await page.goto("/itest/controls?control=50");
    await expect(page.getByText("Used in Courses")).toBeVisible({ timeout: 15000 });
    await expect(page.getByText("Bana 1")).toBeVisible();
  });

  test("should show bulk action bar when selecting controls", async ({ page }) => {
    await selectCompetition(page);
    await clickTab(page, "Controls");
    await expect(page.getByText("23 controls")).toBeVisible({ timeout: 10000 });

    // Select two controls via their row checkboxes. The Controls table's
    // checkboxes are unlabeled, so grab them by position inside the row.
    const radio1Row = page.getByRole("row").filter({ hasText: "Radio 1" });
    const radio2Row = page.getByRole("row").filter({ hasText: "Radio 2" });
    await radio1Row.getByRole("checkbox").check();
    await radio2Row.getByRole("checkbox").check();

    // Bulk bar appears with the right count + the existing radio/AIR+ dropdowns
    await expect(page.getByText("2 selected")).toBeVisible();
    await expect(page.getByRole("combobox", { name: /Set Radio Type/i }).or(
      page.locator("select").filter({ hasText: "Set Radio Type" }),
    )).toBeVisible();

    // Clear selection dismisses the bar
    await page.getByRole("button", { name: "Clear selection" }).click();
    await expect(page.getByText("2 selected")).not.toBeVisible();
  });

  test("should create and then delete a control", async ({ page }) => {
    await selectCompetition(page);
    await clickTab(page, "Controls");
    await expect(page.getByText("23 controls")).toBeVisible({ timeout: 10000 });

    await page.getByRole("button", { name: "New Control" }).click();
    await expect(
      page.getByRole("heading", { name: "New Control" }),
    ).toBeVisible({ timeout: 3000 });

    await page.getByPlaceholder("e.g. 50 or 50;250").fill("999");
    await page.getByPlaceholder("e.g. Radio 1 (optional)").fill("Test Control");
    await page.getByRole("button", { name: "Create" }).click();

    await expect(page.getByRole("cell", { name: "Test Control" })).toBeVisible({ timeout: 5000 });
    await expect(page.getByText("24 controls")).toBeVisible({ timeout: 5000 });

    await page.getByPlaceholder("Search code, name...").fill("999");
    await expect(page.getByText("1 controls")).toBeVisible({ timeout: 5000 });
    page.on("dialog", (dialog) => dialog.accept());
    await page.getByTitle("Remove control").click();

    await expect(page.getByText("No controls found")).toBeVisible({ timeout: 5000 });
    await page.getByPlaceholder("Search code, name...").clear();
    await expect(page.getByText("23 controls")).toBeVisible({ timeout: 5000 });
  });
});
