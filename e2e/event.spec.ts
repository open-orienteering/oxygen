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

test.describe("Event Page", () => {
  test("should navigate to event page via tab", async ({ page }) => {
    await selectCompetition(page);
    await clickTab(page, "Event");

    expect(page.url()).toContain("/event");
    await expect(page.getByText("Competition Info")).toBeVisible({ timeout: 10000 });
  });

  test("should display competition info", async ({ page }) => {
    await selectCompetition(page);
    await clickTab(page, "Event");

    await expect(page.getByText("Competition Info")).toBeVisible({ timeout: 10000 });
    // Scope to main content area to avoid matching the header title
    const main = page.getByRole("main");
    await expect(main.getByText("My example tävling")).toBeVisible();
    await expect(main.getByText("2026-04-15")).toBeVisible();
    await expect(main.getByText("itest")).toBeVisible();
  });

  test("should display data sync section", async ({ page }) => {
    await selectCompetition(page);
    await clickTab(page, "Event");

    await expect(page.getByText("Data Sync")).toBeVisible({ timeout: 10000 });
  });

  test("should display registration settings section", async ({ page }) => {
    await selectCompetition(page);
    await clickTab(page, "Event");

    await expect(page.getByText("Registration Settings")).toBeVisible({ timeout: 10000 });
    await expect(page.getByText("Invoice")).toBeVisible();
  });

  test("should show payment method toggles in registration settings", async ({ page }) => {
    await selectCompetition(page);
    await clickTab(page, "Event");

    await expect(page.getByText("Registration Settings")).toBeVisible({ timeout: 10000 });
    await expect(page.getByText("Payment methods")).toBeVisible();

    // Payment method toggle buttons should be visible
    const main = page.getByRole("main");
    await expect(main.getByRole("button", { name: "Invoice" })).toBeVisible();
    await expect(main.getByRole("button", { name: "Pay on site" })).toBeVisible();
    await expect(main.getByRole("button", { name: "Card" })).toBeVisible();
    await expect(main.getByRole("button", { name: "Swish" })).toBeVisible();
  });

});

test.describe("Registration Page", () => {
  test("should navigate to registration page via overflow menu", async ({ page }) => {
    await selectCompetition(page);
    await clickTab(page, "Registration");

    expect(page.url()).toContain("/registration");
    // Should show the waiting indicator and form elements
    await expect(page.getByText("Waiting for SI card...")).toBeVisible({ timeout: 10000 });
    await expect(page.getByText("Recent Registrations")).toBeVisible();
  });

  test("should display registration form fields", async ({ page }) => {
    await selectCompetition(page);
    await clickTab(page, "Registration");

    await expect(page.getByText("Waiting for SI card...")).toBeVisible({ timeout: 10000 });
    await expect(page.getByText("Name *")).toBeVisible();
    await expect(page.getByText("Class *")).toBeVisible();
    await expect(page.getByText("SI Card", { exact: true })).toBeVisible();
    await expect(page.getByText("Payment")).toBeVisible();
    await expect(page.getByRole("button", { name: "Register Runner" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Clear (Esc)" })).toBeVisible();
  });
});

test.describe("Event Page — Eventor-linked competition", () => {
  test("should show Eventor sync panel for linked competition", async ({ page }) => {
    // Ensure API key is set
    await page.request.post("/trpc/eventor.validateKey", {
      data: { apiKey: "df34af90a0c64ca4abfe9492be057e9c" },
    });

    await page.goto("/");
    const vinterBtn = page.getByRole("button", { name: /itest_vinterserien/ });
    await expect(vinterBtn).toBeVisible({ timeout: 10000 });
    await vinterBtn.click();

    // Navigate to Event page
    await expect(page.getByRole("button", { name: "Dashboard" })).toBeVisible({
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
      data: { apiKey: "df34af90a0c64ca4abfe9492be057e9c" },
    });

    await page.goto("/");
    await page.getByText("My example tävling").click();
    await expect(page.getByRole("button", { name: "Dashboard" })).toBeVisible({
      timeout: 10000,
    });
    await clickTab(page, "Event");

    // Runner Database panel should be visible
    await expect(page.getByText("Runner Database")).toBeVisible({ timeout: 10000 });
  });

  test("should show club sync panel when API key is configured", async ({ page }) => {
    // Ensure API key is set
    await page.request.post("/trpc/eventor.validateKey", {
      data: { apiKey: "df34af90a0c64ca4abfe9492be057e9c" },
    });

    await page.goto("/");
    await page.getByText("My example tävling").click();
    await expect(page.getByRole("button", { name: "Dashboard" })).toBeVisible({
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
