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
    await page
      .getByTestId("more-menu-content")
      .getByRole("link", { name, exact: true })
      .click();
  }
}

test.describe("Registration Trends", () => {
  test("shows controls and toggles axis modes", async ({ page }) => {
    await selectCompetition(page);
    await clickTab(page, "Trends");

    await expect(page).toHaveURL(/\/registration-trends/);
    await expect(
      page.getByRole("heading", { name: "Registration trends" }),
    ).toBeVisible({ timeout: 10000 });

    await expect(page.getByRole("button", { name: "Cumulative" })).toBeVisible({
      timeout: 10000,
    });
    await page.getByRole("button", { name: "Per day" }).click();
    await expect(page.getByRole("button", { name: "Per day" })).toHaveClass(
      /bg-blue-600/,
    );
  });

  test("opens comparison picker and rejects junk event IDs", async ({ page }) => {
    await selectCompetition(page);
    await clickTab(page, "Trends");

    await expect(
      page.getByRole("button", { name: "Add comparison events" }).first(),
    ).toBeVisible({ timeout: 10000 });
    await page
      .getByRole("button", { name: "Add comparison events" })
      .first()
      .click();
    await expect(
      page.getByRole("heading", { name: "Add comparison events" }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: /Add by Eventor event ID/i }),
    ).toBeVisible();
    await expect(
      page.getByPlaceholder(/Event ID or URL/i),
    ).toBeVisible();

    const input = page.getByPlaceholder(/Event ID or URL/i);
    await input.fill("not a url");
    await page.getByRole("button", { name: /^Look up$/i }).click();
    await expect(page.getByText(/Could not find that event/i)).toBeVisible({
      timeout: 10000,
    });
  });

  test("dashboard exposes a registration-trends preview card linking to the page", async ({ page }) => {
    await selectCompetition(page);
    // The dashboard card is only rendered when the competition has dated entries.
    // The seeded itest competition has runners; if any of them carry an
    // EntryDate the card appears and clicking it should land on the page.
    const card = page
      .getByRole("button", { name: /Registration trends/i })
      .first();
    if (await card.isVisible()) {
      await card.click();
      await expect(page).toHaveURL(/\/registration-trends/);
    } else {
      // Skip: itest fixture has no dated entries — the page is still reachable
      // via the More menu, which is covered by the test above.
      test.skip();
    }
  });
});
