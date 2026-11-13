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

test.describe("Classes Page", () => {
  test("should expand class to show details, course dropdown, and runner list", async ({
    page,
  }) => {
    await selectCompetition(page);
    await clickTab(page, "Classes");
    expect(page.url()).toContain("/classes");

    await expect(page.getByText("3 classes")).toBeVisible({ timeout: 10000 });
    await expect(page.getByRole("cell", { name: "Öppen 1" })).toBeVisible();
    await expect(page.getByRole("cell", { name: "Öppen 2" })).toBeVisible();
    await expect(page.getByRole("cell", { name: "Öppen 3" })).toBeVisible();

    await page.getByRole("cell", { name: "Öppen 2" }).click();
    await expect(page.getByText("Class Settings")).toBeVisible({ timeout: 5000 });

    await expect(page.locator("label", { hasText: "Name" })).toBeVisible();
    await expect(page.locator("label", { hasText: "Sex" })).toBeVisible();

    // The course picker is a dropdown trigger — the assigned course
    // name (Bana 2) shows as the trigger label. Open the dropdown to
    // verify checkbox state for both courses.
    const expandedPanel = page.locator(".bg-blue-50\\/60");
    const trigger = expandedPanel.getByRole("button", { name: "Bana 2" });
    await expect(trigger).toBeVisible();
    await trigger.click();
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
    // Open the course dropdown (placeholder text when nothing selected),
    // then tick Bana 1 inside the popover.
    await createForm.getByRole("button", { name: "Select courses..." }).click();
    await createForm
      .locator("label", { hasText: "Bana 1" })
      .locator("input[type='checkbox']")
      .check();
    // Close the dropdown so it doesn't intercept clicks on the
    // Create button below it.
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Create" }).click();

    await expect(page.getByRole("cell", { name: "Test Klass" })).toBeVisible({ timeout: 5000 });
    await expect(page.getByText("4 classes")).toBeVisible({ timeout: 5000 });

    const search = page.getByPlaceholder("Search class or course name...");
    await search.fill("Test Klass");
    await search.press("Enter");
    await expect(page.getByText("1 class")).toBeVisible({ timeout: 5000 });
    page.on("dialog", (dialog) => dialog.accept());
    await page.getByTitle("Remove class").click();

    await expect(page.getByText("No classes found")).toBeVisible({ timeout: 5000 });
    await page.getByLabel("Clear all filters").click();
    await expect(page.getByText("3 classes")).toBeVisible({ timeout: 5000 });
  });

  test("should show drag handles and hide them when filtering", async ({ page }) => {
    await selectCompetition(page);
    await clickTab(page, "Classes");
    await expect(page.getByText("3 classes")).toBeVisible({ timeout: 10000 });

    const handles = page.getByLabel("Drag to reorder");
    await expect(handles).toHaveCount(3);
    await expect(page.getByText("drag to reorder")).toBeVisible();

    const search = page.getByPlaceholder("Search class or course name...");
    await search.fill("Öppen 1");
    await search.press("Enter");
    await expect(page.getByText("1 class")).toBeVisible({ timeout: 5000 });
    await expect(page.getByLabel("Drag to reorder")).toHaveCount(0);

    await page.getByLabel("Clear all filters").click();
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
    await page.mouse.up();

    // Wait for the reorder to complete and the UI to update
    const rowsAfter = page.locator("tbody tr").filter({ hasNotText: "Class Settings" });
    await expect(rowsAfter.nth(0)).toContainText("Öppen 3", { timeout: 5000 });

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
    // Open the course dropdown (Öppen 3 has Bana 3 assigned).
    await expandedPanel.getByRole("button", { name: "Bana 3" }).click();
    await expandedPanel
      .locator("label", { hasText: "Bana 1" })
      .locator("input[type='checkbox']")
      .check();

    await expect(expandedPanel.getByText(/Forked/)).toBeVisible({ timeout: 5000 });
    await expect(page.getByText("Forked").first()).toBeVisible();

    // Clean up — uncheck inside the still-open dropdown
    await expandedPanel
      .locator("label", { hasText: "Bana 1" })
      .locator("input[type='checkbox']")
      .uncheck();
    // Wait for the forked badge to disappear after unchecking
    await expect(expandedPanel.getByText(/Forked/)).not.toBeVisible({ timeout: 5000 });
  });

  test("runners in a class on a forked course carry pre-set variants (F6b)", async ({ page }) => {
    const headers = { "x-competition-id": "itest" };
    const post = async (path: string, data: unknown) => {
      const res = await page.request.post(`/trpc/${path}`, { headers, data });
      expect(res.ok(), `${path}: ${await res.text()}`).toBe(true);
      return (await res.json()).result.data;
    };
    const stamp = Date.now();
    const controls: number[] = [];
    for (const [i, code] of [191, 192, 193, 194].entries()) {
      controls.push((await post("control.create", { codes: String(code), xpos: 20 + i * 10, ypos: 20 })).id as number);
    }
    const root = (await post("course.create", { name: `E2E Variants ${stamp}` })).id as number;
    await post("course.setStructure", {
      courseId: root,
      structure: {
        version: 1,
        id: "fork",
        orderMode: "ordered",
        items: [
          { siteId: 191 },
          { kind: "variation", id: "g", alternatives: [{ label: "A", items: [{ siteId: 192 }] }, { label: "B", items: [{ siteId: 193 }] }] },
          { siteId: 194 },
        ],
      },
    });
    const className = `E2E V ${stamp}`;
    const classId = (await post("class.create", { name: className, courseId: root })).id as number;
    // Created out of start order: the creation-time picks (A, B, A) are not
    // the start-order deal (A, B, A over 10:00, 10:02, 10:04).
    const names = [`Vera First ${stamp}`, `Vera Second ${stamp}`, `Vera Third ${stamp}`];
    const runners: number[] = [];
    for (const i of [0, 2, 1]) {
      runners[i] = (await post("runner.create", { name: names[i], classId, startTime: 360000 + i * 1200 })).id as number;
    }

    const variantOf = (name: string) =>
      page.getByRole("row").filter({ hasText: name }).getByTestId("start-list-variant");

    try {
      // Every runner has a variant from the moment she is entered.
      await page.goto(`/itest/classes?classId=${classId}`);
      await expect(page.getByTestId("class-variants")).toBeVisible({ timeout: 15000 });
      await expect(page.getByTestId("class-variant-A-count")).toHaveText("2 runners");
      await expect(page.getByTestId("class-variant-B-count")).toHaveText("1 runner");

      // Distribute in start order over every runner (confirmed).
      await page.getByTestId("distribute-only-unassigned").uncheck();
      page.once("dialog", (d) => d.accept());
      await page.getByTestId("distribute-variants").click();
      await expect(page.getByTestId("distribute-result")).toContainText("runners changed", { timeout: 10000 });

      await page.goto("/itest/startlist");
      await expect(variantOf(names[0])).toHaveText("A", { timeout: 15000 });
      await expect(variantOf(names[1])).toHaveText("B");
      await expect(variantOf(names[2])).toHaveText("A");

      // The desk changes one runner's variant by hand.
      await page.goto(`/itest/runners?q=${encodeURIComponent(names[1])}`);
      await page.getByRole("cell", { name: names[1] }).click();
      const select = page.getByTestId("runner-variant");
      await expect(select).toBeVisible({ timeout: 10000 });
      await expect(select.locator("option:checked")).toHaveText("B");
      await select.selectOption({ label: "A" });
      await expect(select.locator("option:checked")).toHaveText("A");

      await page.goto("/itest/startlist");
      await expect(variantOf(names[1])).toHaveText("A", { timeout: 15000 });
    } finally {
      for (const id of runners) await post("runner.delete", { id });
      await post("class.delete", { id: classId });
      await post("course.delete", { id: root });
      for (const id of controls) await post("control.delete", { id });
    }
  });
});
