/**
 * Station resilience with the server unreachable (review package 9:
 * WEB-03, WEB-04, SYNC-11; docs/system/offline-architecture.md "Station
 * resilience"). The normal arena failure is "Wi-Fi up, node unreachable":
 * `navigator.onLine` stays true. These tests abort `/trpc` requests with
 * `page.route` for that case and use `context.setOffline` only where the
 * browser itself must report offline.
 */
import { test, expect, type Page, type Route } from "@playwright/test";
import { API_BASE } from "./helpers/api-base";
import { trpcProcedures, waitForTrpc } from "./helpers/trpc";
import { reseed } from "./helpers/reseed";

const COMPETITION_NAME = "My example tävling";
const NAMEID = "itest";

async function openEvent(page: Page) {
  await page.goto("/");
  await page.getByText(COMPETITION_NAME).click();
  await expect(page.getByRole("link", { name: "Dashboard" })).toBeVisible({ timeout: 10_000 });
}

/** Open Runners and wait until the persisted per-event blob holds the runner list. */
async function warmCache(page: Page) {
  const listed = waitForTrpc(page, "runner.list", { timeout: 15_000 });
  await page.getByRole("link", { name: "Runners", exact: true }).click();
  await listed;
  await expect
    .poll(
      () =>
        page.evaluate(async (nameId) => {
          // idb-keyval's default store: database "keyval-store", object store "keyval".
          const db = await new Promise<IDBDatabase>((res, rej) => {
            const r = indexedDB.open("keyval-store");
            r.onsuccess = () => res(r.result);
            r.onerror = () => rej(r.error);
          });
          try {
            if (!db.objectStoreNames.contains("keyval")) return false;
            const keys = await new Promise<IDBValidKey[]>((res) => {
              const req = db.transaction("keyval").objectStore("keyval").getAllKeys();
              req.onsuccess = () => res(req.result);
              req.onerror = () => res([]);
            });
            return keys.some((k) => String(k).includes(nameId));
          } finally {
            db.close();
          }
        }, NAMEID),
      { timeout: 10_000 },
    )
    .toBe(true);
  // The blob is written on a throttle; give the last write (runner.list) time to land.
  await page.waitForTimeout(1_500);
}

/** Abort every tRPC request (optionally only some procedures) as "no answer". */
async function cutTrpc(page: Page, only?: (procs: string[]) => boolean) {
  const handler = async (route: Route) => {
    const procs = trpcProcedures(route.request().url());
    if (!only || only(procs)) return route.abort("failed");
    return route.continue();
  };
  await page.route("**/trpc/**", handler);
  return () => page.unroute("**/trpc/**", handler);
}

async function pendingCount(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        const r = indexedDB.open("oxygen-offline");
        r.onsuccess = () => {
          const db = r.result;
          if (!db.objectStoreNames.contains("events")) {
            db.close();
            return resolve(0);
          }
          const c = db.transaction("events").objectStore("events").index("status").count("pending");
          c.onsuccess = () => {
            resolve(c.result);
            db.close();
          };
          c.onerror = () => {
            resolve(0);
            db.close();
          };
        };
        r.onerror = () => resolve(0);
      }),
  );
}

