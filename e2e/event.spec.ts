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

test.describe("Event Page", () => {
  test("Event page shows info, data sync, and payment methods", async ({ page }) => {
    await selectCompetition(page);
    await clickTab(page, "Event");

    expect(page.url()).toContain("/event");
    await expect(page.getByText("Event Info")).toBeVisible({ timeout: 10000 });

    const main = page.getByRole("main");
    await expect(main.getByText("My example tävling")).toBeVisible();
    await expect(main.getByText("2026-04-15")).toBeVisible();
    await expect(main.getByText("itest")).toBeVisible();

    await expect(page.getByText("Data Sync")).toBeVisible();
    await expect(page.getByText("Registration Settings")).toBeVisible();
    await expect(page.getByText("Payment methods")).toBeVisible();

    await expect(main.getByText("Invoice")).toBeVisible();
    await expect(main.getByText("Pay on site")).toBeVisible();
    await expect(main.getByText("Card", { exact: true })).toBeVisible();
    await expect(main.getByText("Swish")).toBeVisible();
    await expect(main.getByText("Cash")).toBeVisible();
  });
});

test.describe("Event Page — Eventor-linked competition", () => {
  test("should show Eventor sync panel for linked competition", async ({ page }) => {
    // Ensure API key is set for itest_multirace competition
    await page.request.post("/trpc/eventor.validateKey", {
      headers: { "x-competition-id": "itest_multirace" },
      data: { apiKey: "df34af90a0c64ca4abfe9492be057e9c" },
    });

    await page.goto("/");
    const multiraceEntry = page.locator('a[href="/itest_multirace"]').first();
    await expect(multiraceEntry).toBeVisible({ timeout: 10000 });
    await multiraceEntry.click();

    // Navigate to Event page
    await expect(page.getByRole("link", { name: "Dashboard" })).toBeVisible({
      timeout: 10000,
    });
    await clickTab(page, "Event");

    // Should show Eventor sync panel
    await expect(page.getByText("Eventor Linked")).toBeVisible({ timeout: 10000 });
    await expect(page.getByText("Last sync:")).toBeVisible();
    await expect(
      page.getByRole("button", { name: /Sync from Eventor/ }),
    ).toBeVisible();
  });

  test("should show runner database panel when API key is configured", async ({ page }) => {
    // Ensure API key is set
    await page.request.post("/trpc/eventor.validateKey", {
      headers: { "x-competition-id": "itest" },
      data: { apiKey: "df34af90a0c64ca4abfe9492be057e9c" },
    });

    await page.goto("/");
    await page.getByText("My example tävling").click();
    await expect(page.getByRole("link", { name: "Dashboard" })).toBeVisible({
      timeout: 10000,
    });
    await clickTab(page, "Event");

    // Runner Database panel should be visible
    await expect(page.getByText("Runner Database")).toBeVisible({ timeout: 10000 });
  });

  test("should explain a runner database upstream timeout", async ({ page }) => {
    await page.request.post("/trpc/eventor.validateKey", {
      headers: { "x-competition-id": "itest" },
      data: { apiKey: "df34af90a0c64ca4abfe9492be057e9c" },
    });
    await page.route("**/trpc/eventor.syncRunnerDb*", async (route) => {
      await route.fulfill({
        status: 504,
        contentType: "text/plain",
        body: "upstream request timeout",
      });
    });

    await page.goto("/itest/event");
    await expect(page.getByText("Runner Database")).toBeVisible({ timeout: 10000 });
    await page.getByRole("button", { name: /^(Download|Re-sync)$/ }).click();

    await expect(
      page.getByText(/Sync failed: The server timed out while processing the request/i),
    ).toBeVisible();
  });

  test("should show club sync panel when API key is configured", async ({ page }) => {
    // Ensure API key is set
    await page.request.post("/trpc/eventor.validateKey", {
      headers: { "x-competition-id": "itest" },
      data: { apiKey: "df34af90a0c64ca4abfe9492be057e9c" },
    });

    await page.goto("/");
    await page.getByText("My example tävling").click();
    await expect(page.getByRole("link", { name: "Dashboard" })).toBeVisible({
      timeout: 10000,
    });
    await clickTab(page, "Event");

    // Club Sync panel should be visible
    await expect(page.getByText("Club Sync")).toBeVisible({ timeout: 10000 });
    await expect(
      page.getByRole("button", { name: /Sync Clubs/ }),
    ).toBeVisible();
  });
});
