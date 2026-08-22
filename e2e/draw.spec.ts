import { test, expect } from "@playwright/test";
import { reseed } from "./helpers/reseed";

async function selectCompetition(page: import("@playwright/test").Page) {
  await page.goto("/");
  await page.getByText("My example tävling").click();
  await expect(page.getByRole("link", { name: "Dashboard" })).toBeVisible({
    timeout: 10000,
  });
}

function tabButton(page: import("@playwright/test").Page, name: string) {
  return page
    .locator("nav[aria-label='Tabs']")
    .getByRole("link", { name, exact: true });
}

// Backwards-compat shim: the legacy draw.spec.ts reseeded via mysqldump.
// Under the PG backend we just delegate to the shared `reseed()` helper
// which wipes & rebuilds the three E2E events programmatically.
async function reseedItestDb() {
  await reseed();
}

function toSeconds(hhmmss: string): number {
  const [h, m, s] = hhmmss.split(":").map(Number);
  return h * 3600 + m * 60 + s;
}

async function openDrawPanel(page: import("@playwright/test").Page) {
  await selectCompetition(page);
  await tabButton(page, "Start List").click();
  await page.getByTestId("draw-start-times-btn").click();
  await expect(
    page.getByRole("heading", { name: "Draw Start Times" }),
  ).toBeVisible({ timeout: 5000 });
  const panel = page.getByTestId("draw-panel");
  await expect(panel.getByText(/3 class/)).toBeVisible({ timeout: 10000 });
  return panel;
}

test.describe("Start Draw", () => {
  test.afterAll(async () => {
    await reseedItestDb();
  });

  test("should open draw panel and generate a preview", async ({ page }) => {
    const panel = await openDrawPanel(page);

    await page.getByTestId("draw-preview-btn").click();
    await expect(
      panel.getByRole("heading", { name: "Preview" }),
    ).toBeVisible({ timeout: 10000 });

    // Apply button should now be enabled
    await expect(page.getByTestId("draw-execute-btn")).toBeEnabled();
  });

  test("should apply draw, update start list, and reseed", async ({ page }) => {
    const panel = await openDrawPanel(page);

    await page.getByTestId("draw-preview-btn").click();
    await expect(
      panel.getByRole("heading", { name: "Preview" }),
    ).toBeVisible({ timeout: 10000 });

    await page.getByTestId("draw-execute-btn").click();
    await expect(panel.getByText("Draw complete")).toBeVisible({
      timeout: 15000,
    });
    await expect(panel.getByText(/runner.*assigned start times/)).toBeVisible();

    await panel.getByRole("button", { name: "Close", exact: true }).click();
    await expect(
      page.locator("td").filter({ hasText: /^\d{2}:\d{2}:\d{2}$/ }).first(),
    ).toBeVisible({ timeout: 5000 });

  });

  test("should show timeline visualization after preview", async ({ page }) => {
    const panel = await openDrawPanel(page);

    await page.getByTestId("draw-preview-btn").click();
    await expect(
      panel.getByRole("heading", { name: "Preview" }),
    ).toBeVisible({ timeout: 10000 });

    const timeline = panel.getByTestId("draw-timeline");
    await expect(timeline).toBeVisible();
    await expect(
      timeline.locator("[data-testid^='timeline-corridor-']").first(),
    ).toBeVisible();
    await expect(
      timeline.locator("[data-testid^='timeline-bar-']").first(),
    ).toBeVisible();
    await expect(panel.getByText(/Drag class bars/)).toBeVisible();
  });

  test("should stagger corridors so parallel lanes start on different minutes", async ({
    page,
  }) => {
    const panel = await openDrawPanel(page);

    // The three seed classes leave the start towards different first
    // controls, so they get one corridor each and would otherwise all start
    // at the same second.
    await page.getByTestId("draw-stagger").fill("1:00");
    await page.getByTestId("draw-preview-btn").click();
    await expect(panel.getByRole("heading", { name: "Preview" })).toBeVisible({
      timeout: 10000,
    });

    const starts = await panel
      .getByTestId("draw-preview-first-start")
      .allTextContents();
    const distinct = [...new Set(starts.map((s) => s.trim()))].sort();
    expect(distinct.length).toBeGreaterThan(1);
    expect(toSeconds(distinct[1]) - toSeconds(distinct[0])).toBe(60);
  });

  test("should shift a class by its manual offset", async ({ page }) => {
    const panel = await openDrawPanel(page);

    await panel.locator("[data-testid^='draw-class-offset-']").first().fill("0:30");
    await page.getByTestId("draw-preview-btn").click();
    await expect(panel.getByRole("heading", { name: "Preview" })).toBeVisible({
      timeout: 10000,
    });

    const starts = await panel
      .getByTestId("draw-preview-first-start")
      .allTextContents();
    expect(starts.some((s) => s.trim().endsWith(":30"))).toBe(true);
  });

  test("should toggle the first-control gap with its checkbox", async ({
    page,
  }) => {
    const panel = await openDrawPanel(page);

    const gap = page.getByTestId("draw-first-control-gap");
    await expect(gap).toBeEnabled();
    await expect(gap).toHaveValue("1:00");

    await page.getByTestId("draw-first-control-spacing-toggle").uncheck();
    await expect(gap).toBeDisabled();

    await page.getByTestId("draw-first-control-spacing-toggle").check();
    await gap.fill("0:30");
    await page.getByTestId("draw-preview-btn").click();
    await expect(panel.getByRole("heading", { name: "Preview" })).toBeVisible({
      timeout: 10000,
    });
  });

  test("should apply bulk interval to all selected classes", async ({
    page,
  }) => {
    const panel = await openDrawPanel(page);

    const bulkInput = page.getByTestId("draw-bulk-interval");
    await bulkInput.fill("3:00");
    await page.getByTestId("draw-bulk-interval-apply").click();

    const intervalInputs = panel.locator("td input[type='text'][placeholder='2:00']");
    const count = await intervalInputs.count();
    for (let i = 0; i < count; i++) {
      await expect(intervalInputs.nth(i)).toHaveValue("3:00");
    }
  });
});