test.describe("station with the server unreachable", () => {
  test.beforeAll(reseed);

  test("a reload during the outage opens the event from cache, stays mounted, and turns live by itself", async ({ page }) => {
    test.setTimeout(90_000);
    await openEvent(page);
    await warmCache(page);

    const restore = await cutTrpc(page);
    await page.reload();

    // WEB-03: the shell opens from the cached dashboard, in cached mode.
    const shell = page.locator("[data-connection]");
    await expect(shell).toHaveAttribute("data-connection", "cached", { timeout: 20_000 });
    await expect(page.locator("header").getByText(COMPETITION_NAME)).toBeVisible();
    await expect(page.locator("table")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId("shell-cached-mode")).toBeVisible();

    // WEB-04: users.me keeps failing, the app neither spins nor reloads itself.
    await page.evaluate(() => {
      (window as unknown as { __noReload: boolean }).__noReload = true;
    });
    await page.waitForTimeout(5_000);
    expect(await page.evaluate(() => (window as unknown as { __noReload?: boolean }).__noReload)).toBe(true);
    await expect(page.locator("header").getByText(COMPETITION_NAME)).toBeVisible();

    // The server answers again: the shell reconnects without a click.
    await restore();
    await expect(shell).toHaveAttribute("data-connection", "live", { timeout: 40_000 });
    await expect(page.getByTestId("shell-cached-mode")).toHaveCount(0);
  });

  test("re-entering the event after the browser went offline opens it (no paused select)", async ({ page, context }) => {
    test.setTimeout(60_000);
    await openEvent(page);
    await warmCache(page);

    await context.setOffline(true);
    // Back to the event list, then into the event again by client-side navigation.
    // Client-side navigation only: offline, a document load would fail.
    const go = (path: string) =>
      page.evaluate((p) => {
        history.pushState({}, "", p);
        dispatchEvent(new PopStateEvent("popstate"));
      }, path);
    await go("/");
    await expect(page.getByRole("link", { name: "Dashboard" })).toHaveCount(0, { timeout: 10_000 });
    await go("/itest/runners");
    await expect(page.locator("header").getByText(COMPETITION_NAME)).toBeVisible({ timeout: 15_000 });
    await expect(page.locator("table")).toBeVisible({ timeout: 10_000 });
    await context.setOffline(false);
  });

  test("without a cache the retry page opens the event once the server answers", async ({ browser }) => {
    test.setTimeout(60_000);
    // A fresh context: nothing cached for this event.
    const context = await browser.newContext();
    const page = await context.newPage();
    const restore = await cutTrpc(page, (procs) => procs.includes("competition.select"));
    await page.goto(`/${NAMEID}`);
    await expect(page.getByTestId("shell-unreachable")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("shell-retry")).toBeVisible();
    await expect(page.getByText("Event not found")).toHaveCount(0);

    await restore();
    await page.getByTestId("shell-retry").click();
    await expect(page.getByRole("link", { name: "Dashboard" })).toBeVisible({ timeout: 15_000 });
    await context.close();
  });

  test("a queued entry whose drain failed goes out by itself (SYNC-11)", async ({ page, context, request }) => {
    test.setTimeout(90_000);
    const runnerName = `E2E Outage Runner ${Date.now()}`;
    await openEvent(page);
    await warmCache(page);

    // Queue a registration while offline.
    await context.setOffline(true);
    await page.getByRole("button", { name: /Add runner|Lägg till/i }).click();
    const dialog = page.getByTestId("registration-dialog");
    await expect(dialog).toBeVisible({ timeout: 5_000 });
    await dialog.locator("input[placeholder='First Last']").fill(runnerName);
    const classSelect = dialog.getByTestId("reg-class");
    await classSelect.getByRole("button").click();
    await classSelect.getByText("Öppen 3").click();
    await dialog.getByTestId("reg-submit").click();
    await expect(dialog).not.toBeVisible({ timeout: 10_000 });
    expect(await pendingCount(page)).toBeGreaterThanOrEqual(1);

    // Back online, but the first push gets no answer (node still rebooting).
    let aborted = 0;
    await page.route("**/trpc/**", async (route) => {
      if (aborted === 0 && trpcProcedures(route.request().url()).includes("events.push")) {
        aborted++;
        return route.abort("failed");
      }
      return route.continue();
    });
    await context.setOffline(false);
    await expect.poll(() => aborted, { timeout: 10_000 }).toBe(1);

    // No click: the retry (2 s after the failure) drains it.
    await expect.poll(() => pendingCount(page), { timeout: 20_000 }).toBe(0);

    const resp = await request.get(`${API_BASE}/trpc/runner.list`, { headers: { "x-competition-id": NAMEID } });
    const runners = ((await resp.json())?.result?.data ?? []) as Array<{ id: number; name: string }>;
    const created = runners.find((r) => r.name === runnerName);
    expect(created).toBeDefined();
    await request.post(`${API_BASE}/trpc/runner.delete`, {
      data: { id: created!.id },
      headers: { "x-competition-id": NAMEID },
    });
  });
});
