/**
 * E2E tests for rental card (hyrbricka) management.
 *
 * Tests cover:
 * - Setting rental card fee in competition settings (EventPage)
 * - Registering a runner with rental card checkbox
 * - Rental card badge appearing in admin runner list
 * - Mark-as-returned / undo toggle in runner detail
 * - Kiosk readout banner for rental cards
 */

import { test, expect, type Page } from "@playwright/test";
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

// ─── Helpers ───────────────────────────────────────────────

async function selectCompetition(page: Page) {
  await page.goto("/");
  await page.getByText(COMPETITION_NAME).click();
  await expect(page.getByRole("link", { name: "Dashboard" })).toBeVisible({
    timeout: 10000,
  });
}

async function clickTab(page: Page, name: string) {
  const mainTab = page.locator("nav[aria-label='Tabs']").getByRole("link", { name, exact: true });
  if (await mainTab.isVisible()) {
    await mainTab.click();
  } else {
    await page.getByTestId("more-menu-button").click();
    await page.getByTestId("more-menu-content").getByRole("link", { name, exact: true }).click();
  }
}

function getNameId(page: Page): string {
  const url = new URL(page.url());
  return url.pathname.split("/").filter(Boolean)[0] || "";
}

async function getClassId(
  request: import("@playwright/test").APIRequestContext,
  className: string,
): Promise<number> {
  const resp = await request.get(`${API_BASE}/trpc/class.list`);
  const body = await resp.json();
  const classes = (body?.result?.data ?? []) as Array<{ id: number; name: string }>;
  const cls = classes.find((c) => c.name === className);
  if (!cls) throw new Error(`Class "${className}" not found`);
  return cls.id;
}

async function createRunner(
  request: import("@playwright/test").APIRequestContext,
  name: string,
  cardNo: number,
  classId: number,
  cardFee = 0,
): Promise<{ id: number }> {
  const resp = await request.post(`${API_BASE}/trpc/runner.create`, {
    data: { name, cardNo, classId, startTime: 0, cardFee },
  });
  const body = await resp.json();
  const id = body?.result?.data?.id ?? body?.result?.data?.json?.id;
  if (!id) throw new Error(`Failed to create runner: ${JSON.stringify(body).slice(0, 300)}`);
  return { id };
}

async function deleteRunner(request: import("@playwright/test").APIRequestContext, id: number) {
  try {
    await request.post(`${API_BASE}/trpc/runner.delete`, { data: { id } });
  } catch { /* best effort */ }
}

async function setCardFee(
  request: import("@playwright/test").APIRequestContext,
  cardFee: number,
) {
  await request.post(`${API_BASE}/trpc/competition.setCardFee`, {
    data: { cardFee },
  });
}

// ─── Tests ─────────────────────────────────────────────────

test.describe("Rental Cards — Competition Settings", () => {
  test.afterEach(async ({ request }) => {
    await setCardFee(request, 0);
  });

  test("should display rental card fee input in Registration Settings", async ({ page }) => {
    await selectCompetition(page);
    await clickTab(page, "Event");

    await expect(page.getByText("Registration Settings")).toBeVisible({ timeout: 10000 });
    await expect(page.getByTestId("rental-card-fee-input")).toBeVisible();
  });

  test("should persist rental card fee when saved", async ({ page, request }) => {
    await selectCompetition(page);
    await clickTab(page, "Event");

    await expect(page.getByTestId("rental-card-fee-input")).toBeVisible({ timeout: 10000 });

    await page.getByTestId("rental-card-fee-input").fill("50");
    await page.getByTestId("rental-card-fee-input").blur();

    // Wait for the save API call to complete after blur
    await page.waitForResponse(
      (resp) => resp.url().includes("/trpc/competition.setCardFee") && resp.status() === 200,
    );
    const resp = await request.get(`${API_BASE}/trpc/competition.getCardFee`);
    const body = await resp.json();
    const fee = body?.result?.data?.cardFee ?? body?.result?.data?.json?.cardFee;
    expect(fee).toBe(50);
  });
});

test.describe("Rental Cards — Registration Dialog", () => {
  const createdRunnerIds: number[] = [];

  test.afterAll(async ({ request }) => {
    for (const id of createdRunnerIds) {
      await deleteRunner(request, id);
    }
    await setCardFee(request, 0);
  });

  test("should show rental card checkbox in registration dialog", async ({ page }) => {
    await page.addInitScript(getMockWebSerialScript());
    await selectCompetition(page);
    const nameId = getNameId(page);
    await page.goto(`/${nameId}/runners`);

    await page.getByRole("button", { name: "Add Runner" }).click();
    await expect(page.getByTestId("registration-dialog")).toBeVisible({ timeout: 5000 });

    await expect(page.getByTestId("rental-card-checkbox")).toBeVisible();
  });

  test("should store CardFee on runner when rental card is checked", async ({ page, request }) => {
    await setCardFee(request, 50);

    await page.addInitScript(getMockWebSerialScript());
    await selectCompetition(page);
    const nameId = getNameId(page);
    await page.goto(`/${nameId}/runners`);

    await page.getByRole("button", { name: "Add Runner" }).click();
    const dialog = page.getByTestId("registration-dialog");
    await expect(dialog).toBeVisible({ timeout: 5000 });

    // Fill name
    await dialog.locator("input[placeholder='First Last']").fill("E2E_Rental Register Test");

    // Select class
    await dialog.getByTestId("reg-class").click();
    await expect(dialog.getByText("Öppen 2", { exact: true })).toBeVisible({ timeout: 3000 });
    await dialog.getByText("Öppen 2", { exact: true }).click();

    // Fill card number
    await dialog.locator("input[placeholder='e.g. 500123']").fill("2988801");

    // Check rental card
    await page.getByTestId("rental-card-checkbox").check();
    await expect(page.getByTestId("rental-card-checkbox")).toBeChecked();

    // Submit
    await dialog.getByTestId("reg-submit").click();
    await expect(dialog).not.toBeVisible({ timeout: 5000 });

    // Verify CardFee stored
    const listResp = await request.get(`${API_BASE}/trpc/runner.list`);
    const listBody = await listResp.json();
    const runners = (listBody?.result?.data ?? []) as Array<{ id: number; name: string; cardFee?: number }>;
    const created = runners.find((r) => r.name === "E2E_Rental Register Test");
    expect(created).toBeTruthy();
    expect(created!.cardFee).toBe(50);

    createdRunnerIds.push(created!.id);
  });
});

