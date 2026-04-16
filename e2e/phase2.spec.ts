import { test, expect } from "@playwright/test";

async function selectCompetition(page: import("@playwright/test").Page) {
  await page.goto("/");
  await page.getByText("My example tävling").click();
  await expect(page.getByRole("link", { name: "Dashboard" })).toBeVisible({
    timeout: 10000,
  });
}

async function goToTab(page: import("@playwright/test").Page, name: string) {
  await selectCompetition(page);
  const mainTab = page.locator("nav[aria-label='Tabs']").getByRole("link", { name, exact: true });
  if (await mainTab.isVisible()) {
    await mainTab.click();
  } else {
    await page.getByTestId("more-menu-button").click();
    await page.getByTestId("more-menu-content").getByRole("link", { name, exact: true }).click();
  }
}

test.describe("Tab Navigation", () => {
  test("should display all navigation tabs", async ({ page }) => {
    await selectCompetition(page);

    await expect(page.getByRole("link", { name: "Dashboard" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Runners", exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "Start List" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Results" })).toBeVisible();

    // Event is in More menu
    await expect(page.getByRole("link", { name: "Event", exact: true })).not.toBeVisible();
    await page.getByTestId("more-menu-button").click();
    await expect(
      page.getByTestId("more-menu-content").getByRole("link", { name: "Event", exact: true }),
    ).toBeVisible();
  });

  test("should switch between tabs", async ({ page }) => {
    await selectCompetition(page);

    await goToTab(page, "Runners");
    await expect(page.getByText("Add Runner")).toBeVisible({ timeout: 5000 });

    await goToTab(page, "Start List");
    await expect(
      page.getByRole("heading", { name: "Start List" }),
    ).toBeVisible({ timeout: 5000 });

    await goToTab(page, "Results");
    await expect(
      page.getByRole("heading", { name: "Results" }),
    ).toBeVisible({ timeout: 5000 });
  });
});

