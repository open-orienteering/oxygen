import { test, expect } from "@playwright/test";

/** Clear the stored Eventor API key via tRPC so tests start fresh. */
async function clearEventorKey(page: import("@playwright/test").Page) {
  await page.request.post("/trpc/eventor.clearKey", {
    headers: { "x-competition-id": "itest" },
    data: {},
  });
}

test.describe("Competition Selector — New Features", () => {
  test("should display New Competition and Import from Eventor buttons", async ({
    page,
  }) => {
    await page.goto("/");
    await expect(
      page.getByRole("button", { name: /New Competition/ }),
    ).toBeVisible({ timeout: 10000 });
    await expect(
      page.getByRole("button", { name: /Import from Eventor/ }),
    ).toBeVisible();
  });

  test("should create a new empty competition and navigate to it", async ({
    page,
  }) => {
    const uniqueName = `E2E Test ${Date.now()}`;

    await page.goto("/");
    await expect(
      page.getByRole("button", { name: /New Competition/ }),
    ).toBeVisible({ timeout: 10000 });

    await page.getByRole("button", { name: /New Competition/ }).click();
    await expect(
      page.getByRole("heading", { name: "New Competition" }),
    ).toBeVisible({ timeout: 3000 });

    await page.getByPlaceholder(/Klubbmästerskap/).fill(uniqueName);

    await page.getByRole("button", { name: "Create" }).click();
    await expect(page.getByRole("link", { name: "Dashboard" })).toBeVisible({
      timeout: 15000,
    });
    await expect(page.getByText(uniqueName)).toBeVisible();

    // Verify it appears in competition list
    await page.goto("/");
    await expect(page.getByText(uniqueName).first()).toBeVisible({
      timeout: 10000,
    });

    // Clean up
    const dbName = uniqueName.replace(/[^a-zA-Z0-9]/g, "_");
    await fetch("http://localhost:3002/trpc/competition.delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nameId: dbName }),
    });
  });

  test("should open the Eventor import panel with API key step", async ({
    page,
  }) => {
    await clearEventorKey(page);
    await page.goto("/");
    await expect(
      page.getByRole("button", { name: /Import from Eventor/ }),
    ).toBeVisible({ timeout: 10000 });

    await page.getByRole("button", { name: /Import from Eventor/ }).click();
    await expect(
      page.getByRole("heading", { name: "Import from Eventor" }),
    ).toBeVisible({ timeout: 3000 });

    await expect(page.getByText("1. API Key")).toBeVisible();
    await expect(page.getByText("2. Select & Import")).toBeVisible();
    await expect(page.getByPlaceholder(/API key/)).toBeVisible();
    await expect(page.getByRole("button", { name: "Connect" })).toBeVisible();
  });

  test.skip("should validate Eventor API key and show event list", async ({
    page,
  }) => {
    // Skipped: requires a valid Eventor API key and live network access to api.orientering.se
    await clearEventorKey(page);
    await page.goto("/");
    await page.getByRole("button", { name: /Import from Eventor/ }).click();
    await expect(page.getByPlaceholder(/API key/)).toBeVisible({
      timeout: 3000,
    });

    await page
      .getByPlaceholder(/API key/)
      .fill("df34af90a0c64ca4abfe9492be057e9c");
    await page.getByRole("button", { name: "Connect" }).click();

    await expect(page.getByText(/Connected:/)).toBeVisible({ timeout: 15000 });
    await expect(page.getByPlaceholder("Search events...")).toBeVisible();
    await expect(
      page.locator("button", { hasText: "Import" }).first(),
    ).toBeVisible({ timeout: 15000 });
  });

  test("should show delete confirmation dialog and allow cancel", async ({
    page,
  }) => {
    await page.goto("/");
    await expect(page.getByText("My example tävling").first()).toBeVisible({ timeout: 10000 });

    const entry = page.locator("li").filter({ hasText: "My example tävling" }).first();
    await entry.hover();
    const deleteBtn = entry.locator("button[title='Delete competition']");
    await expect(deleteBtn).toBeVisible();
    await deleteBtn.click();

    await expect(page.getByText("Delete Competition")).toBeVisible();
    await expect(page.getByText("This cannot be undone.")).toBeVisible();

    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByText("Delete Competition")).not.toBeVisible();
  });

  test("should delete a test competition via the dialog", async ({ page }) => {
    const uniqueName = `Delete Test ${Date.now()}`;
    await page.goto("/");
    await page.getByRole("button", { name: "New Competition" }).click();
    await expect(
      page.getByPlaceholder("e.g. Klubbmästerskap 2026"),
    ).toBeVisible({ timeout: 5000 });
    await page.getByPlaceholder("e.g. Klubbmästerskap 2026").fill(uniqueName);
    await page.locator("input[type='date']").fill("2026-03-01");
    await page.getByRole("button", { name: "Create" }).click();
    await expect(page.getByText("Dashboard")).toBeVisible({ timeout: 10000 });

    await page.goto("/");
    await expect(page.getByText(uniqueName)).toBeVisible({ timeout: 10000 });

    const entry = page.locator("li").filter({ hasText: uniqueName }).first();
    await entry.locator("button[title='Delete competition']").click({ force: true });
    await expect(page.getByText("Delete Competition")).toBeVisible();
    await page.getByRole("button", { name: "Delete Permanently" }).click();

    await expect(page.getByText("Delete Competition")).not.toBeVisible({ timeout: 10000 });
    await expect(
      page.locator("li").filter({ hasText: uniqueName }),
    ).toHaveCount(0, { timeout: 10000 });
  });

  test("should create and delete a club", async ({ page }) => {
    await page.goto("/");
    await page.getByText("My example tävling").first().click();
    await expect(page.getByText("Dashboard")).toBeVisible({ timeout: 5000 });

    await page.getByTestId("more-menu-button").click();
    await page.getByTestId("more-menu-content").getByRole("link", { name: "Clubs" }).click();
    await expect(page.getByText(/\d+ clubs/)).toBeVisible();

    // Show all clubs so we can see newly created empty ones
    await page.getByRole("button", { name: "Show all clubs" }).click();
    await expect(page.getByText("Showing all clubs")).toBeVisible();

    const uniqueClub = `Test Club ${Date.now()}`;
    await page.getByRole("button", { name: "New Club" }).click();
    await page.getByPlaceholder("e.g. OK Ansen").fill(uniqueClub);
    await page.getByRole("button", { name: "Add" }).click();
    await expect(page.getByText(uniqueClub)).toBeVisible({ timeout: 15000 });

    page.on("dialog", (dialog) => dialog.accept());
    const clubRow = page.locator("tbody tr").filter({ hasText: uniqueClub }).first();
    await clubRow.locator("button[title='Remove club']").click({ force: true });
    await expect(page.getByText(uniqueClub)).not.toBeVisible({ timeout: 10000 });
  });
});
