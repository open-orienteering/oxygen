/**
 * E2E tests for the kiosk readout station flow.
 *
 * Tests the critical path: mock-webserial card read → DeviceManager pipeline →
 * runner status updated in DB → correct kiosk readout screen displayed.
 *
 * Uses two pages in the same browser context (BroadcastChannel IPC):
 * - Admin page: mock-webserial connected, processes card reads
 * - Kiosk page: receives readout messages, displays result screens
 *
 * IMPORTANT: Uses SI8 card numbers (2000000+) because SI5/SI6 cards only get
 * minimal readout (card number only) from the WebSerial parser — no punch data.
 */

import { test, expect, type Page, type BrowserContext } from "@playwright/test";
import { getMockWebSerialScript } from "./helpers/mock-webserial";

declare global {
  interface Window {
    __siMock: {
      insertCard(
        cardNumber: number,
        punches?: Array<{ controlCode: number; time: number }>,
        options?: { hasFinish?: boolean },
      ): boolean;
      removeCard(): boolean;
      isConnected(): boolean;
    };
  }
}

const COMPETITION_NAME = "My example tävling";
const API_BASE = "http://localhost:3002";

// Course 2 "Bana 2" controls (Öppen 2 class) — only 5 controls, manageable
const COURSE_2_CONTROLS = [81, 50, 40, 150, 100];

// ─── Helpers ───────────────────────────────────────────────

async function selectCompetition(page: Page) {
  await page.goto("/");
  await page.getByText(COMPETITION_NAME).click();
  await expect(page.getByRole("button", { name: "Dashboard" })).toBeVisible({
    timeout: 10000,
  });
}

function getNameId(page: Page): string {
  const url = new URL(page.url());
  return url.pathname.split("/").filter(Boolean)[0] || "";
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
    data: { name, cardNo, classId, startTime },
  });
  const body = await resp.json();
  const id = body?.result?.data?.id ?? body?.result?.data?.json?.id;
  if (!id) throw new Error(`Failed to create runner: ${JSON.stringify(body).slice(0, 300)}`);
  return { id };
}

/** Look up a class ID by name via direct API call */
async function getClassId(
  request: import("@playwright/test").APIRequestContext,
  className: string,
): Promise<number> {
  const resp = await request.get(`${API_BASE}/trpc/class.list`);
  const body = await resp.json();
  const classes = (body?.result?.data ?? []) as Array<{ id: number; name: string }>;
  const cls = classes.find((c) => c.name === className);
  if (!cls) throw new Error(`Class "${className}" not found. Response: ${JSON.stringify(body).slice(0, 300)}`);
  return cls.id;
}

/** Set up admin page (with mock-webserial) and kiosk page in the same browser context */
async function setupAdminAndKiosk(context: BrowserContext) {
  const adminPage = await context.newPage();
  await adminPage.addInitScript(getMockWebSerialScript());

  // Select competition on admin page
  await selectCompetition(adminPage);
  const nameId = getNameId(adminPage);

  // Open kiosk page in same context (shares BroadcastChannel)
  const kioskPage = await context.newPage();
  await kioskPage.goto(`/${nameId}/kiosk`);
  await expect(kioskPage.getByText("Insert your SI card")).toBeVisible({
    timeout: 10000,
  });

  // Connect the mock SI reader on admin page
  await adminPage.getByTestId("connect-reader").click();
  await expect(adminPage.getByTestId("reader-status")).toBeVisible({
    timeout: 5000,
  });

  return { adminPage, kioskPage, nameId };
}

// ─── Tests ─────────────────────────────────────────────────

