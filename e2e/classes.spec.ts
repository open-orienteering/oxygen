import { test, expect } from "@playwright/test";

async function selectCompetition(page: import("@playwright/test").Page) {
  await page.goto("/");
  await page.getByText("My example tävling").click();
  await expect(page.getByRole("button", { name: "Dashboard" })).toBeVisible({
    timeout: 10000,
  });
}

async function clickTab(page: import("@playwright/test").Page, name: string) {
  const mainTab = page.locator("nav[aria-label='Tabs']").getByRole("button", { name, exact: true });
  if (await mainTab.isVisible()) {
    await mainTab.click();
  } else {
    await page.getByTestId("more-menu-button").click();
    await page.getByTestId("more-menu-content").getByRole("button", { name, exact: true }).click();
  }
}

test.describe("Classes Page", () => {
  test("should navigate to classes tab and display class list", async ({ page }) => {
    await selectCompetition(page);
    await clickTab(page, "Classes");
    expect(page.url()).toContain("/classes");

    await expect(page.getByText("3 classes")).toBeVisible({ timeout: 10000 });
    await expect(page.getByRole("cell", { name: "Öppen 1" })).toBeVisible();
    await expect(page.getByRole("cell", { name: "Öppen 2" })).toBeVisible();
    await expect(page.getByRole("cell", { name: "Öppen 3" })).toBeVisible();
  });

  test("should expand class to show details, course checkboxes, and runner list", async ({
    page,
  }) => {
    await selectCompetition(page);
    await clickTab(page, "Classes");
    await expect(page.getByText("3 classes")).toBeVisible({ timeout: 10000 });

    await page.getByRole("cell", { name: "Öppen 2" }).click();
    await expect(page.getByText("Class Settings")).toBeVisible({ timeout: 5000 });

    await expect(page.locator("label", { hasText: "Name" })).toBeVisible();
    await expect(page.locator("label", { hasText: "Sex" })).toBeVisible();

    // Course checkboxes — Bana 2 checked, others not
    const expandedPanel = page.locator(".bg-blue-50\\/60");
    const bana2Checkbox = expandedPanel
      .locator("label", { hasText: "Bana 2" })
      .locator("input[type='checkbox']");
    await expect(bana2Checkbox).toBeChecked();
    const bana1Checkbox = expandedPanel
      .locator("label", { hasText: "Bana 1" })
      .locator("input[type='checkbox']");
    await expect(bana1Checkbox).not.toBeChecked();

    await expect(page.getByText("Runners (14)")).toBeVisible();
    expect(page.url()).toContain("classId=2");
  });

  test("should deep link to classes page with expanded class", async ({ page }) => {
    await page.goto("/itest/classes?classId=3");
    await expect(page.getByText("Class Settings")).toBeVisible({ timeout: 15000 });
    await expect(page.getByText("Runners (15)")).toBeVisible();
  });

  test("should create and then delete a class", async ({ page }) => {
    await selectCompetition(page);
    await clickTab(page, "Classes");
    await expect(page.getByText("3 classes")).toBeVisible({ timeout: 10000 });

    await page.getByRole("button", { name: "New Class" }).click();
    await expect(
      page.getByRole("heading", { name: "New Class" }),
    ).toBeVisible({ timeout: 3000 });

    await page.getByPlaceholder("e.g. H21").fill("Test Klass");
    const createForm = page.locator("form").first();
    await createForm
      .locator("label", { hasText: "Bana 1" })
      .locator("input[type='checkbox']")
      .check();
    await page.getByRole("button", { name: "Create" }).click();

    await expect(page.getByRole("cell", { name: "Test Klass" })).toBeVisible({ timeout: 5000 });
    await expect(page.getByText("4 classes")).toBeVisible({ timeout: 5000 });

    await page.getByPlaceholder("Search class or course name...").fill("Test Klass");
    await expect(page.getByText("1 class")).toBeVisible({ timeout: 5000 });
    page.on("dialog", (dialog) => dialog.accept());
    await page.getByTitle("Remove class").click();

    await expect(page.getByText("No classes found")).toBeVisible({ timeout: 5000 });
    await page.getByPlaceholder("Search class or course name...").clear();
    await expect(page.getByText("3 classes")).toBeVisible({ timeout: 5000 });
  });

  test("should show drag handles and hide them when filtering", async ({ page }) => {
    await selectCompetition(page);
    await clickTab(page, "Classes");
    await expect(page.getByText("3 classes")).toBeVisible({ timeout: 10000 });

    const handles = page.getByLabel("Drag to reorder");
    await expect(handles).toHaveCount(3);
    await expect(page.getByText("drag to reorder")).toBeVisible();

    await page.getByPlaceholder("Search class or course name...").fill("Öppen 1");
    await expect(page.getByText("1 class")).toBeVisible({ timeout: 5000 });
    await expect(page.getByLabel("Drag to reorder")).toHaveCount(0);

    await page.getByPlaceholder("Search class or course name...").clear();
    await expect(page.getByText("3 classes")).toBeVisible({ timeout: 5000 });
    await expect(handles).toHaveCount(3);
  });

  test("should reorder classes via drag and drop", async ({ page }) => {
    await selectCompetition(page);

    await page.request.post("/trpc/class.reorder", {
      data: {
        items: [
          { id: 1, sortIndex: 10 },
          { id: 2, sortIndex: 20 },
          { id: 3, sortIndex: 30 },
        ],
      },
    });

    await clickTab(page, "Classes");
    await expect(page.getByText("3 classes")).toBeVisible({ timeout: 10000 });

    const rows = page.locator("tbody tr").filter({ hasNotText: "Class Settings" });
    await expect(rows.nth(0)).toContainText("Öppen 1");
    await expect(rows.nth(1)).toContainText("Öppen 2");
    await expect(rows.nth(2)).toContainText("Öppen 3");

    const handle3 = page.getByLabel("Drag to reorder").nth(2);
    const handle1 = page.getByLabel("Drag to reorder").nth(0);
    const targetBox = await handle1.boundingBox();
    const sourceBox = await handle3.boundingBox();
    if (!targetBox || !sourceBox) throw new Error("Could not get bounding boxes");

    await page.mouse.move(sourceBox.x + sourceBox.width / 2, sourceBox.y + sourceBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(
      targetBox.x + targetBox.width / 2,
      targetBox.y + targetBox.height / 2 - 5,
      { steps: 20 },
    );
    await page.waitForTimeout(100);
    await page.mouse.up();
    await page.waitForTimeout(1500);

    const rowsAfter = page.locator("tbody tr").filter({ hasNotText: "Class Settings" });
    await expect(rowsAfter.nth(0)).toContainText("Öppen 3");

    // Restore original order
    await page.request.post("/trpc/class.reorder", {
      data: {
        items: [
          { id: 1, sortIndex: 10 },
          { id: 2, sortIndex: 20 },
          { id: 3, sortIndex: 30 },
        ],
      },
    });
  });

  test("should show forked badge when multiple courses are selected", async ({ page }) => {
    await selectCompetition(page);
    await clickTab(page, "Classes");
    await expect(page.getByText("3 classes")).toBeVisible({ timeout: 10000 });

    await page.getByRole("cell", { name: "Öppen 3" }).click();
    await expect(page.getByText("Class Settings")).toBeVisible({ timeout: 5000 });

    const expandedPanel = page.locator(".bg-blue-50\\/60");
    await expandedPanel
      .locator("label", { hasText: "Bana 1" })
      .locator("input[type='checkbox']")
      .check();

    await expect(expandedPanel.getByText(/Forked/)).toBeVisible({ timeout: 5000 });
    await expect(page.getByText("Forked").first()).toBeVisible();

    // Clean up
    await expandedPanel
      .locator("label", { hasText: "Bana 1" })
      .locator("input[type='checkbox']")
      .uncheck();
    await page.waitForTimeout(1000);
  });
});
