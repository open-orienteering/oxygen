/**
 * PWA / IAP session recovery: expired sessions fail competition.select as a
 * CORS "Failed to fetch" (no tRPC code). The shell must show Reconnecting…
 * rather than "Event not found", then recover when the network works again.
 */
import { test, expect } from "@playwright/test";

test.describe("session recovery", () => {
  test("network-class select failure shows reconnecting, not not-found", async ({
    page,
  }) => {
    test.setTimeout(60_000);

    let failSelect = true;
    await page.route("**/trpc/**", async (route) => {
      const url = route.request().url();
      if (failSelect && url.includes("competition.select")) {
        await route.abort("failed");
        return;
      }
      await route.continue();
    });

    await page.goto("/itest");
    await expect(page.getByTestId("session-reconnecting")).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByText("Event not found")).toHaveCount(0);
    await expect(page.getByText(/Reconnecting/)).toBeVisible();

    // Let the shell's one-shot retry succeed.
    failSelect = false;

    await expect(page.getByRole("link", { name: "Dashboard" })).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByText("Event not found")).toHaveCount(0);
  });
});
