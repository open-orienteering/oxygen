/**
 * Node discovery E2E (pivot Step 5).
 *
 * The safety property that matters: pinning a venue URL must never break a
 * station. With an unreachable venue configured, probes fail, the client
 * stays on the cloud (same-origin), and everything keeps working; clearing
 * the URL returns to the default. The happy path (probes succeeding against
 * a second live node) is covered by the two-node integration harness +
 * manual venue-box testing — Playwright runs a single stack.
 */

import { test, expect } from "@playwright/test";

test.describe("Venue node discovery", () => {
  test("unreachable venue URL falls back to cloud and the app keeps working", async ({
    page,
  }) => {
    await page.goto("/");
    await page.getByText("My example tävling").click();
    await expect(page.getByRole("link", { name: "Dashboard" })).toBeVisible({
      timeout: 10000,
    });

    // Pin an unreachable venue URL through the sync panel.
    await page.getByTestId("sync-status-button").click();
    await expect(page.getByTestId("connection-mode")).toContainText(/cloud|molnet/);
    const input = page.getByTestId("venue-url-input");
    await input.fill("http://192.0.2.1:9/"); // TEST-NET-1, guaranteed dead
    await input.press("Enter");
    await page.locator(".fixed.inset-0").click();

    // The probe fails and the client stays on the cloud: navigation and
    // data loads keep working exactly as before.
    await page.getByRole("link", { name: "Runners", exact: true }).click();
    await expect(page.locator("table")).toBeVisible({ timeout: 15000 });

    await page.getByTestId("sync-status-button").click();
    await expect(page.getByTestId("connection-mode")).toContainText(
      /cloud|molnet/,
    );

    // Cleanup: clear the pinned URL.
    const input2 = page.getByTestId("venue-url-input");
    await input2.fill("");
    await input2.press("Enter");
    await page.evaluate(() => localStorage.removeItem("oxygen-venue-urls"));
  });
});
