import { expect, test } from "@playwright/test";
import { selectEvent } from "./helpers/print-pdf";

/**
 * The service worker during an outage (review package 9: SYNC-16, WEB-03;
 * docs/system/offline-architecture.md "Station resilience"). Only the
 * preview stack registers the worker (docs/dev/e2e-sharding.md "The
 * preview stack"), so this is the one place the production path is seen:
 * the worker has no `/trpc` route any more, so a tRPC call with the node
 * unreachable fails instead of answering a stale 200 from Cache Storage,
 * and the event still opens from the precached bundle plus the persisted
 * per-event query cache.
 */

async function controlledPage(page: import("@playwright/test").Page) {
  await page.goto("/");
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await page.reload();
  expect(await page.evaluate(() => navigator.serviceWorker.controller?.scriptURL ?? null)).toMatch(/\/sw\.js$/);
}

test.describe("service worker with the server unreachable (SYNC-16)", () => {
  test("no tRPC cache: a call with no answer fails, and the event opens from the persisted cache", async ({ page, context }) => {
    test.setTimeout(120_000);
    page.setDefaultTimeout(15_000);
    await controlledPage(page);
    await selectEvent(page);
    await page.getByRole("link", { name: "Runners", exact: true }).click();
    await expect(page.locator("table")).toBeVisible();
    // Let the persister write the event's blob (throttled).
    await page.waitForTimeout(2_000);

    // The old runtime caches are gone and none is filled again.
    const names = await page.evaluate(() => caches.keys());
    expect(names).not.toContain("trpc-api");
    expect(names).not.toContain("api-misc");

    // The node stops answering while the browser stays online.
    await context.route("**/trpc/**", (route) => route.abort("failed"));
    const outcome = await page.evaluate(async () => {
      try {
        const r = await fetch("/trpc/competition.dashboard", { headers: { "x-competition-id": "itest" } });
        return `answered ${r.status}`;
      } catch {
        return "failed";
      }
    });
    expect(outcome).toBe("failed");

    // A reload during the outage: bundle from the precache, data from the
    // persisted per-event cache, shell in cached mode.
    await page.reload();
    await expect(page.locator("[data-connection]")).toHaveAttribute("data-connection", "cached", { timeout: 30_000 });
    await expect(page.locator("header").getByText("My example tävling")).toBeVisible();
    await expect(page.locator("table")).toBeVisible();
    expect(await page.evaluate(() => caches.keys())).not.toContain("trpc-api");

    await context.unroute("**/trpc/**");
    await expect(page.locator("[data-connection]")).toHaveAttribute("data-connection", "live", { timeout: 40_000 });
  });
});