test.describe("Kiosk Readout Station Flow", () => {
  // Track created runner IDs for cleanup
  const createdRunnerIds: number[] = [];

  test.afterAll(async ({ request }) => {
    // Clean up created runners so other test files aren't affected
    for (const id of createdRunnerIds) {
      try {
        await request.post(`${API_BASE}/trpc/runner.delete`, {
          data: { id },
        });
      } catch {
        // Best-effort cleanup
      }
    }
  });

  test("OK readout updates runner status and shows readout on kiosk", async ({ context, request }) => {
    const { adminPage, kioskPage } = await setupAdminAndKiosk(context);

    // Look up Öppen 2 class and create a fresh runner with SI8 card
    const classId = await getClassId(request, "Öppen 2");
    const cardNo = 2800001;
    const startTimeDs = 363000; // 10:05:00 in deciseconds
    const runner = await createRunner(request, "Test OkRunner", cardNo, classId, startTimeDs);
    createdRunnerIds.push(runner.id);
    expect(runner.id).toBeGreaterThan(0);

    // Wait for the full DeviceManager pipeline to complete
    const readoutPromise = adminPage.waitForResponse(
      (resp) => resp.url().includes("/trpc/cardReadout.readout") && resp.status() === 200,
    );
    const applyPromise = adminPage.waitForResponse(
      (resp) => resp.url().includes("/trpc/cardReadout.applyResult") && resp.status() === 200,
    );

    // Insert SI8 card with all 5 course controls → computed status = OK
    await adminPage.evaluate(
      ({ cardNo, controls }) => {
        const punches = controls.map((code: number, i: number) => ({
          controlCode: code,
          time: 36600 + i * 120, // 10:10:00, +2min intervals (seconds)
        }));
        window.__siMock.insertCard(cardNo, punches);
      },
      { cardNo, controls: COURSE_2_CONTROLS },
    );

    await readoutPromise;

    // Kiosk should show readout screen with runner info
    await expect(kioskPage.getByText("Test OkRunner")).toBeVisible({ timeout: 10000 });
    await expect(kioskPage.getByText("Completed")).toBeVisible();
    await expect(kioskPage.getByText("Öppen 2")).toBeVisible();

    // Verify applyResult was called and succeeded (runner status persisted in DB)
    const applyResponse = await applyPromise;
    expect(applyResponse.status()).toBe(200);
  });

  test("MP readout shows missing punch on kiosk", async ({ context, request }) => {
    const { adminPage, kioskPage } = await setupAdminAndKiosk(context);

    const classId = await getClassId(request, "Öppen 2");
    const cardNo = 2800002;
    const startTimeDs = 363000;
    const runner = await createRunner(request, "Test MpRunner", cardNo, classId, startTimeDs);
    createdRunnerIds.push(runner.id);

    const readoutPromise = adminPage.waitForResponse(
      (resp) => resp.url().includes("/trpc/cardReadout.readout") && resp.status() === 200,
    );
    const applyPromise = adminPage.waitForResponse(
      (resp) => resp.url().includes("/trpc/cardReadout.applyResult") && resp.status() === 200,
    );

    // Insert card with only first 2 of 5 course controls → MP
    await adminPage.evaluate(
      ({ cardNo, controls }) => {
        const partial = controls.slice(0, 2);
        const punches = partial.map((code: number, i: number) => ({
          controlCode: code,
          time: 36600 + i * 120,
        }));
        window.__siMock.insertCard(cardNo, punches);
      },
      { cardNo, controls: COURSE_2_CONTROLS },
    );

    await readoutPromise;

    // Kiosk should show MP status
    await expect(kioskPage.getByText("Test MpRunner")).toBeVisible({ timeout: 10000 });
    await expect(kioskPage.getByText("Missing Punch")).toBeVisible();

    // Verify applyResult was called
    const applyResponse = await applyPromise;
    expect(applyResponse.status()).toBe(200);
  });

  test("applyResult persists runner status to DB for subsequent scans", async ({ context, request }) => {
    const { adminPage, kioskPage } = await setupAdminAndKiosk(context);

    const classId = await getClassId(request, "Öppen 2");
    const cardNo = 2800003;
    const startTimeDs = 363000;
    const runner = await createRunner(request, "Test PersistRunner", cardNo, classId, startTimeDs);
    createdRunnerIds.push(runner.id);

    // Verify runner starts with Status=0 (unknown)
    const beforeResp = await request.get(`${API_BASE}/trpc/runner.getById?input=${encodeURIComponent(JSON.stringify({ id: runner.id }))}`);
    const beforeBody = await beforeResp.json();
    const beforeStatus = beforeBody?.result?.data?.status ?? beforeBody?.result?.data?.json?.status;
    expect(beforeStatus).toBe(0);

    // Scan card with all controls → OK
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
    await applyPromise;

    // Verify kiosk shows readout
    await expect(kioskPage.getByText("Test PersistRunner")).toBeVisible({ timeout: 10000 });
    await expect(kioskPage.getByText("Completed")).toBeVisible();

    // Verify runner status was persisted to DB (Status=1 = OK)
    // This ensures subsequent scans will have hasDbResult=true → action="readout" (not "pre-start")
    const afterResp = await request.get(`${API_BASE}/trpc/runner.getById?input=${encodeURIComponent(JSON.stringify({ id: runner.id }))}`);
    const afterBody = await afterResp.json();
    const afterStatus = afterBody?.result?.data?.status ?? afterBody?.result?.data?.json?.status;
    expect(afterStatus).toBe(1); // RunnerStatus.OK = 1
  });

  test("re-reading same card after registration shows pre-start (not register)", async ({ context, request }) => {
    const { adminPage, kioskPage } = await setupAdminAndKiosk(context);

    const cardNo = 2800004;

    // First read — card is unregistered, no punches (clean card)
    const firstReadoutPromise = adminPage.waitForResponse(
      (resp) => resp.url().includes("/trpc/cardReadout.readout") && resp.status() === 200,
    );
    await adminPage.evaluate(
      ({ cardNo }) => { window.__siMock.insertCard(cardNo, []); },
      { cardNo },
    );
    await firstReadoutPromise;

    // Kiosk should show registration-waiting (card not registered)
    await expect(kioskPage.getByText("Registration in progress")).toBeVisible({ timeout: 10000 });

    // Remove card
    await adminPage.evaluate(() => { window.__siMock.removeCard(); });
    await adminPage.waitForTimeout(500);

    // Register the runner via API
    const classId = await getClassId(request, "Öppen 2");
    const runner = await createRunner(request, "Test RereadRunner", cardNo, classId, 363000);
    createdRunnerIds.push(runner.id);

    // Re-read the SAME card — should now resolve as pre-start
    const secondReadoutPromise = adminPage.waitForResponse(
      (resp) => resp.url().includes("/trpc/cardReadout.readout") && resp.status() === 200,
    );
    await adminPage.evaluate(
      ({ cardNo }) => { window.__siMock.insertCard(cardNo, []); },
      { cardNo },
    );
    await secondReadoutPromise;

    // Kiosk should show pre-start screen (runner is now registered)
    await expect(kioskPage.getByText("Ready to Start")).toBeVisible({ timeout: 10000 });
    await expect(kioskPage.getByText("Test RereadRunner")).toBeVisible();
  });

  test("re-reading card with punches after registration shows readout", async ({ context, request }) => {
    const { adminPage, kioskPage } = await setupAdminAndKiosk(context);

    const cardNo = 2800005;

    // First read — card has punches but runner not registered
    const firstReadoutPromise = adminPage.waitForResponse(
      (resp) => resp.url().includes("/trpc/cardReadout.readout") && resp.status() === 200,
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
    await firstReadoutPromise;

    // Remove card
    await adminPage.evaluate(() => { window.__siMock.removeCard(); });
    await adminPage.waitForTimeout(500);

    // Register runner and assign start time
    const classId = await getClassId(request, "Öppen 2");
    const runner = await createRunner(request, "Test RereadPunchRunner", cardNo, classId, 363000);
    createdRunnerIds.push(runner.id);

    // Re-read same card with same punches — should now be readout (not register)
    const secondReadoutPromise = adminPage.waitForResponse(
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
    await secondReadoutPromise;

    // Kiosk should show readout with completed status
    await expect(kioskPage.getByText("Test RereadPunchRunner")).toBeVisible({ timeout: 10000 });
    await expect(kioskPage.getByText("Completed")).toBeVisible();

    // applyResult should have been called
    const applyResponse = await applyPromise;
    expect(applyResponse.status()).toBe(200);
  });
});
