/**
 * E2E tests for the unified RegistrationDialog.
 *
 * The RegistrationDialog is a modal overlay rendered at the CompetitionShell level,
 * available from any page. It replaces the old RegistrationPage and RunnerDialog
 * create mode with a single unified flow.
 *
 * Tests cover:
 * - Dialog open/close from various triggers (notification, RecentCards, Add Runner)
 * - Form auto-fill from SI card owner data and runner DB lookup
 * - Registration + kiosk integration (BroadcastChannel)
 * - Sticky mode (batch registration)
 * - Edge cases from previous bug fixes
 * - Dialog working from different pages
 *
 * Uses SI8 card numbers (2000000+) for full punch data support.
 */

import { test, expect, type Page, type BrowserContext } from "@playwright/test";
import { getMockWebSerialScript } from "./helpers/mock-webserial";

declare global {
  interface Window {
    __siMock: {
      insertCard(
        cardNumber: number,
        punches?: Array<{ controlCode: number; time: number }>,
        options?: { hasFinish?: boolean; ownerData?: Record<string, string> },
      ): boolean;
      removeCard(): boolean;
      isConnected(): boolean;
    };
  }
}

const COMPETITION_NAME = "My example tävling";
const API_BASE = "http://localhost:3002";
const COMPETITION_ID = "itest";
const COMP_HEADERS = { "x-competition-id": COMPETITION_ID };

// Course 2 "Bana 2" controls (Öppen 2 class) — 5 controls
const COURSE_2_CONTROLS = [81, 50, 40, 150, 100];

// ─── Helpers ───────────────────────────────────────────────

async function selectCompetition(page: Page) {
  await page.goto("/");
  await page.getByText(COMPETITION_NAME).click();
  await expect(page.getByRole("link", { name: "Dashboard" })).toBeVisible({
    timeout: 10000,
  });
}

function getNameId(page: Page): string {
  const url = new URL(page.url());
  return url.pathname.split("/").filter(Boolean)[0] || "";
}

/** Set up admin page with mock-webserial and connect the reader */
async function setupAdmin(page: Page) {
  await page.addInitScript(getMockWebSerialScript());
  await selectCompetition(page);
  await page.getByTestId("connect-reader").click();
  await expect(page.getByTestId("reader-status")).toBeVisible({ timeout: 5000 });
}

/** Set up admin + kiosk pages in the same browser context */
async function setupAdminAndKiosk(context: BrowserContext) {
  const adminPage = await context.newPage();
  await adminPage.addInitScript(getMockWebSerialScript());
  await selectCompetition(adminPage);
  const nameId = getNameId(adminPage);

  const kioskPage = await context.newPage();
  await kioskPage.goto(`/${nameId}/kiosk`);
  await expect(kioskPage.getByText("Insert your SI card")).toBeVisible({ timeout: 20000 });

  await adminPage.getByTestId("connect-reader").click();
  await expect(adminPage.getByTestId("reader-status")).toBeVisible({ timeout: 10000 });

  return { adminPage, kioskPage, nameId };
}

/** Insert an unregistered SI8 card and wait for resolution */
async function insertUnregisteredCard(page: Page, cardNo: number, punches: Array<{ controlCode: number; time: number }> = [], options?: { ownerData?: Record<string, string> }) {
  const resolutionPromise = page.waitForResponse(
    (resp) => resp.url().includes("/trpc/cardReadout.readout") && resp.status() === 200,
  );
  await page.evaluate(
    ({ cardNo, punches, options }) => {
      window.__siMock.insertCard(cardNo, punches, options);
    },
    { cardNo, punches, options },
  );
  await resolutionPromise;
}

/** Create a runner via direct API call */
async function createRunner(
  request: import("@playwright/test").APIRequestContext,
  name: string,
  cardNo: number,
  classId: number,
  startTime: number,
): Promise<{ id: number }> {
  const resp = await request.post(`${API_BASE}/trpc/runner.create`, {
    headers: COMP_HEADERS,
    data: { name, cardNo, classId, startTime },
  });
  const body = await resp.json();
  const id = body?.result?.data?.id ?? body?.result?.data?.json?.id;
  if (!id) throw new Error(`Failed to create runner: ${JSON.stringify(body).slice(0, 300)}`);
  return { id };
}

