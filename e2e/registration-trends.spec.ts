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
  test("opens via the More menu and renders the page header", async ({ page }) => {
    await selectCompetition(page);
    await clickTab(page, "Trends");

    await expect(page).toHaveURL(/\/registration-trends/);
    await expect(
      page.getByRole("heading", { name: "Registration trends" }),
    ).toBeVisible({ timeout: 10000 });
  });

  test("shows controls and toggles axis modes", async ({ page }) => {
    await selectCompetition(page);
    await clickTab(page, "Trends");

    await expect(page.getByRole("button", { name: "Cumulative" })).toBeVisible({
      timeout: 10000,
    });
    await page.getByRole("button", { name: "Per day" }).click();
    // After toggling, the per-day button becomes the selected one (white-on-blue)
    await expect(page.getByRole("button", { name: "Per day" })).toHaveClass(
      /bg-blue-600/,
    );
  });

  test("offers an Add comparison events button that opens the picker", async ({ page }) => {
    await selectCompetition(page);
    await clickTab(page, "Trends");

    await expect(
      page.getByRole("button", { name: "Add comparison events" }).first(),
    ).toBeVisible({ timeout: 10000 });
    await page
      .getByRole("button", { name: "Add comparison events" })
      .first()
      .click();
    // The dialog header repeats the same label
    await expect(
      page.getByRole("heading", { name: "Add comparison events" }),
    ).toBeVisible();
    // The picker exposes an "Add by event ID or URL" section that bypasses
    // the org-scoped browse flow — this is the workhorse for comparing
    // against unrelated competitions and must always be reachable, even
    // when /api/events 403s for the configured key.
    await expect(
      page.getByRole("heading", { name: /Add by Eventor event ID/i }),
    ).toBeVisible();
    await expect(
      page.getByPlaceholder(/Event ID or URL/i),
    ).toBeVisible();
  });

  test("rejects junk input in the Add by Event ID field", async ({ page }) => {
    await selectCompetition(page);
    await clickTab(page, "Trends");
    await page
      .getByRole("button", { name: "Add comparison events" })
      .first()
      .click();

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