test.describe("Rental Cards — Admin Runner List", () => {
  let runnerId = 0;
  const CARD_NO = 2988802;

  test.beforeAll(async ({ request }) => {
    const classId = await getClassId(request, "Öppen 2");
    const { id } = await createRunner(request, "E2E_Rental Badge Test", CARD_NO, classId, 30);
    runnerId = id;
  });

  test.afterAll(async ({ request }) => {
    if (runnerId) await deleteRunner(request, runnerId);
  });

  test("should show rental card badge for runner with CardFee > 0", async ({ page }) => {
    await selectCompetition(page);
    await clickTab(page, "Runners");

    await expect(page.getByText("E2E_Rental Badge Test")).toBeVisible({ timeout: 10000 });

    const row = page.locator("tr").filter({ hasText: "E2E_Rental Badge Test" });
    await expect(row.getByTestId("rental-card-badge")).toBeVisible();
  });

  test("should show mark-returned button in expanded runner detail", async ({ page }) => {
    await selectCompetition(page);
    await clickTab(page, "Runners");

    await expect(page.getByText("E2E_Rental Badge Test")).toBeVisible({ timeout: 10000 });
    await page.locator("tr").filter({ hasText: "E2E_Rental Badge Test" }).first().click();

    await expect(page.getByTestId("mark-card-returned")).toBeVisible({ timeout: 5000 });
  });

  test("should mark card as returned and show returned state", async ({ page }) => {
    await selectCompetition(page);
    await clickTab(page, "Runners");

    await expect(page.getByText("E2E_Rental Badge Test")).toBeVisible({ timeout: 10000 });
    await page.locator("tr").filter({ hasText: "E2E_Rental Badge Test" }).first().click();

    await page.getByTestId("mark-card-returned").click();

    // Undo button should now appear
    await expect(page.getByTestId("undo-card-returned")).toBeVisible({ timeout: 5000 });

    // Badge should turn green (emerald) when returned
    const row = page.locator("tr").filter({ hasText: "E2E_Rental Badge Test" });
    const badge = row.getByTestId("rental-card-badge");
    await expect(badge).toBeVisible();
    await expect(badge).toHaveClass(/emerald/);
  });

  test("should undo card returned", async ({ page, request }) => {
    await request.post(`${API_BASE}/trpc/runner.setCardReturned`, {
      data: { runnerId, returned: true },
    });

    await selectCompetition(page);
    await clickTab(page, "Runners");

    await expect(page.getByText("E2E_Rental Badge Test")).toBeVisible({ timeout: 10000 });
    await page.locator("tr").filter({ hasText: "E2E_Rental Badge Test" }).first().click();

    await expect(page.getByTestId("undo-card-returned")).toBeVisible({ timeout: 5000 });
    await page.getByTestId("undo-card-returned").click();

    await expect(page.getByTestId("mark-card-returned")).toBeVisible({ timeout: 5000 });
  });
});

// Course 2 "Bana 2" controls (Öppen 2 class) — must match the test competition
const COURSE_2_CONTROLS = [81, 50, 40, 150, 100];

test.describe("Rental Cards — Kiosk Readout Banner", () => {
  let runnerId = 0;
  const CARD_NO = 2988803;

  test.beforeAll(async ({ request }) => {
    const classId = await getClassId(request, "Öppen 2");
    const { id } = await createRunner(request, "E2E_Rental Kiosk Test", CARD_NO, classId, 50);
    runnerId = id;
  });

  test.afterAll(async ({ request }) => {
    if (runnerId) await deleteRunner(request, runnerId);
  });

  test("should show rental card banner on kiosk readout", async ({ page, context }) => {
    await page.addInitScript(getMockWebSerialScript());
    await selectCompetition(page);
    const nameId = getNameId(page);

    // Open kiosk in a second tab
    const kioskPage = await context.newPage();
    await kioskPage.goto(`/${nameId}/kiosk`);
    await expect(kioskPage.getByText("Insert your SI card")).toBeVisible({ timeout: 10000 });

    // Connect SI reader in admin
    await page.getByTestId("connect-reader").click();
    await expect(page.getByTestId("reader-status")).toBeVisible({ timeout: 5000 });

    // Insert the rental card with course controls so it resolves as a readout (not pre-start)
    const readoutPromise = page.waitForResponse(
      (resp) => resp.url().includes("/trpc/cardReadout.readout") && resp.status() === 200,
    );
    await page.evaluate(
      ({ cardNo, controls }) => {
        const punches = controls.map((code: number, i: number) => ({
          controlCode: code,
          time: 36600 + i * 120,
        }));
        window.__siMock.insertCard(cardNo, punches);
      },
      { cardNo: CARD_NO, controls: COURSE_2_CONTROLS },
    );
    await readoutPromise;

    // Kiosk should show the rental card banner
    await expect(kioskPage.getByTestId("rental-card-banner")).toBeVisible({ timeout: 15000 });
    await expect(kioskPage.getByText("Return your SI card")).toBeVisible();

    await kioskPage.close();
  });
});
