import { test, expect } from "@playwright/test";

/**
 * E2E tests for error handling and edge cases.
 *
 * Tests cover empty data states, form validation errors,
 * duplicate data handling, and invalid navigation.
 */

const TEST_COMPETITION = "Test competition";
const TEST_COMPETITION_NAMEID = "meos_20251222_001121_2BC";
const MAIN_COMPETITION = "My example tävling";

// ─── Helpers ───────────────────────────────────────────────

async function selectCompetition(page: import("@playwright/test").Page, name: string) {
  await page.goto("/");
  await page.getByText(name).click();
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

// ─── Tests ─────────────────────────────────────────────────

test.describe("Empty Data States", () => {
  test("courses page shows empty state when competition has no courses", async ({ page }) => {
    await selectCompetition(page, TEST_COMPETITION);
    await clickTab(page, "Courses");

    // Should display empty-state message, not crash
    await expect(page.getByText("No courses found")).toBeVisible({ timeout: 10000 });
  });

  test("controls page shows empty state when competition has no controls", async ({ page }) => {
    await selectCompetition(page, TEST_COMPETITION);
    await clickTab(page, "Controls");

    // Should display empty-state message, not crash
    await expect(page.getByText("No controls found")).toBeVisible({ timeout: 10000 });
  });
});

test.describe("Validation Errors", () => {
  test("creating a control with invalid code (0) shows error", async ({ page }) => {
    await selectCompetition(page, MAIN_COMPETITION);
    await clickTab(page, "Controls");
    await expect(page.getByText("23 controls")).toBeVisible({ timeout: 10000 });

    await page.getByRole("button", { name: "New Control" }).click();
    await expect(page.getByRole("heading", { name: "New Control" })).toBeVisible({ timeout: 3000 });

    // Enter invalid code "0"
    await page.getByPlaceholder("e.g. 50 or 50;250").fill("0");
    await page.getByRole("button", { name: "Create" }).click();

    // Server should reject with error message
    await expect(page.getByText("Invalid control code")).toBeVisible({ timeout: 5000 });
  });

  test("creating a control with non-numeric code shows error", async ({ page }) => {
    await selectCompetition(page, MAIN_COMPETITION);
    await clickTab(page, "Controls");
    await expect(page.getByText("23 controls")).toBeVisible({ timeout: 10000 });

    await page.getByRole("button", { name: "New Control" }).click();
    await expect(page.getByRole("heading", { name: "New Control" })).toBeVisible({ timeout: 3000 });

    // Enter non-numeric code
    await page.getByPlaceholder("e.g. 50 or 50;250").fill("abc");
    await page.getByRole("button", { name: "Create" }).click();

    // Server should reject with error message
    await expect(page.getByText("Invalid control code")).toBeVisible({ timeout: 5000 });
  });

  test("registration dialog rejects empty name", async ({ page }) => {
    await selectCompetition(page, MAIN_COMPETITION);
    const nameId = new URL(page.url()).pathname.split("/").filter(Boolean)[0];
    await page.goto(`/${nameId}/runners`);
    await expect(page.getByRole("button", { name: "Add Runner" })).toBeVisible({ timeout: 10000 });

    // Open registration dialog
    await page.getByRole("button", { name: "Add Runner" }).click();
    await expect(page.getByTestId("registration-dialog")).toBeVisible({ timeout: 5000 });

    const dialog = page.getByTestId("registration-dialog");

    // Select a class but leave name empty
    await dialog.getByTestId("reg-class").click();
    await expect(dialog.locator("button").filter({ hasText: "Öppen 1" })).toBeVisible({ timeout: 3000 });
    await dialog.locator("button").filter({ hasText: "Öppen 1" }).click();

    // Try to submit with empty name
    await dialog.getByTestId("reg-submit").click();

    // Should show validation error — name is required
    await expect(dialog.getByText(/name.*required/i)).toBeVisible({ timeout: 5000 });
  });
});

test.describe("Duplicate Data", () => {
  test("creating a control that already exists shows conflict error", async ({ page }) => {
    await selectCompetition(page, MAIN_COMPETITION);
    await clickTab(page, "Controls");
    await expect(page.getByText("23 controls")).toBeVisible({ timeout: 10000 });

    await page.getByRole("button", { name: "New Control" }).click();
    await expect(page.getByRole("heading", { name: "New Control" })).toBeVisible({ timeout: 3000 });

    // Use code 50 which is "Radio 1" in the seed data
    await page.getByPlaceholder("e.g. 50 or 50;250").fill("50");
    await page.getByPlaceholder("e.g. Radio 1 (optional)").fill("Duplicate Test");
    await page.getByRole("button", { name: "Create" }).click();

    // Server should reject with conflict error
    await expect(page.getByText(/already exists/)).toBeVisible({ timeout: 5000 });

    // Original control count should remain unchanged
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByText("23 controls")).toBeVisible({ timeout: 5000 });
  });
});

test.describe("Invalid Navigation", () => {
  test("navigating to a non-existent competition shows error page", async ({ page }) => {
    await page.goto("/this_competition_does_not_exist_xyz");

    // Should show error state with "Competition not found" message
    await expect(page.getByText("Competition not found")).toBeVisible({ timeout: 15000 });
    await expect(page.getByText(/could not connect/i)).toBeVisible();

    // Should have a link/button to go back to competition list
    const backButton = page.getByRole("button", { name: /back/i });
    await expect(backButton).toBeVisible();
    await backButton.click();

    // Should return to competition list
    await expect(page.getByRole("heading", { name: "Oxygen" })).toBeVisible({ timeout: 10000 });
  });
});
