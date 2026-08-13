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

    const search = page.getByPlaceholder("Search name, control code...");
    await search.fill("Test Bana");
    await search.press("Enter");
    await expect(page.getByText("1 course")).toBeVisible({ timeout: 5000 });
    page.on("dialog", (dialog) => dialog.accept());
    await page.getByTitle("Remove course").click();

    await expect(page.getByText("No courses found")).toBeVisible({ timeout: 5000 });
    await page.getByLabel("Clear all filters").click();
    await expect(page.getByText("3 courses")).toBeVisible({ timeout: 5000 });
  });

  test("should bulk-update maps across many selected courses", async ({ page }) => {
    await selectCompetition(page);
    await clickTab(page, "Courses");
    await expect(page.getByText("3 courses")).toBeVisible({ timeout: 10000 });

    // Select two rows by their row checkboxes. The checkboxes themselves are
    // unlabeled (by design — see controls.spec.ts for the same pattern), so
    // we find them via the row they live in.
    const bana1Row = page.getByRole("row").filter({ hasText: "Bana 1" });
    const bana2Row = page.getByRole("row").filter({ hasText: "Bana 2" });
    const bana3Row = page.getByRole("row").filter({ hasText: "Bana 3" });
    await bana1Row.getByRole("checkbox").check();
    await bana2Row.getByRole("checkbox").check();

    // Floating bulk bar appears with the right count ("2 selected")
    await expect(page.getByText("selected").first()).toBeVisible();
    await expect(page.getByText("2", { exact: true })).toBeVisible();

    // Field is already "Maps" by default — type a new value and apply
    page.on("dialog", (d) => d.accept()); // confirm() popup
    await page.getByTestId("bulk-value-input").fill("7");
    await page.getByRole("button", { name: "Apply" }).click();

    // The two edited rows reflect the new value; the untouched row does not
    await expect(bana1Row.getByRole("cell", { name: "7", exact: true })).toBeVisible({ timeout: 5000 });
    await expect(bana2Row.getByRole("cell", { name: "7", exact: true })).toBeVisible({ timeout: 5000 });
    await expect(bana3Row.getByRole("cell", { name: "7", exact: true })).not.toBeVisible();

    // Applying clears the selection, which hides the bar again
    await expect(page.getByRole("button", { name: "Apply" })).not.toBeVisible();

    // Revert to 1 map so later tests / screenshots aren't polluted by this run
    await bana1Row.getByRole("checkbox").check();
    await bana2Row.getByRole("checkbox").check();
    await page.getByTestId("bulk-value-input").fill("1");
    await page.getByRole("button", { name: "Apply" }).click();
    await expect(bana1Row.getByRole("cell", { name: "1", exact: true })).toBeVisible({ timeout: 5000 });
  });

  test("should import courses from OCAD OCD file (Replace-all default; toggle off to append)", async ({ page }) => {
    await selectCompetition(page);
    await clickTab(page, "Courses");
    await expect(page.getByText("3 courses")).toBeVisible({ timeout: 10000 });

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

    // test.ocd has no class-assignment records, so the preview falls
    // back to suggesting classes from course names: the banner explains
    // this, and every course row gets a mapping dropdown (course name
    // appears in both the Name and XML Class columns).
    await expect(page.getByTestId("course-import-fallback-banner")).toBeVisible();
    await expect(page.getByRole("cell", { name: "A", exact: true })).toHaveCount(2);
    // Unmatched fallback rows get a usable dropdown defaulting to Skip
    // (before the fallback these courses had no dropdown at all).
    await expect(page.getByRole("button", { name: "— Skip —" }).first()).toBeVisible();
    // Course "E" substring-matches the seed class "Öppen 1" (normalized
    // "öppen1" contains "e"), so its dropdown is pre-filled with the
    // heuristic suggestion.
    const eDropdown = page.getByRole("button", { name: "Öppen 1" });
    await expect(eDropdown).toBeVisible();
    // Reset it to Skip via the dropdown: later spec files rely on the
    // seed class→course assignments, so this append import must not
    // steal Öppen 1 from Bana 1.
    await eDropdown.click();
    await page
      .getByRole("row", { name: /^E / })
      .getByRole("button", { name: "— Skip —", exact: true })
      .click();
    await expect(page.getByRole("button", { name: "Öppen 1" })).not.toBeVisible();

    // The replace-all toggle defaults to ON; assert that, then turn it
    // off so this test still appends to the seed data (3 + 5 = 8).
    // Wiping the seed courses here would break later spec files that
    // depend on Bana 2 — the destructive path is covered in the
    // course-import integration test instead.
    const replaceAll = page.getByTestId("course-import-replace-all");
    await expect(replaceAll).toBeChecked();
    await replaceAll.uncheck();

    await page.getByRole("button", { name: "Import 5 courses" }).click();
    await expect(page.getByText("Import Complete")).toBeVisible({ timeout: 15000 });
    await expect(page.getByText("5 courses created")).toBeVisible();

    await page.getByRole("button", { name: "Done" }).click();
    await expect(page.getByText("8 courses")).toBeVisible({ timeout: 5000 });
  });
});
