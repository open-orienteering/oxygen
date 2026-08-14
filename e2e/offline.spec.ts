/**
 * E2E tests for offline-first architecture.
 *
 * Tests the full offline lifecycle:
 * - Competition loads from cache when offline
 * - Registration works offline (event queued in IndexedDB)
 * - Events drain to server when connectivity returns
 * - Runner appears in DB after sync
 *
 * Uses Playwright's context.setOffline() to simulate network outages.
 */

import { test, expect, type Page } from "@playwright/test";

const COMPETITION_NAME = "My example tävling";
const API_BASE = "http://127.0.0.1:3002";
const NAMEID = "itest";

// ─── Helpers ───────────────────────────────────────────────

async function selectCompetition(page: Page) {
  await page.goto("/");
  await page.getByText(COMPETITION_NAME).click();
  await expect(page.getByRole("link", { name: "Dashboard" })).toBeVisible({
    timeout: 10000,
  });
}

/** Navigate to runners tab and wait for data to load — ensures useStationSync caches everything */
async function warmStationCache(page: Page) {
  await page.getByRole("link", { name: "Runners", exact: true }).click();
  // tRPC batches multiple procedures into one URL like
  // `/trpc/class.list,runner.list,competition.dashboard?batch=1&...`, so
  // we match `runner.list` as a substring anywhere in the URL rather than
  // anchoring on `/trpc/runner.list` (which only catches it when batched
  // first alphabetically).
  await page.waitForResponse(
    (resp) =>
      resp.url().includes("runner.list") &&
      resp.url().includes("/trpc/") &&
      resp.status() === 200,
    { timeout: 15000 },
  );
  // Give React Query time to persist to IndexedDB (~100-300ms in practice)
  await page.waitForTimeout(500);
}

/** Get pending event count from IndexedDB */
async function getPendingEventCount(page: Page): Promise<number> {
  return page.evaluate(async () => {
    return new Promise<number>((resolve) => {
      const request = indexedDB.open("oxygen-offline");
      request.onsuccess = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains("events")) {
          db.close();
          resolve(0);
          return;
        }
        const tx = db.transaction("events", "readonly");
        const store = tx.objectStore("events");
        const index = store.index("status");
        const countReq = index.count("pending");
        countReq.onsuccess = () => {
          resolve(countReq.result);
          db.close();
        };
        countReq.onerror = () => {
          resolve(0);
          db.close();
        };
      };
      request.onerror = () => resolve(0);
    });
  });
}

/** Get all events from IndexedDB */
async function getAllEvents(
  page: Page,
): Promise<Array<{ id: string; type: string; status: string; payload: Record<string, unknown> }>> {
  return page.evaluate(async () => {
    return new Promise((resolve) => {
      const request = indexedDB.open("oxygen-offline");
      request.onsuccess = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains("events")) {
          db.close();
          resolve([]);
          return;
        }
        const tx = db.transaction("events", "readonly");
        const store = tx.objectStore("events");
        const getAll = store.getAll();
        getAll.onsuccess = () => {
          resolve(getAll.result);
          db.close();
        };
        getAll.onerror = () => {
          resolve([]);
          db.close();
        };
      };
      request.onerror = () => resolve([]);
    });
  });
}

/** Check if a runner exists in the DB by name (uses API with competition header) */
async function runnerExistsInDb(
  request: import("@playwright/test").APIRequestContext,
  name: string,
): Promise<boolean> {
  const resp = await request.get(`${API_BASE}/trpc/runner.list`, {
    headers: { "x-competition-id": NAMEID },
  });
  const body = await resp.json();
  const runners = (body?.result?.data ?? []) as Array<{ name: string }>;
  return runners.some((r) => r.name === name);
}

/** Delete a runner by name (best-effort cleanup) */
async function deleteRunnerByName(
  request: import("@playwright/test").APIRequestContext,
  name: string,
) {
  try {
    const resp = await request.get(`${API_BASE}/trpc/runner.list`, {
      headers: { "x-competition-id": NAMEID },
    });
    const body = await resp.json();
    const runners = (body?.result?.data ?? []) as Array<{ id: number; name: string }>;
    const runner = runners.find((r) => r.name === name);
    if (runner) {
      await request.post(`${API_BASE}/trpc/runner.delete`, {
        data: { id: runner.id },
        headers: { "x-competition-id": NAMEID },
      });
    }
  } catch {
    /* best effort */
  }
}

