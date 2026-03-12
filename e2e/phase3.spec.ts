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

async function pickSelect(
  container: import("@playwright/test").Locator | import("@playwright/test").Page,
  testId: string,
  optionText: string,
) {
  const select = container.locator(`[data-testid="${testId}"]`);
  await select.locator("button").first().click();
  await select.getByRole("button", { name: optionText }).click();
}

test.describe("Inline Runner Expand", () => {
  test("should expand runner inline with editable fields", async ({ page }) => {
    await selectCompetition(page);
    await clickTab(page, "Runners");
    await expect(page.getByRole("cell", { name: "Monica Henriksson" }).first()).toBeVisible({
      timeout: 10000,
    });

    await page.getByRole("cell", { name: "Monica Henriksson" }).first().click();

    await expect(page.locator("label", { hasText: "Name" })).toBeVisible({ timeout: 3000 });
    await expect(page.locator("label", { hasText: "Class" })).toBeVisible();
    await expect(page.locator("label", { hasText: "SI Card" })).toBeVisible();

    const expandedPanel = page.locator(".bg-blue-50\\/60");
    await expect(expandedPanel.locator("input").first()).toHaveValue("Monica Henriksson");

    // Collapse
    await page.getByRole("cell", { name: "Monica Henriksson" }).first().click();
    await expect(page.locator("label", { hasText: "SI Card" })).not.toBeVisible({ timeout: 3000 });
  });

  test("should show editable punch data in expanded inline runner detail", async ({
    page,
  }) => {
    await selectCompetition(page);
    await clickTab(page, "Runners");
    await expect(page.getByRole("cell", { name: "Malin Johannesson" }).first()).toBeVisible({
      timeout: 10000,
    });

    await page.getByRole("cell", { name: "Malin Johannesson" }).first().click();
    await expect(page.locator("label", { hasText: "Name" })).toBeVisible({ timeout: 3000 });

    const expandedPanel = page.locator(".bg-blue-50\\/60");
    await expect(expandedPanel.getByText("Punches")).toBeVisible({ timeout: 5000 });
    await expect(expandedPanel.locator("th", { hasText: "Control" })).toBeVisible();
    await expect(expandedPanel.locator("th", { hasText: "Split" })).toBeVisible();
    await expect(expandedPanel.getByText("+ Add Punch Correction")).toBeVisible();
  });
});

test.describe("Card Readout", () => {
  test("should show result for known runner with punch table", async ({ page }) => {
    await selectCompetition(page);
    await clickTab(page, "Card Readout");
    await expect(page.getByPlaceholder("Enter SI card number...")).toBeVisible({
      timeout: 5000,
    });

    await page.getByPlaceholder("Enter SI card number...").fill("501438");

    await expect(page.getByText("Malin Johannesson")).toBeVisible({ timeout: 5000 });
    await expect(page.locator("[data-testid='readout-status']")).toBeVisible();
    await expect(page.getByText("Punches")).toBeVisible({ timeout: 3000 });
    await expect(page.locator("th", { hasText: "Control" })).toBeVisible();
    await expect(page.locator("th", { hasText: "Split" })).toBeVisible();
    await expect(page.locator("th", { hasText: "Cumulative" })).toBeVisible();
  });

  test("should show missing punch for MP runner", async ({ page }) => {
    await selectCompetition(page);
    await clickTab(page, "Card Readout");
    await expect(page.getByPlaceholder("Enter SI card number...")).toBeVisible({
      timeout: 5000,
    });

    await page.getByPlaceholder("Enter SI card number...").fill("500803");

    await expect(page.getByText("Monica Henriksson")).toBeVisible({ timeout: 5000 });
    await expect(page.locator("div.text-4xl", { hasText: "Missing Punch" })).toBeVisible();
    await expect(page.getByText("Missing controls: 50")).toBeVisible();
    await expect(page.locator("h3", { hasText: "Missing Controls" })).toBeVisible();
    await expect(page.locator(".bg-red-100", { hasText: "50" })).toBeVisible();
  });

  test("should show not found for unknown card", async ({ page }) => {
    await selectCompetition(page);
    await clickTab(page, "Card Readout");

    await page.getByPlaceholder("Enter SI card number...").fill("999998");
    await expect(page.getByText("Card not found")).toBeVisible({ timeout: 5000 });
  });
});

