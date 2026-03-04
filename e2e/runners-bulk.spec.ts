import { test, expect } from "@playwright/test";

async function goToRunners(page: import("@playwright/test").Page) {
  await page.goto("/");
  await page.getByText("My example tävling").click();
  await expect(page.getByRole("button", { name: "Dashboard" })).toBeVisible({
    timeout: 15000,
  });
  const mainTab = page.locator("nav[aria-label='Tabs']").getByRole("button", { name: "Runners", exact: true });
  if (await mainTab.isVisible()) {
    await mainTab.click();
  } else {
    await page.getByTestId("more-menu-button").click();
    await page.getByTestId("more-menu-content").getByRole("button", { name: "Runners", exact: true }).click();
  }
  await expect(page.locator("span", { hasText: "runners" })).toContainText("54", {
    timeout: 15000,
  });
}

test.describe("Runners Bulk Editing", () => {
  test("should select multiple runners and show bulk action bar", async ({ page }) => {
    await goToRunners(page);
    const rows = page.locator("tr").filter({ has: page.locator('input[type="checkbox"]') });

    await rows.nth(1).locator('input[type="checkbox"]').click();
    await rows.nth(2).locator('input[type="checkbox"]').click();

    const actionBar = page.locator(".animate-slide-up");
    await expect(actionBar).toBeVisible();
    await expect(actionBar.locator("div", { hasText: "2" }).first()).toBeVisible();
    await expect(actionBar.getByText("selected", { exact: true })).toBeVisible();
  });

  test("should update status for multiple runners via bulk action", async ({ page }) => {
    await goToRunners(page);
    page.on("dialog", (dialog) => dialog.accept());

    const rows = page.locator("tr").filter({ has: page.locator('input[type="checkbox"]') });
    await rows.nth(1).locator('input[type="checkbox"]').click();
    await rows.nth(2).locator('input[type="checkbox"]').click();

    const actionBar = page.locator(".animate-slide-up");
    await actionBar.locator("select").nth(1).selectOption({ label: "DNS -- Did Not Start" });
    await actionBar.getByRole("button", { name: "Apply to 2" }).click();

    await expect(actionBar).not.toBeVisible();
    await expect(page.locator("span", { hasText: "DNS" }).first()).toBeVisible();
  });
});