/** Register a runner via the UI dialog */
async function registerRunnerViaDialog(page: Page, name: string, className: string) {
  // Open dialog via Add runner button on Runners page
  const addBtn = page.getByRole("button", { name: /Add runner|Lägg till/i });
  await addBtn.click();

  const dialog = page.getByTestId("registration-dialog");
  await expect(dialog).toBeVisible({ timeout: 5000 });

  // Fill name — uses placeholder "First Last" (dismisses "Waiting for card" overlay)
  await dialog.locator("input[placeholder='First Last']").fill(name);

  // Select class
  const classSelect = dialog.getByTestId("reg-class");
  await classSelect.getByRole("button").click();
  await classSelect.getByText(className).click();

  // Submit
  await dialog.getByTestId("reg-submit").click();

  // Wait for dialog to close (success)
  await expect(dialog).not.toBeVisible({ timeout: 10000 });
}

// ─── Tests ─────────────────────────────────────────────────

test.describe("Offline Support", () => {
  test("should keep competition functional when going offline", async ({ page, context }) => {
    // Visit while online to cache data
    await selectCompetition(page);
    await warmStationCache(page);

    // Go to dashboard
    await page.getByRole("link", { name: "Dashboard" }).click();
    await expect(page.getByRole("link", { name: "Dashboard" })).toBeVisible();

    // Go offline
    await context.setOffline(true);

    // Competition should still be functional — navigate between tabs
    await page.getByRole("link", { name: "Runners", exact: true }).click();
    // Runner list should render from cache
    await expect(page.locator("table")).toBeVisible({ timeout: 10000 });

    // Header should still show competition name
    await expect(
      page.locator("header").getByText(COMPETITION_NAME),
    ).toBeVisible();

    // Tabs should still be navigable
    await page.getByRole("link", { name: "Dashboard" }).click();
    await expect(page.getByRole("link", { name: "Dashboard" })).toBeVisible();

    await context.setOffline(false);
  });

  test("should register a runner while offline and sync when back online", async ({
    page,
    context,
    request,
  }) => {
    const runnerName = "E2E Offline Runner " + Date.now();

    // 1. Visit competition and cache data
    await selectCompetition(page);
    await warmStationCache(page);

    // Verify runner doesn't exist
    expect(await runnerExistsInDb(request, runnerName)).toBe(false);

    // 2. Go offline
    await context.setOffline(true);

    // 3. Register runner via dialog (offline)
    await registerRunnerViaDialog(page, runnerName, "Öppen 1");

    // 4. Verify event was queued in IndexedDB
    const pendingCount = await getPendingEventCount(page);
    expect(pendingCount).toBeGreaterThanOrEqual(1);

    const events = await getAllEvents(page);
    const regEvent = events.find(
      (e) => e.type === "runner.registered" && (e.payload as any).name === runnerName,
    );
    expect(regEvent).toBeDefined();
    expect(regEvent!.status).toBe("pending");

    // 5. Go back online
    await context.setOffline(false);

    // 6. Wait for auto-drain (useEventQueue polls every 2s, then drains)
    // Use polling to check rather than a fixed wait
    await expect(async () => {
      const remaining = await getPendingEventCount(page);
      expect(remaining).toBe(0);
    }).toPass({ intervals: [1000, 1000, 2000, 2000, 3000], timeout: 15000 });

    // 7. Verify event status changed to synced
    const eventsAfter = await getAllEvents(page);
    const syncedEvent = eventsAfter.find(
      (e) => e.type === "runner.registered" && (e.payload as any).name === runnerName,
    );
    expect(syncedEvent).toBeDefined();
    expect(syncedEvent!.status).toBe("synced");

    // 8. Verify runner exists in DB
    expect(await runnerExistsInDb(request, runnerName)).toBe(true);

    // Cleanup
    await deleteRunnerByName(request, runnerName);
  });

  test("should show pending count in sync indicator while offline", async ({
    page,
    context,
  }) => {
    const runnerName = "E2E Indicator Runner " + Date.now();

    // Cache data
    await selectCompetition(page);
    await warmStationCache(page);

    // Go offline and register
    await context.setOffline(true);
    await registerRunnerViaDialog(page, runnerName, "Öppen 1");

    // The sync status button should show a pending count badge
    // The button has a title of "Sync Status" or "Synkstatus"
    const syncButton = page.locator('button[title="Sync Status"], button[title="Synkstatus"]');
    await expect(syncButton).toBeVisible({ timeout: 5000 });

    // Should have a pending count badge (the amber number pill)
    const badge = syncButton.locator("span.bg-amber-500");
    await expect(badge).toBeVisible({ timeout: 5000 });
    const badgeText = await badge.textContent();
    expect(parseInt(badgeText ?? "0")).toBeGreaterThanOrEqual(1);

    // Go online and wait for drain
    await context.setOffline(false);
    await expect(async () => {
      const count = await getPendingEventCount(page);
      expect(count).toBe(0);
    }).toPass({ intervals: [1000, 2000, 2000, 3000], timeout: 15000 });

    // Badge should disappear after sync
    await expect(badge).not.toBeVisible({ timeout: 5000 });
  });

  test("surfaces server-rejected entries with retry/discard (no silent drops)", async ({
    page,
  }) => {
    await selectCompetition(page);

    // Inject a poison outbox entry directly into IndexedDB: a
    // punch.recorded with an empty payload, which the server's apply
    // validation rejects. The auto-drain picks it up within ~2s.
    await page.evaluate(async () => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open("oxygen-offline");
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction("events", "readwrite");
        tx.objectStore("events").put({
          id: crypto.randomUUID(),
          type: "punch.recorded",
          competitionId: "itest",
          stationId: "e2e-poison",
          timestamp: Date.now(),
          hlc: { physical: Date.now(), logical: 0 },
          schemaVersion: 1,
          actorId: null,
          payload: {}, // malformed on purpose — server rejects the apply
          status: "pending",
          attempts: 0,
        });
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
      db.close();
    });

    // The red rejected badge appears once the drain fails the entry.
    const failedBadge = page.getByTestId("sync-failed-badge");
    await expect(failedBadge).toBeVisible({ timeout: 15000 });
    await expect(failedBadge).toHaveText("1");

    // Open the panel: the rejection is listed with its error and actions.
    await page.getByTestId("sync-status-button").click();
    await expect(page.getByTestId("sync-failed-panel")).toBeVisible();
    await expect(page.getByTestId("sync-failed-panel")).toContainText(
      "punch.recorded",
    );

    // Discard it (deliberate operator action behind a confirm).
    page.on("dialog", (dialog) => dialog.accept());
    await page
      .getByTestId("sync-failed-panel")
      .locator("button", { hasText: /Discard|Släng/ })
      .click();

    await expect(page.getByTestId("sync-failed-panel")).not.toBeVisible({
      timeout: 5000,
    });
    await expect(failedBadge).not.toBeVisible({ timeout: 10000 });
  });

  test("resilience mode toggle serves station reads from the snapshot cache", async ({
    page,
    context,
  }) => {
    await selectCompetition(page);
    await warmStationCache(page);

    // Flip the flag through the sync panel (persisted in localStorage).
    await page.getByTestId("sync-status-button").click();
    await page.getByTestId("resilience-mode-toggle").check();
    await page.locator(".fixed.inset-0").click(); // close the panel

    // Wait until the projection sync has hydrated the Dexie snapshot cache.
    await expect(async () => {
      const count = await page.evaluate(async () => {
        const db = await new Promise<IDBDatabase>((resolve, reject) => {
          const req = indexedDB.open("oxygen-offline");
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
        });
        const n = await new Promise<number>((resolve, reject) => {
          const tx = db.transaction("projRunners", "readonly");
          const req = tx.objectStore("projRunners").count();
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
        });
        db.close();
        return n;
      });
      expect(count).toBeGreaterThan(0);
    }).toPass({ intervals: [500, 1000, 1000, 2000], timeout: 15000 });

    // Open the Finish Station while online (full page loads offline are the
    // production service worker's job — the dev server has no SW precache),
    // then cut the network. The card lookup must still resolve a seeded
    // runner — served from the snapshot cache, not tRPC.
    await page.goto("/itest/finish-station");
    const cardInput = page.locator('input[type="number"]').first();
    await expect(cardInput).toBeVisible({ timeout: 10000 });
    await context.setOffline(true);
    await cardInput.fill("500803");
    await expect(page.getByText("Monica Henriksson")).toBeVisible({
      timeout: 10000,
    });

    await context.setOffline(false);
    // Reset the flag so later specs see default behaviour.
    await page.evaluate(() =>
      localStorage.removeItem("oxygen-offline-projection"),
    );
  });
});
