import { test, expect } from "@playwright/test";

test.describe("no identity header", () => {
  test.use({ extraHTTPHeaders: { "x-forwarded-email": "" } });

  test("selector shows access denied", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("access-denied")).toBeVisible();
    await expect(page.getByTestId("access-denied-no-identity")).toBeVisible();
  });

  test("kiosk without a key shows an error", async ({ page }) => {
    await page.goto("/itest/kiosk");
    await expect(page.getByTestId("kiosk-key-required")).toBeVisible({
      timeout: 10000,
    });
  });
});

test.describe("uninvited identity", () => {
  test.use({
    extraHTTPHeaders: { "x-forwarded-email": "stranger@oxygen.test" },
  });

  test("shows the not-invited access denied variant", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("access-denied")).toBeVisible();
    await expect(page.getByTestId("access-denied-not-invited")).toBeVisible();
  });
});

test.describe("admin invite then guest login", () => {
  test("invited email can open the selector", async ({ page, browser }) => {
    const email = `guest-${Date.now()}@oxygen.test`;
    await page.goto("/");
    await page.getByTestId("settings-link").click();
    await expect(page.getByTestId("library-tab-users")).toBeVisible({
      timeout: 15000,
    });
    await page.getByTestId("library-tab-users").click();
    await expect(page.getByTestId("users-admin-panel")).toBeVisible();
    await page.getByTestId("invite-email").fill(email);
    await page.getByTestId("invite-submit").click();
    await expect(page.getByText(email)).toBeVisible({ timeout: 10000 });
    await expect(page.getByTestId("user-last-seen").first()).toBeVisible();
    await page.getByTestId("users-search").fill(email);
    await expect(page.getByText(email)).toBeVisible();

    // Rename the freshly invited row and make sure it sticks.
    const row = page.locator("tr", { hasText: email });
    await row.getByTestId("user-name").click();
    await row.getByTestId("user-name-input").fill("Renamed Guest");
    await row.getByTestId("user-name-save").click();
    await expect(page.getByText("Renamed Guest")).toBeVisible({
      timeout: 10000,
    });
    await page.reload();
    await page.getByTestId("users-search").fill(email);
    await expect(page.getByText("Renamed Guest")).toBeVisible({
      timeout: 15000,
    });

    const guest = await browser.newContext({
      extraHTTPHeaders: { "x-forwarded-email": email },
    });
    const guestPage = await guest.newPage();
    await guestPage.goto("/");
    await expect(guestPage.getByTestId("event-search")).toBeVisible({
      timeout: 15000,
    });
    await expect(guestPage.getByTestId("user-chip")).toBeVisible();
    await guest.close();
  });
});