/** Look up a class ID by name */
async function getClassId(
  request: import("@playwright/test").APIRequestContext,
  className: string,
): Promise<number> {
  const resp = await request.get(`${API_BASE}/trpc/class.list`, { headers: COMP_HEADERS });
  const body = await resp.json();
  const classes = (body?.result?.data ?? []) as Array<{ id: number; name: string }>;
  const cls = classes.find((c) => c.name === className);
  if (!cls) throw new Error(`Class "${className}" not found`);
  return cls.id;
}

/** Delete a runner (best-effort cleanup) */
async function deleteRunner(request: import("@playwright/test").APIRequestContext, id: number) {
  try {
    await request.post(`${API_BASE}/trpc/runner.delete`, { headers: COMP_HEADERS, data: { id } });
  } catch { /* best effort */ }
}

// ─── Tests ─────────────────────────────────────────────────

test.describe("Registration Dialog", () => {
  // Track created runners for cleanup
  const createdRunnerIds: number[] = [];

  test.afterAll(async ({ request }) => {
    for (const id of createdRunnerIds) {
      await deleteRunner(request, id);
    }
  });

  // ── Group 1: Dialog Open/Close ─────────────────────────

  test.describe("Open/Close", () => {
    test("opens from notification banner without page navigation", async ({ page }) => {
      await setupAdmin(page);

      // Insert unregistered card
      await insertUnregisteredCard(page, 2900001);

      // Notification banner should appear with Register action
      await expect(page.getByTestId("card-notification")).toBeVisible({ timeout: 5000 });
      await expect(page.getByTestId("card-notification-view")).toContainText("Register");

      // Remember current URL (should be dashboard)
      const urlBefore = page.url();

      // Click Register — dialog should open, NOT navigate
      await page.getByTestId("card-notification-view").click();
      await expect(page.getByTestId("registration-dialog")).toBeVisible({ timeout: 5000 });

      // URL should not have changed (still on dashboard)
      expect(page.url()).toBe(urlBefore);
    });

    test("opens from RecentCards panel", async ({ page }) => {
      await setupAdmin(page);
      await insertUnregisteredCard(page, 2900002);

      // Wait for notification to appear, then open the floating RecentCards panel
      await expect(page.getByTestId("card-notification")).toBeVisible({ timeout: 5000 });

      // Open the floating RecentCards panel
      await page.getByTestId("recent-cards-button").click();
      await expect(page.getByTestId("recent-cards-panel")).toBeVisible({ timeout: 3000 });

      // Click the register card entry (identified by card number)
      const panel = page.getByTestId("recent-cards-panel");
      await panel.locator("button").filter({ hasText: String(2900002) }).first().click();

      // Dialog should open
      await expect(page.getByTestId("registration-dialog")).toBeVisible({ timeout: 5000 });
    });

    test("opens from Add Runner button on Runners page", async ({ page }) => {
      await selectCompetition(page);
      const nameId = getNameId(page);
      await page.goto(`/${nameId}/runners`);
      await expect(page.getByRole("button", { name: "Add Runner" })).toBeVisible({ timeout: 10000 });

      // Click Add Runner button
      await page.getByRole("button", { name: "Add Runner" }).click();

      // Registration dialog should open
      await expect(page.getByTestId("registration-dialog")).toBeVisible({ timeout: 5000 });
    });

    test("closes on ESC when not in sticky mode", async ({ page }) => {
      await setupAdmin(page);
      await insertUnregisteredCard(page, 2900003);
      await page.getByTestId("card-notification-view").click();
      await expect(page.getByTestId("registration-dialog")).toBeVisible({ timeout: 5000 });

      // Press ESC
      await page.keyboard.press("Escape");

      // Dialog should close
      await expect(page.getByTestId("registration-dialog")).not.toBeVisible({ timeout: 3000 });
    });

    test("closes on backdrop click", async ({ page }) => {
      await setupAdmin(page);
      await insertUnregisteredCard(page, 2900004);
      await page.getByTestId("card-notification-view").click();
      await expect(page.getByTestId("registration-dialog")).toBeVisible({ timeout: 5000 });

      // Click the backdrop (outside the dialog content)
      await page.getByTestId("registration-dialog-backdrop").click({ position: { x: 10, y: 10 } });

      // Dialog should close
      await expect(page.getByTestId("registration-dialog")).not.toBeVisible({ timeout: 3000 });
    });
  });

  // ── Group 2: Form Auto-Fill ────────────────────────────

  test.describe("Auto-Fill", () => {
    test("SI card owner data pre-fills form", async ({ page }) => {
      await setupAdmin(page);

      // Insert SIAC card with owner data
      const resolutionPromise = page.waitForResponse(
        (resp) => resp.url().includes("/trpc/cardReadout.readout") && resp.status() === 200,
      );
      await page.evaluate(() =>
        window.__siMock.insertCard(8900001, [], {
          ownerData: {
            firstName: "Anna",
            lastName: "Karlsson",
            club: "Test OK",
            sex: "F",
          },
        }),
      );
      await resolutionPromise;

      // Open dialog from notification
      await page.getByTestId("card-notification-view").click();
      await expect(page.getByTestId("registration-dialog")).toBeVisible({ timeout: 5000 });

      // Name should be pre-filled
      await expect(page.getByTestId("registration-dialog").locator("input[placeholder='First Last']")).toHaveValue(
        "Anna Karlsson",
        { timeout: 5000 },
      );
    });

    test("Eventor/RunnerDB card lookup auto-fills without suggestions dropdown", async ({ page }) => {
      await setupAdmin(page);

      // Intercept lookupByCardNo
      await page.route("**/trpc/eventor.lookupByCardNo*", async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            result: {
              data: {
                name: "Testsson, Erik",
                cardNo: 2900010,
                clubEventorId: 0,
                clubName: "Test OK",
                birthYear: 1990,
                sex: "M",
              },
            },
          }),
        });
      });

      await insertUnregisteredCard(page, 2900010);
      await page.getByTestId("card-notification-view").click();
      await expect(page.getByTestId("registration-dialog")).toBeVisible({ timeout: 5000 });

      // Name should be auto-filled from runner DB
      const dialog = page.getByTestId("registration-dialog");
      await expect(dialog.locator("input[placeholder='First Last']")).toHaveValue(
        "Erik Testsson",
        { timeout: 5000 },
      );

      // Suggestions dropdown should NOT be visible
      await expect(dialog.getByTestId("name-suggestions")).not.toBeVisible({ timeout: 2000 });
    });

    test("duplicate card shows warning", async ({ page }) => {
      await setupAdmin(page);

      // Use card 501438 which exists in seed data
      const resolutionPromise = page.waitForResponse(
        (resp) => resp.url().includes("/trpc/cardReadout.readout") && resp.status() === 200,
      );
      await page.evaluate(() => window.__siMock.insertCard(2000501438, []));
      // This card doesn't exist — we need to use one from seed. Let's use manual entry instead.
      await resolutionPromise;

      // Open dialog from notification
      await page.getByTestId("card-notification-view").click();
      await expect(page.getByTestId("registration-dialog")).toBeVisible({ timeout: 5000 });

      // Clear card and enter the duplicate one manually
      const dialog = page.getByTestId("registration-dialog");
      const cardInput = dialog.locator("input[placeholder='e.g. 500123']");
      await cardInput.clear();
      await cardInput.fill("501438");
      await cardInput.press("Tab"); // Trigger lookup

      // Should show duplicate warning
      await expect(dialog.getByText(/already assigned/)).toBeVisible({ timeout: 10000 });
    });
  });

  // ── Group 3: Registration + Kiosk Integration ──────────

  test.describe("Registration + Kiosk", () => {
    test("complete registration updates kiosk and closes dialog", async ({ context }) => {
      const { adminPage, kioskPage } = await setupAdminAndKiosk(context);

      // Insert unregistered card
      await insertUnregisteredCard(adminPage, 2900020);

      // Open dialog
      await adminPage.getByTestId("card-notification-view").click();
      await expect(adminPage.getByTestId("registration-dialog")).toBeVisible({ timeout: 5000 });

      const dialog = adminPage.getByTestId("registration-dialog");

      // Fill form
      await dialog.locator("input[placeholder='First Last']").fill("Test KioskReg");
      await dialog.getByTestId("reg-class").click();
      await expect(adminPage.getByText("Öppen 1", { exact: true })).toBeVisible({ timeout: 3000 });
      await adminPage.getByText("Öppen 1", { exact: true }).click();

      // Submit
      await dialog.getByTestId("reg-submit").click();

      // Kiosk should show registration-complete
      await expect(kioskPage.getByText("Test KioskReg")).toBeVisible({ timeout: 10000 });
      await expect(kioskPage.getByText("Registration Complete!")).toBeVisible({ timeout: 5000 });

      // Dialog should close (non-sticky mode)
      await expect(adminPage.getByTestId("registration-dialog")).not.toBeVisible({ timeout: 5000 });

      // Clean up
      const runnerId = await adminPage.evaluate(async () => {
        const resp = await fetch(`/trpc/runner.findByCard?input=${encodeURIComponent(JSON.stringify({ cardNo: 2900020 }))}`, { headers: { "x-competition-id": "itest" } });
        const data = await resp.json();
        return data?.result?.data?.id;
      });
      if (runnerId) createdRunnerIds.push(runnerId);
    });

    test("kiosk shows form progress during registration", async ({ context }) => {
      const { adminPage, kioskPage } = await setupAdminAndKiosk(context);

      await insertUnregisteredCard(adminPage, 2900021);
      await adminPage.getByTestId("card-notification-view").click();
      await expect(adminPage.getByTestId("registration-dialog")).toBeVisible({ timeout: 5000 });

      // Kiosk should show registration-waiting
      await expect(kioskPage.getByText("Registration in progress")).toBeVisible({ timeout: 10000 });

      // Fill name → kiosk should update
      const dialog = adminPage.getByTestId("registration-dialog");
      await dialog.locator("input[placeholder='First Last']").fill("Test KioskProgress");

      // Kiosk should show the name
      await expect(kioskPage.getByText("Test KioskProgress")).toBeVisible({ timeout: 5000 });

      // Fill class → kiosk should update
      await dialog.getByTestId("reg-class").click();
      await expect(adminPage.getByText("Öppen 2", { exact: true })).toBeVisible({ timeout: 3000 });
      await adminPage.getByText("Öppen 2", { exact: true }).click();

      await expect(kioskPage.getByText("Öppen 2")).toBeVisible({ timeout: 5000 });

      // Submit to complete
      await dialog.getByTestId("reg-submit").click();
      await expect(adminPage.getByTestId("registration-dialog")).not.toBeVisible({ timeout: 5000 });

      // Clean up
      const runnerId = await adminPage.evaluate(async () => {
        const resp = await fetch(`/trpc/runner.findByCard?input=${encodeURIComponent(JSON.stringify({ cardNo: 2900021 }))}`, { headers: { "x-competition-id": "itest" } });
        const data = await resp.json();
        return data?.result?.data?.id;
      });
      if (runnerId) createdRunnerIds.push(runnerId);
    });

    test("registration persists runner in DB", async ({ page, request }) => {
      await setupAdmin(page);
      await insertUnregisteredCard(page, 2900022);
      await page.getByTestId("card-notification-view").click();
      await expect(page.getByTestId("registration-dialog")).toBeVisible({ timeout: 5000 });

      const dialog = page.getByTestId("registration-dialog");
      await dialog.locator("input[placeholder='First Last']").fill("Test PersistDB");
      await dialog.getByTestId("reg-class").click();
      await expect(page.getByRole("button", { name: "Öppen 1" }).first()).toBeVisible({ timeout: 3000 });
      await page.getByRole("button", { name: "Öppen 1" }).first().click();
      await dialog.getByTestId("reg-submit").click();

      // Dialog closes
      await expect(page.getByTestId("registration-dialog")).not.toBeVisible({ timeout: 5000 });

      // Verify via API
      const resp = await request.get(`${API_BASE}/trpc/runner.findByCard?input=${encodeURIComponent(JSON.stringify({ cardNo: 2900022 }))}`, { headers: COMP_HEADERS });
      const body = await resp.json();
      const runner = body?.result?.data;
      expect(runner).toBeTruthy();
      expect(runner.name).toBe("Test PersistDB");
      expect(runner.cardNo).toBe(2900022);
      createdRunnerIds.push(runner.id);
    });
  });

  // ── Group 4: Sticky Mode ──────────────────────────────

  test.describe("Sticky Mode", () => {
    test("sticky toggle persists in localStorage", async ({ page }) => {
      await setupAdmin(page);
      await insertUnregisteredCard(page, 2900030);
      await page.getByTestId("card-notification-view").click();
      await expect(page.getByTestId("registration-dialog")).toBeVisible({ timeout: 5000 });

      // Enable sticky
      await page.getByTestId("reg-sticky-toggle").click();

      // Close dialog — first ESC clears the dirty form (card is pre-filled), second ESC closes
      await page.keyboard.press("Escape");
      await page.keyboard.press("Escape");
      await expect(page.getByTestId("registration-dialog")).not.toBeVisible({ timeout: 3000 });

      // Re-insert card and reopen dialog
      await page.evaluate(() => window.__siMock.removeCard());
      await insertUnregisteredCard(page, 2900031);
      await page.getByTestId("card-notification-view").click();
      await expect(page.getByTestId("registration-dialog")).toBeVisible({ timeout: 5000 });

      // Sticky should still be on
      await expect(page.getByTestId("reg-sticky-toggle")).toBeChecked();
    });

    test("form clears after submit but dialog stays open in sticky mode", async ({ page }) => {
      await setupAdmin(page);
      await insertUnregisteredCard(page, 2900032);
      await page.getByTestId("card-notification-view").click();
      await expect(page.getByTestId("registration-dialog")).toBeVisible({ timeout: 5000 });

      // Enable sticky
      await page.getByTestId("reg-sticky-toggle").click();

      const dialog = page.getByTestId("registration-dialog");
      await dialog.locator("input[placeholder='First Last']").fill("Test Sticky1");
      await dialog.getByTestId("reg-class").click();
      await expect(page.getByRole("button", { name: "Öppen 1" }).first()).toBeVisible({ timeout: 3000 });
      await page.getByRole("button", { name: "Öppen 1" }).first().click();
      await dialog.getByTestId("reg-submit").click();

      // Dialog should stay open
      await expect(page.getByTestId("registration-dialog")).toBeVisible({ timeout: 3000 });

      // Form should be cleared
      await expect(dialog.locator("input[placeholder='First Last']")).toHaveValue("");

      // Clean up
      const runnerId = await page.evaluate(async () => {
        const resp = await fetch(`/trpc/runner.findByCard?input=${encodeURIComponent(JSON.stringify({ cardNo: 2900032 }))}`, { headers: { "x-competition-id": "itest" } });
        const data = await resp.json();
        return data?.result?.data?.id;
      });
      if (runnerId) createdRunnerIds.push(runnerId);
    });

    test("ESC clears dirty form in sticky mode", async ({ page }) => {
      await setupAdmin(page);
      await insertUnregisteredCard(page, 2900033);
      await page.getByTestId("card-notification-view").click();
      await expect(page.getByTestId("registration-dialog")).toBeVisible({ timeout: 5000 });

      // Enable sticky
      await page.getByTestId("reg-sticky-toggle").click();

      // Fill some fields (making form dirty)
      const dialog = page.getByTestId("registration-dialog");
      await dialog.locator("input[placeholder='First Last']").fill("Test DirtyForm");

      // Press ESC — should clear form, NOT close dialog
      await page.keyboard.press("Escape");

      // Dialog still visible
      await expect(page.getByTestId("registration-dialog")).toBeVisible();
      // Form cleared
      await expect(dialog.locator("input[placeholder='First Last']")).toHaveValue("");
    });

    test("ESC closes dialog when form is clean in sticky mode", async ({ page }) => {
      await setupAdmin(page);
      await insertUnregisteredCard(page, 2900034);
      await page.getByTestId("card-notification-view").click();
      await expect(page.getByTestId("registration-dialog")).toBeVisible({ timeout: 5000 });

      // Enable sticky
      await page.getByTestId("reg-sticky-toggle").click();

      // First ESC clears the pre-filled card data
      await page.keyboard.press("Escape");
      // Dialog should still be open (form was dirty from card pre-fill)
      await expect(page.getByTestId("registration-dialog")).toBeVisible();

      // Now form is clean — second ESC closes dialog
      await page.keyboard.press("Escape");
      await expect(page.getByTestId("registration-dialog")).not.toBeVisible({ timeout: 3000 });
    });

    test("next card auto-fills in sticky mode", async ({ page }) => {
      await setupAdmin(page);
      await insertUnregisteredCard(page, 2900035);
      await page.getByTestId("card-notification-view").click();
      await expect(page.getByTestId("registration-dialog")).toBeVisible({ timeout: 5000 });

      // Enable sticky
      await page.getByTestId("reg-sticky-toggle").click();

      // Register first runner
      const dialog = page.getByTestId("registration-dialog");
      await dialog.locator("input[placeholder='First Last']").fill("Test Sticky2");
      await dialog.getByTestId("reg-class").click();
      await expect(page.getByRole("button", { name: "Öppen 1" }).first()).toBeVisible({ timeout: 3000 });
      await page.getByRole("button", { name: "Öppen 1" }).first().click();
      await dialog.getByTestId("reg-submit").click();

      // Form cleared, dialog still open
      await expect(dialog.locator("input[placeholder='First Last']")).toHaveValue("");

      // Remove old card and insert new one
      await page.evaluate(() => window.__siMock.removeCard());

      // Insert new unregistered SIAC card with owner data (must be 7000001-9999999 for ownerData)
      const resolutionPromise = page.waitForResponse(
        (resp) => resp.url().includes("/trpc/cardReadout.readout") && resp.status() === 200,
      );
      await page.evaluate(() =>
        window.__siMock.insertCard(8900036, [], {
          ownerData: { firstName: "Nils", lastName: "Berg" },
        }),
      );
      await resolutionPromise;

      // Dialog should auto-fill with new card data
      await expect(dialog.locator("input[placeholder='First Last']")).toHaveValue(
        "Nils Berg",
        { timeout: 5000 },
      );

      // Clean up first runner
      const runnerId = await page.evaluate(async () => {
        const resp = await fetch(`/trpc/runner.findByCard?input=${encodeURIComponent(JSON.stringify({ cardNo: 2900035 }))}`, { headers: { "x-competition-id": "itest" } });
        const data = await resp.json();
        return data?.result?.data?.id;
      });
      if (runnerId) createdRunnerIds.push(runnerId);
    });

    test("kiosk resets between sticky registrations", async ({ context }) => {
      test.setTimeout(90000);
      const { adminPage, kioskPage } = await setupAdminAndKiosk(context);

      await insertUnregisteredCard(adminPage, 2900037);
      await adminPage.getByTestId("card-notification-view").click();
      await expect(adminPage.getByTestId("registration-dialog")).toBeVisible({ timeout: 10000 });

      // Enable sticky
      await adminPage.getByTestId("reg-sticky-toggle").click();

      // Register
      const dialog = adminPage.getByTestId("registration-dialog");
      await dialog.locator("input[placeholder='First Last']").fill("Test StickyKiosk1");
      await dialog.getByTestId("reg-class").click();
      // Use Öppen 2 which has maps regardless of course imports by earlier tests
      await expect(adminPage.getByRole("button", { name: /Öppen 2/ }).first()).toBeVisible({ timeout: 10000 });
      await adminPage.getByRole("button", { name: /Öppen 2/ }).first().click();
      await dialog.getByTestId("reg-submit").click();

      // Kiosk should show completion briefly then return to idle
      await expect(kioskPage.getByText("Insert your SI card")).toBeVisible({ timeout: 20000 });

      // Insert new card → kiosk should show registration-waiting again
      await adminPage.evaluate(() => window.__siMock.removeCard());
      await insertUnregisteredCard(adminPage, 2900038);

      await expect(kioskPage.getByText("Registration in progress")).toBeVisible({ timeout: 15000 });

      // Clean up
      const runnerId = await adminPage.evaluate(async () => {
        const resp = await fetch(`/trpc/runner.findByCard?input=${encodeURIComponent(JSON.stringify({ cardNo: 2900037 }))}`, { headers: { "x-competition-id": "itest" } });
        const data = await resp.json();
        return data?.result?.data?.id;
      });
      if (runnerId) createdRunnerIds.push(runnerId);
    });
  });

  // ── Group 5: Edge Cases ────────────────────────────────

  test.describe("Edge Cases", () => {
    test("re-read after registration shows pre-start, dialog does NOT reopen", async ({ context, request }) => {
      const { adminPage, kioskPage } = await setupAdminAndKiosk(context);

      const cardNo = 2900040;
      const classId = await getClassId(request, "Öppen 2");
      const runner = await createRunner(request, "Test PreStartEdge", cardNo, classId, 363000);
      createdRunnerIds.push(runner.id);

      // Insert clean card for registered runner → pre-start
      const resolutionPromise = adminPage.waitForResponse(
        (resp) => resp.url().includes("/trpc/cardReadout.readout") && resp.status() === 200,
      );
      await adminPage.evaluate(
        ({ cardNo }) => { window.__siMock.insertCard(cardNo, []); },
        { cardNo },
      );
      await resolutionPromise;

      // Notification should NOT say "Register" — should say "View Start"
      await expect(adminPage.getByTestId("card-notification-view")).toContainText("View Start", { timeout: 5000 });

      // Dialog should NOT be open
      await expect(adminPage.getByTestId("registration-dialog")).not.toBeVisible();

      // Kiosk should show pre-start
      await expect(kioskPage.getByText("Ready to Start")).toBeVisible({ timeout: 10000 });
      await expect(kioskPage.getByText("Test PreStartEdge")).toBeVisible();
    });

    test("re-read with punches after registration shows readout", async ({ context, request }) => {
      const { adminPage, kioskPage } = await setupAdminAndKiosk(context);

      const cardNo = 2900041;
      const classId = await getClassId(request, "Öppen 2");
      const runner = await createRunner(request, "Test ReadoutEdge", cardNo, classId, 363000);
      createdRunnerIds.push(runner.id);

      // Insert card with course punches → readout
      const readoutPromise = adminPage.waitForResponse(
        (resp) => resp.url().includes("/trpc/cardReadout.readout") && resp.status() === 200,
      );
      const applyPromise = adminPage.waitForResponse(
        (resp) => resp.url().includes("/trpc/cardReadout.applyResult") && resp.status() === 200,
      );
      await adminPage.evaluate(
        ({ cardNo, controls }) => {
          const punches = controls.map((code: number, i: number) => ({
            controlCode: code,
            time: 36600 + i * 120,
          }));
          window.__siMock.insertCard(cardNo, punches);
        },
        { cardNo, controls: COURSE_2_CONTROLS },
      );
      await readoutPromise;

      // Kiosk should show readout
      await expect(kioskPage.getByText("Test ReadoutEdge")).toBeVisible({ timeout: 10000 });
      await expect(kioskPage.getByText("Completed")).toBeVisible();

      // Dialog should NOT be open
      await expect(adminPage.getByTestId("registration-dialog")).not.toBeVisible();

      await applyPromise;
    });

    test("closing dialog during registration returns kiosk to idle", async ({ context }) => {
      const { adminPage, kioskPage } = await setupAdminAndKiosk(context);

      await insertUnregisteredCard(adminPage, 2900042);
      await adminPage.getByTestId("card-notification-view").click();
      await expect(adminPage.getByTestId("registration-dialog")).toBeVisible({ timeout: 5000 });

      // Kiosk should be in registration-waiting
      await expect(kioskPage.getByText("Registration in progress")).toBeVisible({ timeout: 10000 });

      // Close dialog via ESC (form is dirty from card pre-fill, non-sticky → closes)
      await adminPage.keyboard.press("Escape");
      await expect(adminPage.getByTestId("registration-dialog")).not.toBeVisible({ timeout: 3000 });

      // Kiosk should return to idle
      await expect(kioskPage.getByText("Insert your SI card")).toBeVisible({ timeout: 15000 });
    });

    test("heartbeat keeps registration watchdog alive", async ({ context }) => {
      const { adminPage, kioskPage } = await setupAdminAndKiosk(context);

      await insertUnregisteredCard(adminPage, 2900043);
      await adminPage.getByTestId("card-notification-view").click();
      await expect(adminPage.getByTestId("registration-dialog")).toBeVisible({ timeout: 5000 });

      // Kiosk should be in registration-waiting
      await expect(kioskPage.getByText("Registration in progress")).toBeVisible({ timeout: 10000 });

      // Wait beyond the 15s watchdog timeout (heartbeat at 2s intervals keeps it alive).
      // This is an intentional fixed wait to verify the watchdog does NOT fire.
      await adminPage.waitForTimeout(18000);

      // Kiosk should STILL show registration-waiting (heartbeat kept it alive)
      await expect(kioskPage.getByText("Registration in progress")).toBeVisible();
    });
  });

  // ── Group 6: Dialog on Various Pages ───────────────────

  test.describe("Works from various pages", () => {
    test("works from Dashboard page", async ({ page }) => {
      await setupAdmin(page);
      const nameId = getNameId(page);

      // Should already be on dashboard
      expect(page.url()).toContain(nameId);

      await insertUnregisteredCard(page, 2900050);
      await page.getByTestId("card-notification-view").click();
      await expect(page.getByTestId("registration-dialog")).toBeVisible({ timeout: 5000 });

      const dialog = page.getByTestId("registration-dialog");
      await dialog.locator("input[placeholder='First Last']").fill("Test FromDashboard");
      await dialog.getByTestId("reg-class").click();
      // Use Öppen 3 which always has maps remaining
      await expect(dialog.locator("button").filter({ hasText: "Öppen 3" })).toBeVisible({ timeout: 3000 });
      await dialog.locator("button").filter({ hasText: "Öppen 3" }).click();
      await dialog.getByTestId("reg-submit").click();

      // Dialog closes, still on dashboard
      await expect(page.getByTestId("registration-dialog")).not.toBeVisible({ timeout: 5000 });
      await expect(page.getByRole("link", { name: "Dashboard" })).toBeVisible();

      // Clean up
      const runnerId = await page.evaluate(async () => {
        const resp = await fetch(`/trpc/runner.findByCard?input=${encodeURIComponent(JSON.stringify({ cardNo: 2900050 }))}`, { headers: { "x-competition-id": "itest" } });
        const data = await resp.json();
        return data?.result?.data?.id;
      });
      if (runnerId) createdRunnerIds.push(runnerId);
    });

    test("works from Results page", async ({ page }) => {
      await page.addInitScript(getMockWebSerialScript());
      await selectCompetition(page);
      const nameId = getNameId(page);
      // Navigate via tab click to stay in SPA (no page reload)
      await page.getByRole("link", { name: "Results" }).click();
      await expect(page.url()).toContain("/results");
      // Connect reader
      await page.getByTestId("connect-reader").click();
      await expect(page.getByTestId("reader-status")).toBeVisible({ timeout: 5000 });

      await insertUnregisteredCard(page, 2900051);
      await page.getByTestId("card-notification-view").click();
      await expect(page.getByTestId("registration-dialog")).toBeVisible({ timeout: 5000 });

      const dialog = page.getByTestId("registration-dialog");
      await dialog.locator("input[placeholder='First Last']").fill("Test FromResults");
      await dialog.getByTestId("reg-class").click();
      // Use Öppen 3 which always has maps remaining
      await expect(dialog.locator("button").filter({ hasText: "Öppen 3" })).toBeVisible({ timeout: 3000 });
      await dialog.locator("button").filter({ hasText: "Öppen 3" }).click();
      await dialog.getByTestId("reg-submit").click();

      // Dialog closes, still on results page
      await expect(page.getByTestId("registration-dialog")).not.toBeVisible({ timeout: 5000 });
      expect(page.url()).toContain("/results");

      // Clean up
      const runnerId = await page.evaluate(async () => {
        const resp = await fetch(`/trpc/runner.findByCard?input=${encodeURIComponent(JSON.stringify({ cardNo: 2900051 }))}`, { headers: { "x-competition-id": "itest" } });
        const data = await resp.json();
        return data?.result?.data?.id;
      });
      if (runnerId) createdRunnerIds.push(runnerId);
    });
  });
});