test.describe("Dashboard Status Cards", () => {
  test("should display status count cards and navigate to filtered runners", async ({
    page,
  }) => {
    await selectCompetition(page);

    await expect(page.getByText("Not Yet Started")).toBeVisible({ timeout: 5000 });
    await expect(page.getByText("In the Forest")).toBeVisible();
    await expect(page.getByText("Finished")).toBeVisible();

    const forestCard = page.locator("button", { hasText: "In the Forest" });
    await expect(forestCard.locator("[data-testid='status-value']")).toHaveText("11");

    // Click to navigate to filtered runner list
    await forestCard.click();
    await expect(page.getByText("11 runners")).toBeVisible({ timeout: 5000 });
  });
});

test.describe("URL Routing", () => {
  test("should have proper URLs for each tab", async ({ page }) => {
    await selectCompetition(page);

    expect(page.url()).toContain("/itest");

    await clickTab(page, "Runners");
    await expect(page.getByText("54 runners")).toBeVisible({ timeout: 10000 });
    expect(page.url()).toContain("/itest/runners");

    await clickTab(page, "Start List");
    await expect(page.getByRole("heading", { name: "Start List" })).toBeVisible({ timeout: 5000 });
    expect(page.url()).toContain("/itest/startlist");

    await clickTab(page, "Results");
    await expect(page.getByRole("heading", { name: "Results" })).toBeVisible({ timeout: 5000 });
    expect(page.url()).toContain("/itest/results");

    await clickTab(page, "Card Readout");
    await expect(page.getByRole("heading", { name: "Card Readout" })).toBeVisible({ timeout: 5000 });
    expect(page.url()).toContain("/itest/card-readout");

    await clickTab(page, "Start Station");
    await expect(page.getByText("Pre-Start")).toBeVisible({ timeout: 5000 });
    expect(page.url()).toContain("/itest/start-station");
  });

  test("should preserve filters in URL search params", async ({ page }) => {
    await selectCompetition(page);
    await clickTab(page, "Runners");
    await expect(page.getByText("54 runners")).toBeVisible({ timeout: 10000 });

    // Type a status filter in the structured search bar
    const searchInput = page.getByRole("combobox", { name: "Search filter input" });
    await searchInput.fill("status:in-forest");
    await searchInput.press("Enter");
    await expect(page.getByText("11 runners")).toBeVisible({ timeout: 5000 });
    await expect(page).toHaveURL(/q=status%3Ain-forest/, { timeout: 3000 });

    // Add a free-text search on top
    await searchInput.fill("Monica");
    await searchInput.press("Enter");
    await expect(page).toHaveURL(/q=.*Monica/, { timeout: 3000 });
  });

  test("should support deep linking directly to a filtered view", async ({ page }) => {
    await page.goto("/itest/runners?q=status:in-forest");
    await expect(page.getByText("11 runners")).toBeVisible({ timeout: 15000 });
    // Verify the status filter pill is shown
    await expect(page.getByText("in-forest")).toBeVisible();
  });

  test("should support browser back navigation", async ({ page }) => {
    await selectCompetition(page);

    await clickTab(page, "Runners");
    await expect(page.getByText("54 runners")).toBeVisible({ timeout: 10000 });

    await clickTab(page, "Results");
    await expect(page.getByRole("heading", { name: "Results" })).toBeVisible({ timeout: 5000 });

    await page.goBack();
    await expect(page.getByText("54 runners")).toBeVisible({ timeout: 5000 });
    expect(page.url()).toContain("/itest/runners");
  });

  test("should include card number in URL for card readout", async ({ page }) => {
    await page.goto("/itest/card-readout");
    await expect(page.getByPlaceholder("Enter SI card number...")).toBeVisible({ timeout: 10000 });

    await page.getByPlaceholder("Enter SI card number...").fill("501438");
    await expect(page.getByText("Malin Johannesson")).toBeVisible({ timeout: 5000 });
    expect(page.url()).toContain("card=501438");
  });

  test("should display start times correctly (not 126:xx:xx)", async ({ page }) => {
    await selectCompetition(page);
    await clickTab(page, "Start List");
    await expect(page.getByRole("cell", { name: "Monica Henriksson" })).toBeVisible({
      timeout: 10000,
    });
    await expect(page.getByRole("cell", { name: "12:41:00" }).first()).toBeVisible();
    await expect(page.getByText("126:50:00")).not.toBeVisible();
  });
});
