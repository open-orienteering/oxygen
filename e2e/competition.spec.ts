import { test, expect } from "@playwright/test";

test.describe("Competition Selection", () => {
  test("should display the competition selector page", async ({ page }) => {
    await page.goto("/");

    await expect(page.getByRole("heading", { name: "Oxygen" })).toBeVisible();
    await expect(
      page.getByText("Select a competition to manage"),
    ).toBeVisible();
  });

  test("should list competitions from the database", async ({ page }) => {
    await page.goto("/");

    await expect(page.getByText("My example tävling")).toBeVisible({
      timeout: 10000,
    });
    await expect(page.getByText("2026-04-15")).toBeVisible();
    await expect(page.getByText("Test competition", { exact: true })).toBeVisible();
  });

  test("should select a competition and show dashboard", async ({ page }) => {
    await page.goto("/");

    await page.getByText("My example tävling").click();

    // Should navigate to the dashboard with tabs
    await expect(
      page.locator("header").getByText("My example tävling"),
    ).toBeVisible({ timeout: 10000 });

    // Should show tab navigation
    await expect(page.getByRole("link", { name: "Dashboard" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Runners", exact: true })).toBeVisible();

    // Event is now in the More menu
    await page.getByTestId("more-menu-button").click();
    await expect(page.getByTestId("more-menu-content").getByRole("link", { name: "Event", exact: true })).toBeVisible();
  });

});

test.describe("Competition Dashboard", () => {
  async function goToDashboard(page: import("@playwright/test").Page) {
    await page.goto("/");
    await page.getByText("My example tävling").click();
    // Wait for dashboard to load by checking for the "Not Yet Started" status card
    await expect(page.getByText("Not Yet Started")).toBeVisible({
      timeout: 10000,
    });
  }

  test("should display correct runner and club counts", async ({ page }) => {
    await goToDashboard(page);

    // Check that runner and club stat cards display numbers
    // Stat cards are the first grid (cols-5), use getByRole scoped to it
    const statsGrid = page.locator(".grid.grid-cols-2").first();
    await expect(statsGrid.getByRole("button", { name: /Runners.*54/ })).toBeVisible();
    // Club count may vary due to Eventor sync tests, just verify it's > 0
    const clubCard = statsGrid.getByRole("button", { name: /Clubs/ });
    const clubText = await clubCard.textContent();
    const clubCount = parseInt(clubText?.replace(/\D/g, "") ?? "0", 10);
    expect(clubCount).toBeGreaterThan(0);
  });

  test("should display race status cards", async ({ page }) => {
    await goToDashboard(page);

    await expect(page.getByText("Not Yet Started")).toBeVisible();
    await expect(page.getByText("In the Forest")).toBeVisible();
    await expect(page.getByText("Finished")).toBeVisible();
  });

  test("should display map section", async ({ page }) => {
    await goToDashboard(page);

    // Map section should be present — either upload prompt or loaded map
    // The itest competition may or may not have a map uploaded
    await expect(
      page.getByRole("button", { name: "Upload map" })
        .or(page.getByText("Replace map"))
    ).toBeVisible({ timeout: 5000 });
  });

  test("should show descriptions toggle when a class is selected on map", async ({ page }) => {
    await goToDashboard(page);

    // Upload a map file so the map panel renders the toolbar
    const uploadBtn = page.getByRole("button", { name: "Upload map" });
    if (await uploadBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      const fileChooserPromise = page.waitForEvent("filechooser");
      await uploadBtn.click();
      const fileChooser = await fileChooserPromise;
      await fileChooser.setFiles("e2e/test.ocd");
      // Wait for map to load
      await expect(page.getByText("Replace map")).toBeVisible({ timeout: 15000 });
    }

    // Select a class in the map panel's filter dropdown
    await expect(page.getByText("All classes")).toBeVisible({ timeout: 15000 });
    await page.getByText("All classes").click();
    await page.getByText("Öppen 1", { exact: true }).click();

    // The Descriptions button should appear
    const descBtn = page.getByRole("button", { name: "Descriptions" });
    await expect(descBtn).toBeVisible({ timeout: 5000 });

    // Click to toggle on
    await descBtn.click();
    await expect(page.getByRole("button", { name: "Hide descriptions" })).toBeVisible();

    // Click to toggle off
    await page.getByRole("button", { name: "Hide descriptions" }).click();
    await expect(page.getByRole("button", { name: "Descriptions" })).toBeVisible();
  });

  test("should navigate back to competition list", async ({ page }) => {
    await goToDashboard(page);

    await page
      .getByRole("button", { name: "Back to competition list" })
      .click();

    await expect(page.getByRole("heading", { name: "Oxygen" })).toBeVisible();
    await expect(page.getByText("My example tävling")).toBeVisible();
  });
});
