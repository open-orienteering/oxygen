import { test, expect } from "@playwright/test";
import { getMockWebSerialScript } from "./helpers/mock-webserial";

// Declare the global mock interface for TypeScript
declare global {
  interface Window {
    __siMock: {
      insertCard(
        cardNumber: number,
        punches?: Array<{ controlCode: number; time: number }>,
        options?: {
          hasFinish?: boolean;
          ownerData?: {
            firstName?: string;
            lastName?: string;
            club?: string;
            sex?: string;
            dateOfBirth?: string;
            phone?: string;
          };
        },
      ): boolean;
      removeCard(): boolean;
      isConnected(): boolean;
      getWrittenData(): Uint8Array[];
      reset(): void;
    };
  }
}

// ─── Helpers ───────────────────────────────────────────────

async function selectCompetition(page: import("@playwright/test").Page) {
  await page.goto("/");
  await page.getByText("My example tävling").click();
  await expect(page.getByRole("button", { name: "Dashboard" })).toBeVisible({
    timeout: 10000,
  });
}

async function goToTab(page: import("@playwright/test").Page, tab: string) {
  await selectCompetition(page);
  await page.getByRole("button", { name: tab, exact: true }).click();
}

// Inject mock WebSerial before each test
test.beforeEach(async ({ page }) => {
  await page.addInitScript(getMockWebSerialScript());
});

// ─── Tests ─────────────────────────────────────────────────

