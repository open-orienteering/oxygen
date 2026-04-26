import { test, expect } from "@playwright/test";
import { readFileSync, statSync } from "node:fs";

async function selectCompetition(page: import("@playwright/test").Page) {
  await page.goto("/");
  await page.getByText("My example tävling").click();
  await expect(page.getByRole("link", { name: "Dashboard" })).toBeVisible({
    timeout: 10000,
  });
}

async function clickTab(page: import("@playwright/test").Page, name: string) {
  const mainTab = page
    .locator("nav[aria-label='Tabs']")
    .getByRole("link", { name, exact: true });
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

test.describe("Database Backup", () => {
  test("Event page surfaces a Database Backup section", async ({ page }) => {
    await selectCompetition(page);
    await clickTab(page, "Event");

    await expect(page.getByText("Database Backup").first()).toBeVisible({
      timeout: 10000,
    });
    await expect(
      page.getByRole("link", { name: /Download backup/i }),
    ).toBeVisible();
  });

  test("Download backup button delivers a non-empty .sql file", async ({
    page,
  }) => {
    await selectCompetition(page);
    await clickTab(page, "Event");

    const downloadLink = page.getByRole("link", { name: /Download backup/i });
    await expect(downloadLink).toBeVisible({ timeout: 10000 });

    const [download] = await Promise.all([
      page.waitForEvent("download"),
      downloadLink.click(),
    ]);

    expect(download.suggestedFilename()).toMatch(
      /^itest_backup_\d{8}_\d{6}\.sql$/,
    );

    const path = await download.path();
    expect(path).toBeTruthy();
    const size = statSync(path!).size;
    expect(size).toBeGreaterThan(1024);

    const head = readFileSync(path!, "utf-8").slice(0, 4096);
    expect(head).toContain("-- Oxygen backup");
    expect(head).toContain("-- Database:   itest");
    expect(head).toContain("-- INSERT INTO MeOSMain.oEvent (");
  });
});
