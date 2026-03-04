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

test.describe("Courses Page", () => {
  test("should navigate to courses tab and display course list", async ({ page }) => {
    await selectCompetition(page);
    await clickTab(page, "Courses");
    expect(page.url()).toContain("/courses");

    await expect(page.getByText("3 courses")).toBeVisible({ timeout: 10000 });
    await expect(page.getByRole("cell", { name: "Bana 1" })).toBeVisible();
    await expect(page.getByRole("cell", { name: "Bana 2" })).toBeVisible();
    await expect(page.getByRole("cell", { name: "Bana 3" })).toBeVisible();
  });

  test("should expand a course to show details, class usage, and control sequence", async ({
    page,
  }) => {
    await selectCompetition(page);
    await clickTab(page, "Courses");
    await expect(page.getByText("3 courses")).toBeVisible({ timeout: 10000 });

    await page.getByRole("cell", { name: "Bana 2" }).click();

    await expect(page.getByText("Used by Classes")).toBeVisible({ timeout: 5000 });
    await expect(page.getByText("Öppen 2")).toBeVisible();
    await expect(page.locator("label", { hasText: "Name" })).toBeVisible();
    await expect(page.locator("label", { hasText: "Controls" })).toBeVisible();
    await expect(page.getByText("Control Sequence")).toBeVisible();
    expect(page.url()).toContain("course=2");
  });

  test("should deep link to courses page with expanded course", async ({ page }) => {
    await page.goto("/itest/courses?course=2");
    await expect(page.getByText("Used by Classes")).toBeVisible({ timeout: 15000 });
    await expect(page.getByText("Öppen 2")).toBeVisible();
  });

  test("should create and then delete a course", async ({ page }) => {
    await selectCompetition(page);
    await clickTab(page, "Courses");
    await expect(page.getByText("3 courses")).toBeVisible({ timeout: 10000 });

    await page.getByRole("button", { name: "New Course" }).click();
    await expect(
      page.getByRole("heading", { name: "New Course" }),
    ).toBeVisible({ timeout: 3000 });

    await page.getByPlaceholder("e.g. Bana 4").fill("Test Bana");
    await page.getByPlaceholder("e.g. 5200").fill("4500");
    await page.getByPlaceholder("e.g. 67;39;78;53;44;50;").fill("34;50;67;");
    await page.getByRole("button", { name: "Create" }).click();

    await expect(page.getByRole("cell", { name: "Test Bana" })).toBeVisible({ timeout: 5000 });
    await expect(page.getByText("4 courses")).toBeVisible({ timeout: 5000 });

    await page.getByPlaceholder("Search name, control code...").fill("Test Bana");
    await expect(page.getByText("1 course")).toBeVisible({ timeout: 5000 });
    page.on("dialog", (dialog) => dialog.accept());
    await page.getByTitle("Remove course").click();

    await expect(page.getByText("No courses found")).toBeVisible({ timeout: 5000 });
    await page.getByPlaceholder("Search name, control code...").clear();
    await expect(page.getByText("3 courses")).toBeVisible({ timeout: 5000 });
  });

  test("should import courses from OCAD OCD file", async ({ page }) => {
    await selectCompetition(page);
    await clickTab(page, "Courses");

    await page.getByRole("button", { name: "Import courses" }).click();
    await expect(page.getByText("Import Courses (IOF XML or OCAD OCD)")).toBeVisible();

    const fileChooserPromise = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "Browse files" }).click();
    const fileChooser = await fileChooserPromise;
    await fileChooser.setFiles("e2e/test.ocd");

    const errorMsg = page.locator(".text-red-700");
    await Promise.race([
      expect(page.getByText("Courses and Class Assignments")).toBeVisible({ timeout: 20000 }),
      expect(errorMsg).toBeVisible({ timeout: 20000 }).then(async () => {
        throw new Error("Preview failed: " + (await errorMsg.innerText()));
      }),
    ]);

    await expect(page.getByRole("cell", { name: "A", exact: true })).toBeVisible();
    await expect(page.getByRole("cell", { name: "E", exact: true })).toBeVisible();

    await page.getByRole("button", { name: "Import 5 courses" }).click();
    await expect(page.getByText("Import Complete")).toBeVisible({ timeout: 15000 });
    await expect(page.getByText("5 courses created")).toBeVisible();

    await page.getByRole("button", { name: "Done" }).click();
    await expect(page.getByText("8 courses")).toBeVisible({ timeout: 5000 });
  });
});