test.describe("WebSerial SI Reader", () => {
  test("should show Connect Reader button when WebSerial is available", async ({
    page,
  }) => {
    await selectCompetition(page);
    await expect(page.getByTestId("connect-reader")).toBeVisible();
    await expect(page.getByTestId("connect-reader")).toHaveText(
      /Connect Reader/,
    );
  });

  test("should connect reader and show status indicator", async ({ page }) => {
    await selectCompetition(page);

    // Click connect
    await page.getByTestId("connect-reader").click();

    // Should now show "SI Reader" status instead of "Connect Reader"
    await expect(page.getByTestId("reader-status")).toBeVisible({
      timeout: 5000,
    });
    await expect(page.getByTestId("reader-status")).toHaveText(/SI Reader/);

    // Verify the mock reports connected
    const isConnected = await page.evaluate(() =>
      window.__siMock.isConnected(),
    );
    expect(isConnected).toBe(true);
  });

  test("should disconnect reader via status menu", async ({ page }) => {
    await selectCompetition(page);

    // Connect
    await page.getByTestId("connect-reader").click();
    await expect(page.getByTestId("reader-status")).toBeVisible({
      timeout: 5000,
    });

    // Click the status to open menu
    await page.getByTestId("reader-status").click();

    // Click disconnect
    await page.getByTestId("disconnect-reader").click();

    // Should go back to "Connect Reader" button
    await expect(page.getByTestId("connect-reader")).toBeVisible({
      timeout: 5000,
    });
  });

  test("should show readout notification for known runner with race data", async ({
    page,
  }) => {
    await selectCompetition(page);

    // Connect reader
    await page.getByTestId("connect-reader").click();
    await expect(page.getByTestId("reader-status")).toBeVisible({
      timeout: 5000,
    });

    // Wait for the runner resolution API call to complete after inserting the card
    const resolutionPromise = page.waitForResponse(
      (resp) => resp.url().includes("/trpc/cardReadout.readout") && resp.status() === 200,
    );

    // Insert card 501438 (Malin Johannesson, exists in test DB)
    await page.evaluate(() =>
      window.__siMock.insertCard(501438, [
        { controlCode: 31, time: 36360 },
        { controlCode: 32, time: 36420 },
        { controlCode: 33, time: 36480 },
      ]),
    );

    await resolutionPromise;

    // Notification banner should appear
    await expect(page.getByTestId("card-notification")).toBeVisible({
      timeout: 5000,
    });
    await expect(page.getByTestId("card-notification")).toContainText("501438");

    // Known runner with race data → "View Readout" action
    await expect(page.getByTestId("card-notification-view")).toContainText(
      "View Readout",
    );
  });

  test("should navigate to card readout from readout notification", async ({
    page,
  }) => {
    await selectCompetition(page);

    // Connect reader
    await page.getByTestId("connect-reader").click();
    await expect(page.getByTestId("reader-status")).toBeVisible({
      timeout: 5000,
    });

    // Wait for the runner resolution API call to complete after inserting the card
    const resolutionPromise = page.waitForResponse(
      (resp) => resp.url().includes("/trpc/cardReadout.readout") && resp.status() === 200,
    );

    // Insert card 501438 (known runner with race data)
    await page.evaluate(() =>
      window.__siMock.insertCard(501438, [
        { controlCode: 31, time: 36360 },
      ]),
    );

    await resolutionPromise;

    // Wait for notification
    await expect(page.getByTestId("card-notification")).toBeVisible({
      timeout: 5000,
    });

    // Click "View Readout"
    await page.getByTestId("card-notification-view").click();

    // Should navigate to card readout page
    await expect(page).toHaveURL(/card-readout.*card=501438/);
    await expect(
      page.getByPlaceholder("Enter SI card number..."),
    ).toHaveValue("501438");
  });

  test("should auto-populate card readout page on card read", async ({
    page,
  }) => {
    // Go directly to card-readout page
    await selectCompetition(page);
    await page.getByTestId("more-menu-button").click();
    await page.getByTestId("more-menu-content").getByRole("button", { name: "Card Readout", exact: true }).click();

    await expect(
      page.getByPlaceholder("Enter SI card number..."),
    ).toBeVisible({ timeout: 5000 });

    // Connect reader
    await page.getByTestId("connect-reader").click();
    await expect(page.getByTestId("reader-status")).toBeVisible({
      timeout: 5000,
    });

    // Verify the "SI Reader connected" hint is shown
    await expect(page.getByText("SI Reader connected")).toBeVisible();

    // Insert a card
    await page.evaluate(() =>
      window.__siMock.insertCard(2501438, [
        { controlCode: 31, time: 36360 },
        { controlCode: 32, time: 36420 },
      ]),
    );

    // Card number should auto-populate
    await expect(
      page.getByPlaceholder("Enter SI card number..."),
    ).toHaveValue("2501438", { timeout: 5000 });

    // "Card read from SI reader" banner should appear
    await expect(page.getByTestId("from-reader-banner")).toBeVisible({
      timeout: 5000,
    });

    // The notification banner should NOT appear (we're on card-readout page)
    await expect(page.getByTestId("card-notification")).not.toBeVisible();
  });

  test("should show pre-start notification for known runner with clean card", async ({
    page,
  }) => {
    await selectCompetition(page);

    // Connect reader
    await page.getByTestId("connect-reader").click();
    await expect(page.getByTestId("reader-status")).toBeVisible({
      timeout: 5000,
    });

    // Wait for the runner resolution API call to complete after inserting the card
    const resolutionPromise = page.waitForResponse(
      (resp) => resp.url().includes("/trpc/cardReadout.readout") && resp.status() === 200,
    );

    // Insert card 500671 (Eva Rådberg — Status=0, no FinishTime, truly pre-start)
    // with NO punches and NO finish
    await page.evaluate(() =>
      window.__siMock.insertCard(500671, [], { hasFinish: false }),
    );

    await resolutionPromise;

    // Notification should show "View Start" action
    await expect(page.getByTestId("card-notification")).toBeVisible({
      timeout: 5000,
    });
    await expect(page.getByTestId("card-notification")).toContainText("500671");
    await expect(page.getByTestId("card-notification-view")).toContainText(
      "View Start",
    );

    // Click → should navigate to start station
    await page.getByTestId("card-notification-view").click();
    await expect(page).toHaveURL(/start-station.*card=500671/);
  });

  test("should show owner data from SIAC card in register notification", async ({
    page,
  }) => {
    await selectCompetition(page);

    // Connect reader
    await page.getByTestId("connect-reader").click();
    await expect(page.getByTestId("reader-status")).toBeVisible({
      timeout: 5000,
    });

    // Wait for the runner resolution API call to complete after inserting the card.
    // The DeviceManager first stores the readout, then calls cardReadout.readout
    // to determine the action (register/readout/pre-start). Without waiting, the
    // notification may still show the default action.
    const resolutionPromise = page.waitForResponse(
      (resp) => resp.url().includes("/trpc/cardReadout.readout") && resp.status() === 200,
    );

    // Insert a SIAC card (8xxx range = SI10 layout) with owner data
    await page.evaluate(() =>
      window.__siMock.insertCard(
        8007045,
        [{ controlCode: 31, time: 36360 }],
        {
          ownerData: {
            firstName: "Marcus",
            lastName: "Andersson",
            club: "Skogslansen",
            sex: "M",
          },
        },
      ),
    );

    await resolutionPromise;

    // Notification should show owner name and club
    const notif = page.getByTestId("card-notification");
    await expect(notif).toBeVisible({ timeout: 5000 });
    await expect(notif).toContainText("8007045");
    await expect(notif).toContainText("Marcus Andersson", { timeout: 5000 });
    await expect(notif).toContainText("Skogslansen");

    // Click Register — RegistrationDialog should open with data pre-filled
    await page.getByTestId("card-notification-view").click();
    await expect(page.getByTestId("registration-dialog")).toBeVisible({ timeout: 5000 });

    const dialog = page.getByTestId("registration-dialog");

    // Card number should be pre-filled
    await expect(dialog.locator("input[placeholder='e.g. 500123']")).toHaveValue(
      "8007045",
    );
    // Name should be pre-filled
    await expect(
      dialog.locator("input[placeholder='First Last']"),
    ).toHaveValue("Marcus Andersson");
  });

  test("should show register notification for unknown card", async ({
    page,
  }) => {
    await selectCompetition(page);

    // Connect reader
    await page.getByTestId("connect-reader").click();
    await expect(page.getByTestId("reader-status")).toBeVisible({
      timeout: 5000,
    });

    // Wait for the runner resolution API call to complete after inserting the card
    const resolutionPromise = page.waitForResponse(
      (resp) => resp.url().includes("/trpc/cardReadout.readout") && resp.status() === 200,
    );

    // Insert a card that doesn't exist in the DB
    await page.evaluate(() =>
      window.__siMock.insertCard(2999999, [
        { controlCode: 31, time: 36360 },
      ]),
    );

    await resolutionPromise;

    // Notification should show with card number and "Register" action
    await expect(page.getByTestId("card-notification")).toBeVisible({
      timeout: 5000,
    });
    await expect(page.getByTestId("card-notification")).toContainText(
      "2999999",
    );
    // The action button should say "Register"
    await expect(page.getByTestId("card-notification-view")).toContainText(
      "Register",
    );

    // Click "Register" — RegistrationDialog should open (no navigation)
    await page.getByTestId("card-notification-view").click();
    await expect(page.getByTestId("registration-dialog")).toBeVisible({ timeout: 5000 });

    const dialog = page.getByTestId("registration-dialog");
    // Card number should be pre-filled
    await expect(dialog.locator("input[placeholder='e.g. 500123']")).toHaveValue(
      "2999999",
    );
  });

  test("should track recent cards in floating panel", async ({ page }) => {
    await selectCompetition(page);

    // Connect reader
    await page.getByTestId("connect-reader").click();
    await expect(page.getByTestId("reader-status")).toBeVisible({
      timeout: 5000,
    });

    // Read two cards
    await page.evaluate(() =>
      window.__siMock.insertCard(2501001, [
        { controlCode: 31, time: 36360 },
      ]),
    );
    // Wait for first card to be processed
    await expect(page.getByTestId("card-notification")).toBeVisible({ timeout: 5000 });
    await page.evaluate(() => window.__siMock.removeCard());
    await page.evaluate(() =>
      window.__siMock.insertCard(2501002, [
        { controlCode: 32, time: 36420 },
      ]),
    );

    // Wait for the recent cards button to appear with badge
    await expect(page.getByTestId("recent-cards-button")).toBeVisible({
      timeout: 5000,
    });

    // Open the recent cards panel
    await page.getByTestId("recent-cards-button").click();
    await expect(page.getByTestId("recent-cards-panel")).toBeVisible();

    // Should contain both card numbers
    const panel = page.getByTestId("recent-cards-panel");
    await expect(panel).toContainText("2501002");
    await expect(panel).toContainText("2501001");
  });
});
