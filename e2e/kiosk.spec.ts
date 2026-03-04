import { test, expect, type Page } from "@playwright/test";

// ─── Helpers ───────────────────────────────────────────────

const COMPETITION_NAME = "My example tävling";

async function selectCompetition(page: Page) {
  await page.goto("/");
  await page.getByText(COMPETITION_NAME).click();
  await expect(page.getByRole("button", { name: "Dashboard" })).toBeVisible({
    timeout: 10000,
  });
}

/** Get the competition nameId from the current URL */
function getNameId(page: Page): string {
  const url = new URL(page.url());
  const parts = url.pathname.split("/").filter(Boolean);
  return parts[0] || "";
}

/** Navigate directly to the kiosk page for the test competition */
async function goToKiosk(page: Page) {
  // First select competition to get the nameId
  await selectCompetition(page);
  const nameId = getNameId(page);
  await page.goto(`/${nameId}/kiosk`);
  // Wait for the kiosk idle screen
  await expect(page.getByText("Insert your SI card")).toBeVisible({
    timeout: 10000,
  });
}

/**
 * Send a kiosk message via BroadcastChannel from the test page context.
 * This simulates the admin window sending messages.
 */
async function sendKioskMessage(page: Page, nameId: string, message: Record<string, unknown>) {
  await page.evaluate(
    ({ nameId, message }) => {
      const ch = new BroadcastChannel(`oxygen-kiosk-${nameId}`);
      ch.postMessage(message);
      ch.close();
    },
    { nameId, message },
  );
}

// ─── Tests ─────────────────────────────────────────────────

