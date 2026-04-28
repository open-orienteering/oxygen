import { test, expect } from "@playwright/test";

/**
 * Coverage for the OR-grouping / NOT extension to the structured search
 * bar. We use the `itest` seed competition; counts can drift slightly
 * when other specs in the run add or delete runners, so the assertions
 * below are written in relative terms (filter result vs unfiltered total)
 * rather than against fixed baselines.
 */

async function readRunnerCount(page: import("@playwright/test").Page): Promise<number> {
  const txt = await page.locator("span", { hasText: /^\d+ runners$/ }).first().textContent();
  const m = txt?.match(/(\d+)\s+runners/);
  if (!m) throw new Error(`could not parse runner count from "${txt}"`);
  return parseInt(m[1], 10);
}

test.describe("Structured search — OR groups and NOT", () => {
  test("deep link with an OR group renders a single group pill and filters", async ({
    page,
  }) => {
    // Get unfiltered baseline first.
    await page.goto("/itest/runners");
    await expect(page.locator("span", { hasText: "runners" }).first()).toBeVisible({
      timeout: 15000,
    });
    const baseline = await readRunnerCount(page);
    expect(baseline).toBeGreaterThan(0);

    // Apply OR filter via deep link.
    const q = `class:"Öppen 1"|class:"Öppen 2"`;
    await page.goto(`/itest/runners?q=${encodeURIComponent(q)}`);

    await expect(page.getByTestId("or-group-pill")).toBeVisible({ timeout: 15000 });
    const filtered = await readRunnerCount(page);
    // 25 + 14 = 39 runners in the seed; allow ±5 drift from concurrent tests.
    expect(filtered).toBeGreaterThan(30);
    expect(filtered).toBeLessThan(baseline);
  });

  test("typing class:foo|class:bar in the bar produces an OR group pill", async ({
    page,
  }) => {
    await page.goto("/itest/runners");
    await expect(page.locator("span", { hasText: "runners" }).first()).toBeVisible({
      timeout: 15000,
    });
    const baseline = await readRunnerCount(page);

    const input = page.getByRole("combobox", { name: "Search filter input" });

    // First atom — committing with `|` arms OR-mode for the next commit.
    await input.fill(`class:"Öppen 1"`);
    await input.press("|");
    await expect(page.getByTestId("or-mode-indicator")).toBeVisible();

    // Second atom — pressing Enter commits and folds with the previous root
    // into a single OR group pill.
    await input.fill(`class:"Öppen 2"`);
    await input.press("Enter");

    await expect(page.getByTestId("or-group-pill")).toBeVisible();
    const filtered = await readRunnerCount(page);
    expect(filtered).toBeGreaterThan(30);
    expect(filtered).toBeLessThan(baseline);

    // The URL is canonicalized to `(class:...|class:...)`.
    await expect(page).toHaveURL(/q=.*%28class.*%7Cclass.*%29/, {
      timeout: 3000,
    });
  });

  test("deep link with !class:... excludes that class", async ({ page }) => {
    await page.goto("/itest/runners");
    await expect(page.locator("span", { hasText: "runners" }).first()).toBeVisible({
      timeout: 15000,
    });
    const baseline = await readRunnerCount(page);

    const q = `!class:"Öppen 3"`;
    await page.goto(`/itest/runners?q=${encodeURIComponent(q)}`);

    await expect(page.getByRole("button", { name: "Toggle negation" })).toBeVisible({
      timeout: 15000,
    });
    const filtered = await readRunnerCount(page);
    // Class "Öppen 3" has 15 runners in the seed; remaining ≈ baseline − 15.
    expect(filtered).toBeGreaterThan(0);
    expect(filtered).toBeLessThan(baseline);
    expect(baseline - filtered).toBeGreaterThan(10);
  });

  test("typing ! at empty input arms a pending NOT chip", async ({ page }) => {
    await page.goto("/itest/runners");
    await expect(page.locator("span", { hasText: "runners" }).first()).toBeVisible({
      timeout: 15000,
    });

    const input = page.getByRole("combobox", { name: "Search filter input" });

    await input.click();
    await input.press("!");
    await expect(page.getByTestId("pending-not")).toBeVisible();
    await expect(input).toHaveValue("");

    // Cancel with Backspace — chip disappears.
    await input.press("Backspace");
    await expect(page.getByTestId("pending-not")).not.toBeVisible();
  });
});
