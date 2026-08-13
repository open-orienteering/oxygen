/**
 * Per-event lease E2E (pivot Step 4).
 *
 * Drives the single-node-visible half of the lease: a peer "checks the
 * event out" via the node-to-node lease surface (lease.acquire with the
 * shared sync secret configured in playwright.config.ts), and this node
 * must show the amber badge, reject race-critical writes with the typed
 * error, and offer force-takeover on the Event page.
 */

import { test, expect, type APIRequestContext } from "@playwright/test";

const API = "http://127.0.0.1:3002";
const EVENT = "itest";
const SECRET = "e2e-sync-secret";

async function acquireLease(request: APIRequestContext, holder: string) {
  const res = await request.post(`${API}/trpc/lease.acquire`, {
    headers: {
      "content-type": "application/json",
      "x-event-id": EVENT,
      "x-oxygen-sync-secret": SECRET,
    },
    data: { holderNodeId: holder },
  });
  expect(res.ok()).toBe(true);
}

async function releaseLeaseIfAny(request: APIRequestContext) {
  await request.post(`${API}/trpc/lease.release`, {
    headers: {
      "content-type": "application/json",
      "x-event-id": EVENT,
      "x-oxygen-sync-secret": SECRET,
    },
    data: { holderNodeId: "venue-e2e" },
  });
}

test.describe("Venue lease", () => {
  test.afterEach(async ({ request }) => {
    await releaseLeaseIfAny(request);
  });

  test("no badge and writable when no lease is active", async ({ page }) => {
    await page.goto(`/${EVENT}`);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(page.getByTestId("lease-badge")).toHaveCount(0);
  });

  test("checked-out event shows the badge and rejects race-critical writes", async ({
    page,
    request,
  }) => {
    await acquireLease(request, "venue-e2e");

    await page.goto(`/${EVENT}`);
    await expect(page.getByTestId("lease-badge")).toBeVisible();
    await expect(page.getByTestId("lease-badge")).toContainText("venue-e2e");

    // The typed guard: a race-critical mutation fails PRECONDITION_FAILED.
    const res = await request.post(`${API}/trpc/race.recordFinish`, {
      headers: {
        "content-type": "application/json",
        "x-event-id": EVENT,
      },
      data: { id: 1, finishTimeAbsolute: 366000 },
    });
    expect(res.status()).toBe(412);
    const body = await res.json();
    expect(JSON.stringify(body)).toContain("PRECONDITION_FAILED");

    // The journal sink stays open for station outbox drains.
    const push = await request.post(`${API}/trpc/events.push`, {
      headers: {
        "content-type": "application/json",
        "x-event-id": EVENT,
      },
      data: {
        events: [
          {
            id: crypto.randomUUID(),
            type: "punch.recorded",
            competitionId: EVENT,
            stationId: "e2e-station",
            timestamp: Date.now(),
            payload: { cardNo: 999111, controlCode: 77, time: 361234 },
          },
        ],
      },
    });
    expect(push.ok()).toBe(true);
  });

  test("event page offers force takeover and it restores writes", async ({
    page,
    request,
  }) => {
    await acquireLease(request, "venue-e2e");

    await page.goto(`/${EVENT}/event`);
    await expect(page.getByTestId("lease-panel")).toBeVisible();
    await expect(page.getByTestId("lease-force-takeover")).toBeVisible();

    page.on("dialog", (dialog) => dialog.accept());
    await page.getByTestId("lease-force-takeover").click();

    // Badge clears once the takeover lands and status refetches.
    await expect(page.getByTestId("lease-force-takeover")).toHaveCount(0, {
      timeout: 15_000,
    });
    await expect(page.getByTestId("lease-badge")).toHaveCount(0);

    // And the server agrees the lease is gone.
    const status = await request.get(`${API}/trpc/lease.status`, {
      headers: { "x-event-id": EVENT },
    });
    expect(status.ok()).toBe(true);
    expect(await status.text()).toContain('"lease":null');
  });
});