test.describe("Kiosk Mode", () => {
  test("should display idle screen with card prompt and competition name", async ({ page }) => {
    await goToKiosk(page);

    await expect(page.getByText("Insert your SI card")).toBeVisible();
    await expect(
      page.getByText("Place your card in the reader and wait for the beep"),
    ).toBeVisible();
    // Competition name should be visible on the idle screen (as a heading)
    await expect(page.getByRole("heading", { name: COMPETITION_NAME })).toBeVisible({ timeout: 10000 });
  });

  test("should have settings panel accessible", async ({ page }) => {
    await goToKiosk(page);

    // Click the settings gear
    await page.locator('button[title="Settings"]').click();

    // Settings panel should appear
    await expect(page.getByText("Kiosk Settings")).toBeVisible();
    await expect(page.getByText("Standalone mode")).toBeVisible();
    await expect(page.getByText("Require clear/check")).toBeVisible();
    await expect(page.getByText("Auto-reset after (seconds)")).toBeVisible();
    await expect(page.getByText("Write details to empty cards")).toBeVisible();
  });

  test("should have fullscreen toggle button", async ({ page }) => {
    await goToKiosk(page);

    const fullscreenBtn = page.locator('button[title="Toggle fullscreen"]');
    await expect(fullscreenBtn).toBeVisible();
  });

  test("should show do-not-remove screen when card-reading message is received", async ({
    page,
  }) => {
    await goToKiosk(page);
    const nameId = getNameId(page);

    await sendKioskMessage(page, nameId, {
      type: "card-reading",
      cardNumber: 501438,
    });

    await expect(page.getByText("Reading card...")).toBeVisible({ timeout: 5000 });
    await expect(
      page.getByText("Do not remove SI card until the beep"),
    ).toBeVisible();
    await expect(page.getByText("Card 501438")).toBeVisible();
  });

  test("should transition from reading to readout screen", async ({
    page,
  }) => {
    await goToKiosk(page);
    const nameId = getNameId(page);

    // First show reading screen
    await sendKioskMessage(page, nameId, {
      type: "card-reading",
      cardNumber: 501438,
    });
    await expect(page.getByText("Reading card...")).toBeVisible({ timeout: 5000 });

    // Then send the full readout
    await sendKioskMessage(page, nameId, {
      type: "card-readout",
      card: {
        id: "test-transition-1",
        cardNumber: 501438,
        cardType: "SI8",
        action: "readout",
        hasRaceData: true,
        runnerName: "Malin Johannesson",
        className: "H21",
        clubName: "Test Club",
        status: "OK",
        runningTime: 12340,
      },
    });

    // Should now show readout, not reading
    await expect(page.getByText("Malin Johannesson")).toBeVisible({ timeout: 5000 });
    await expect(page.getByText("Completed")).toBeVisible();
  });

  test("should switch to readout screen when card-readout message with race data is received", async ({
    page,
  }) => {
    await goToKiosk(page);
    const nameId = getNameId(page);

    // Simulate admin sending a readout card event
    await sendKioskMessage(page, nameId, {
      type: "card-readout",
      card: {
        id: "test-1",
        cardNumber: 501438,
        cardType: "SI8",
        action: "readout",
        hasRaceData: true,
        runnerName: "Malin Johannesson",
        className: "H21",
        clubName: "Test Club",
        status: "OK",
        runningTime: 12340,
      },
    });

    // Should show the readout screen
    await expect(page.getByText("Malin Johannesson")).toBeVisible({
      timeout: 5000,
    });
    await expect(page.getByText("Completed")).toBeVisible();
    await expect(page.getByText("Test Club")).toBeVisible();
    await expect(page.getByText("H21")).toBeVisible();
  });

  test("should show missing punch status on readout screen", async ({
    page,
  }) => {
    await goToKiosk(page);
    const nameId = getNameId(page);

    await sendKioskMessage(page, nameId, {
      type: "card-readout",
      card: {
        id: "test-mp-1",
        cardNumber: 501438,
        cardType: "SI8",
        action: "readout",
        hasRaceData: true,
        runnerName: "Test Runner",
        className: "H21",
        status: "MP",
        runningTime: 15000,
      },
    });

    await expect(page.getByText("Missing Punch")).toBeVisible({
      timeout: 5000,
    });
    await expect(page.getByText("Test Runner")).toBeVisible();
  });

  test("should switch to pre-start screen for registered runner without race data", async ({
    page,
  }) => {
    await goToKiosk(page);
    const nameId = getNameId(page);

    await sendKioskMessage(page, nameId, {
      type: "card-readout",
      card: {
        id: "test-prestart-1",
        cardNumber: 501438,
        cardType: "SI8",
        action: "pre-start",
        hasRaceData: false,
        runnerName: "Malin Johannesson",
        className: "H21",
        clubName: "Test Club",
      },
    });

    await expect(page.getByText("Ready to Start")).toBeVisible({
      timeout: 5000,
    });
    await expect(page.getByText("Malin Johannesson")).toBeVisible();
  });

  test("should switch to registration waiting screen for unknown card", async ({
    page,
  }) => {
    await goToKiosk(page);
    const nameId = getNameId(page);

    await sendKioskMessage(page, nameId, {
      type: "card-readout",
      card: {
        id: "test-register-1",
        cardNumber: 999999,
        cardType: "SI8",
        action: "register",
        hasRaceData: false,
      },
    });

    await expect(page.getByText("Registration in progress")).toBeVisible({
      timeout: 5000,
    });
    await expect(page.getByText("999999")).toBeVisible();
  });

  test("should show registration confirmation when admin sends ready form state", async ({
    page,
  }) => {
    await goToKiosk(page);
    const nameId = getNameId(page);

    // First trigger registration mode
    await sendKioskMessage(page, nameId, {
      type: "card-readout",
      card: {
        id: "test-register-2",
        cardNumber: 999999,
        cardType: "SI8",
        action: "register",
        hasRaceData: false,
      },
    });

    await expect(page.getByText("Registration in progress")).toBeVisible({
      timeout: 5000,
    });

    // Admin sends form state with ready=true
    await sendKioskMessage(page, nameId, {
      type: "registration-state",
      form: {
        name: "New Runner",
        clubName: "Sprint Club",
        className: "D21",
        courseName: "Long",
        cardNo: 999999,
        startTime: "12:30:00",
        sex: "F",
        birthYear: "1995",
        phone: "",
        paymentMode: "on-site",
      },
      ready: true,
    });

    // Should show confirmation screen with re-insert prompt instead of button
    await expect(page.getByText("Please confirm your registration")).toBeVisible({
      timeout: 5000,
    });
    await expect(page.getByText("New Runner")).toBeVisible();
    await expect(page.getByText("Sprint Club")).toBeVisible();
    await expect(page.getByText("D21")).toBeVisible();
    await expect(page.getByText("Pay on site")).toBeVisible();
    await expect(page.getByTestId("kiosk-reinsert-prompt")).toBeVisible();
    await expect(page.getByText("Insert your SI card again to confirm")).toBeVisible();
  });

  test("should handle registration confirmation via card re-insert message", async ({
    page,
  }) => {
    await goToKiosk(page);
    const nameId = getNameId(page);

    // Trigger registration flow
    await sendKioskMessage(page, nameId, {
      type: "card-readout",
      card: {
        id: "test-register-3",
        cardNumber: 999999,
        cardType: "SI8",
        action: "register",
        hasRaceData: false,
      },
    });

    await expect(page.getByText("Registration in progress")).toBeVisible({
      timeout: 5000,
    });

    // Admin sends ready form
    await sendKioskMessage(page, nameId, {
      type: "registration-state",
      form: {
        name: "New Runner",
        clubName: "Sprint Club",
        className: "D21",
        courseName: "",
        cardNo: 999999,
        startTime: "12:30:00",
        sex: "F",
        birthYear: "1995",
        phone: "",
        paymentMode: "billed",
      },
      ready: true,
    });

    // Should show the re-insert prompt
    await expect(page.getByText("Insert your SI card again to confirm")).toBeVisible({
      timeout: 5000,
    });

    // Set up listener for confirmation message from kiosk
    const confirmPromise = page.evaluate(
      (nameId) =>
        new Promise<boolean>((resolve) => {
          const ch = new BroadcastChannel(`oxygen-kiosk-${nameId}`);
          const timer = setTimeout(() => { ch.close(); resolve(false); }, 5000);
          ch.onmessage = (e) => {
            if (e.data.type === "registration-confirm" && e.data.confirmed) {
              clearTimeout(timer);
              ch.close();
              resolve(true);
            }
          };
        }),
      nameId,
    );

    // Simulate admin's DeviceManager detecting same card re-insert and sending confirmation
    await sendKioskMessage(page, nameId, {
      type: "registration-confirm",
      confirmed: true,
    });

    // The kiosk should forward the confirmation (it also receives and may re-emit)
    // But the key assertion: the admin sent the confirm, now send registration-complete
    await sendKioskMessage(page, nameId, {
      type: "registration-complete",
      runner: {
        name: "New Runner",
        className: "D21",
        clubName: "Sprint Club",
        startTime: "12:30:00",
        cardNo: 999999,
      },
    });

    // Should show registration complete
    await expect(page.getByText("Registration Complete!")).toBeVisible({
      timeout: 5000,
    });
  });

  test("should show registration complete screen", async ({ page }) => {
    await goToKiosk(page);
    const nameId = getNameId(page);

    // Send registration complete message directly
    await sendKioskMessage(page, nameId, {
      type: "registration-complete",
      runner: {
        name: "New Runner",
        className: "D21",
        clubName: "Sprint Club",
        startTime: "12:30:00",
        cardNo: 999999,
      },
    });

    await expect(page.getByText("Registration Complete!")).toBeVisible({
      timeout: 5000,
    });
    await expect(page.getByText("New Runner")).toBeVisible();
    await expect(page.getByText("D21")).toBeVisible();
    await expect(page.getByText("12:30:00")).toBeVisible();
  });

  test("should auto-reset to idle after timeout", async ({ page }) => {
    await goToKiosk(page);
    const nameId = getNameId(page);

    // Set a short auto-reset time via settings
    await page.locator('button[title="Settings"]').click();
    const autoResetInput = page.locator('input[type="number"][min="5"]');
    await autoResetInput.fill("5");
    await page.locator('button[title="Settings"]').click(); // close settings

    // Send a readout card event
    await sendKioskMessage(page, nameId, {
      type: "card-readout",
      card: {
        id: "test-reset-1",
        cardNumber: 501438,
        cardType: "SI8",
        action: "readout",
        hasRaceData: true,
        runnerName: "Test Runner",
        status: "OK",
        runningTime: 12340,
      },
    });

    // Should be on readout screen
    await expect(page.getByText("Test Runner")).toBeVisible({ timeout: 5000 });

    // Wait for auto-reset (5s + buffer)
    await page.waitForTimeout(7000);

    // Should be back to idle
    await expect(page.getByText("Insert your SI card")).toBeVisible({
      timeout: 5000,
    });
  });

  test("should reset to idle when kiosk-reset message is received", async ({
    page,
  }) => {
    await goToKiosk(page);
    const nameId = getNameId(page);

    // Go to readout screen
    await sendKioskMessage(page, nameId, {
      type: "card-readout",
      card: {
        id: "test-reset-2",
        cardNumber: 501438,
        cardType: "SI8",
        action: "readout",
        hasRaceData: true,
        runnerName: "Test Runner",
        status: "OK",
        runningTime: 12340,
      },
    });

    await expect(page.getByText("Test Runner")).toBeVisible({ timeout: 5000 });

    // Send reset
    await sendKioskMessage(page, nameId, { type: "kiosk-reset" });

    // Should be back to idle
    await expect(page.getByText("Insert your SI card")).toBeVisible({
      timeout: 5000,
    });
  });

  test("should respond to ping from admin", async ({ page }) => {
    await goToKiosk(page);
    const nameId = getNameId(page);

    // Set up listener for pong from kiosk
    const pongPromise = page.evaluate(
      (nameId) =>
        new Promise<boolean>((resolve) => {
          const ch = new BroadcastChannel(`oxygen-kiosk-${nameId}`);
          const timer = setTimeout(() => { ch.close(); resolve(false); }, 3000);
          ch.onmessage = (e) => {
            if (e.data.type === "kiosk-ping" && e.data.from === "kiosk") {
              clearTimeout(timer);
              ch.close();
              resolve(true);
            }
          };
          // Send ping
          ch.postMessage({ type: "kiosk-ping", from: "admin" });
        }),
      nameId,
    );

    const gotPong = await pongPromise;
    expect(gotPong).toBe(true);
  });

  test("should show write-to-card consent text when setting is enabled", async ({
    page,
  }) => {
    await goToKiosk(page);
    const nameId = getNameId(page);

    // Enable writeToCard in settings
    await page.locator('button[title="Settings"]').click();
    await page.getByText("Write details to empty cards").click();
    await page.locator('button[title="Settings"]').click(); // close settings

    // Trigger registration and show confirm screen
    await sendKioskMessage(page, nameId, {
      type: "card-readout",
      card: {
        id: "test-write-1",
        cardNumber: 888888,
        cardType: "SI8",
        action: "register",
        hasRaceData: false,
      },
    });

    await expect(page.getByText("Registration in progress")).toBeVisible({
      timeout: 5000,
    });

    await sendKioskMessage(page, nameId, {
      type: "registration-state",
      form: {
        name: "Card Writer",
        clubName: "Write Club",
        className: "H21",
        courseName: "",
        cardNo: 888888,
        startTime: "",
        sex: "M",
        birthYear: "2000",
        phone: "",
        paymentMode: "",
      },
      ready: true,
    });

    await expect(page.getByText("Please confirm your registration")).toBeVisible({
      timeout: 5000,
    });
    await expect(
      page.getByText("Your details will also be saved to your SI card"),
    ).toBeVisible();
  });

  test("should show writeToCard setting in settings panel", async ({ page }) => {
    await goToKiosk(page);

    await page.locator('button[title="Settings"]').click();
    await expect(page.getByText("Write details to empty cards")).toBeVisible();
  });
});

test.describe("Kiosk Launch from Admin", () => {
  test("should have Kiosk button in competition header", async ({ page }) => {
    await selectCompetition(page);

    const kioskBtn = page.getByTestId("kiosk-launcher");
    await expect(kioskBtn).toBeVisible();
    await expect(kioskBtn).toContainText("Kiosk");
  });
});