test.describe("Runner Management", () => {
  test("should display runner list with search and filters", async ({ page }) => {
    await goToTab(page, "Runners");

    await expect(page.getByPlaceholder("Search name, club, or card...")).toBeVisible();
    await expect(page.getByText("Add Runner")).toBeVisible();
    await expect(page.getByText("Monica Henriksson")).toBeVisible({ timeout: 10000 });
    await expect(page.locator("span", { hasText: "runners" })).toBeVisible();
  });

  test("should create, edit, and delete a runner", async ({ page }) => {
    await goToTab(page, "Runners");
    await expect(page.locator("span", { hasText: "runners" })).toBeVisible({ timeout: 10000 });

    // CREATE (via RegistrationDialog)
    await page.getByRole("button", { name: "Add Runner" }).click();
    await expect(page.getByTestId("registration-dialog")).toBeVisible({ timeout: 3000 });
    await expect(
      page.getByRole("heading", { name: "Register Runner" }),
    ).toBeVisible({ timeout: 3000 });

    const dialog = page.getByTestId("registration-dialog");
    await dialog.locator("input[placeholder='First Last']").fill("Test Runner E2E");
    await dialog.getByTestId("reg-class").click();
    await expect(dialog.getByText("Öppen 1", { exact: true })).toBeVisible({ timeout: 3000 });
    await dialog.getByText("Öppen 1", { exact: true }).click();
    await dialog.locator("input[placeholder='e.g. 500123']").fill("999999");
    await dialog.getByTestId("reg-submit").click();

    await expect(page.getByText("Test Runner E2E")).toBeVisible({ timeout: 5000 });

    // EDIT (inline autosave)
    await page.getByRole("cell", { name: "Test Runner E2E" }).click();
    const expandedPanel = page.locator(".bg-blue-50\\/60");
    await expect(expandedPanel).toBeVisible({ timeout: 3000 });

    const nameInput = expandedPanel.locator("input").first();
    await nameInput.clear();
    await nameInput.fill("Test Runner Updated");
    await expect(page.getByText("Saved")).toBeVisible({ timeout: 3000 });

    await page.getByRole("cell", { name: "Test Runner Updated", exact: true }).first().click();
    await expect(expandedPanel).not.toBeVisible({ timeout: 3000 });

    // DELETE
    page.on("dialog", (dialog) => dialog.accept());
    const updatedRow = page.locator("tr").filter({ hasText: "Test Runner Updated" }).first();
    await updatedRow.getByTitle("Remove runner").click();
    await expect(page.getByText("Test Runner Updated")).not.toBeVisible({ timeout: 5000 });
    await expect(page.locator("span", { hasText: "runners" })).toBeVisible();
  });

  test("should not wipe other fields when updating a single field via API", async ({
    page,
  }) => {
    await selectCompetition(page);

    const compHeaders = { "x-competition-id": "itest" };
    const getBefore = await page.request.get(
      `/trpc/runner.getById?batch=1&input=${encodeURIComponent(JSON.stringify({ "0": { id: 1 } }))}`,
      { headers: compHeaders },
    );
    const beforeData = (await getBefore.json())[0].result.data;
    expect(beforeData.clubId).toBeGreaterThan(0);
    expect(beforeData.cardNo).toBeGreaterThan(0);

    await page.request.post(`/trpc/runner.update?batch=1`, {
      headers: compHeaders,
      data: { "0": { id: 1, data: { name: "Monica Temp Name" } } },
    });

    const getAfter = await page.request.get(
      `/trpc/runner.getById?batch=1&input=${encodeURIComponent(JSON.stringify({ "0": { id: 1 } }))}`,
      { headers: compHeaders },
    );
    const afterData = (await getAfter.json())[0].result.data;
    expect(afterData.name).toBe("Monica Temp Name");
    expect(afterData.clubId).toBe(beforeData.clubId);
    expect(afterData.cardNo).toBe(beforeData.cardNo);
    expect(afterData.classId).toBe(beforeData.classId);

    // Restore
    await page.request.post(`/trpc/runner.update?batch=1`, {
      headers: compHeaders,
      data: { "0": { id: 1, data: { name: beforeData.name } } },
    });
  });

  test("should not wipe club when changing class via API", async ({ page }) => {
    await selectCompetition(page);

    const compHeaders = { "x-competition-id": "itest" };
    const getBefore = await page.request.get(
      `/trpc/runner.getById?batch=1&input=${encodeURIComponent(JSON.stringify({ "0": { id: 1 } }))}`,
      { headers: compHeaders },
    );
    const before = (await getBefore.json())[0].result.data;
    expect(before.clubId).toBeGreaterThan(0);

    const newClassId = before.classId === 1 ? 2 : 1;
    await page.request.post(`/trpc/runner.update?batch=1`, {
      headers: compHeaders,
      data: { "0": { id: 1, data: { classId: newClassId } } },
    });

    const getAfter = await page.request.get(
      `/trpc/runner.getById?batch=1&input=${encodeURIComponent(JSON.stringify({ "0": { id: 1 } }))}`,
      { headers: compHeaders },
    );
    const after = (await getAfter.json())[0].result.data;
    expect(after.classId).toBe(newClassId);
    expect(after.clubId).toBe(before.clubId);
    expect(after.cardNo).toBe(before.cardNo);

    // Restore
    await page.request.post(`/trpc/runner.update?batch=1`, {
      headers: compHeaders,
      data: { "0": { id: 1, data: { classId: before.classId } } },
    });
  });
});

test.describe("Start List", () => {
  test("should display start list grouped by class", async ({ page }) => {
    await goToTab(page, "Start List");

    await expect(
      page.locator("h3", { hasText: "Öppen 1" }),
    ).toBeVisible({ timeout: 10000 });
    await expect(page.locator("h3", { hasText: "Öppen 2" })).toBeVisible();
    await expect(page.locator("h3", { hasText: "Öppen 3" })).toBeVisible();
    await expect(page.getByText("Monica Henriksson")).toBeVisible();

    const table = page.locator("table").first();
    await expect(table.getByText("Start Time")).toBeVisible();
    await expect(table.getByText("Start #")).toBeVisible();
  });
});

test.describe("Results", () => {
  test("should display results grouped by class with places and time behind", async ({
    page,
  }) => {
    await goToTab(page, "Results");

    await expect(
      page.locator("h3", { hasText: "Öppen 1" }),
    ).toBeVisible({ timeout: 10000 });
    await expect(page.locator("h3", { hasText: "Öppen 2" })).toBeVisible();
    await expect(page.locator("h3", { hasText: "Öppen 3" })).toBeVisible();

    const table = page.locator("table").first();
    await expect(table.getByText("Place")).toBeVisible();
    await expect(table.getByText("Time")).toBeVisible();
    await expect(table.getByText("Behind")).toBeVisible();

    // Should show OK and MP badges
    await expect(page.locator("span", { hasText: "OK" }).first()).toBeVisible();
    await expect(page.locator("span", { hasText: "MP" }).first()).toBeVisible();

    // Non-leaders should show +time
    const timeBehind = page.locator("td", { hasText: /^\+\d+:\d+$/ });
    await expect(timeBehind.first()).toBeVisible();
  });
});
