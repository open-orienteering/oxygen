/**
 * E2E tests for the smart kiosk flow.
 *
 * Tests duplicate card prevention on the registration page,
 * readout screen with server-side split data for real runners,
 * and correct kiosk routing based on DB runner state.
 */

import { test, expect, type Page } from "@playwright/test";

const COMPETITION_NAME = "My example tävling";

async function selectCompetition(page: Page) {
  await page.goto("/");
  await page.getByText(COMPETITION_NAME).click();
  await expect(page.getByRole("button", { name: "Dashboard" })).toBeVisible({
    timeout: 10000,
  });
}

function getNameId(page: Page): string {
  const url = new URL(page.url());
  const parts = url.pathname.split("/").filter(Boolean);
  return parts[0] || "";
}

async function goToKiosk(page: Page) {
  await selectCompetition(page);
  const nameId = getNameId(page);
  await page.goto(`/${nameId}/kiosk`);
  await expect(page.getByText("Insert your SI card")).toBeVisible({
    timeout: 10000,
  });
}

async function openRegistrationDialog(page: Page) {
  await selectCompetition(page);
  const nameId = getNameId(page);
  await page.goto(`/${nameId}/runners`);
  await expect(page.getByRole("button", { name: "Add Runner" })).toBeVisible({ timeout: 10000 });
  await page.getByRole("button", { name: "Add Runner" }).click();
  await expect(page.getByTestId("registration-dialog")).toBeVisible({ timeout: 5000 });
}

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

// ─── Auto-fill from runner DB ─────────────────────────────

test.describe("Registration: Auto-fill from Runner DB", () => {
  test("should auto-fill from runner DB lookup without opening suggestions dropdown", async ({
    page,
  }) => {
    await openRegistrationDialog(page);

    // Intercept the lookupByCardNo tRPC call to return a known runner
    await page.route("**/trpc/eventor.lookupByCardNo*", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          result: {
            data: {
              name: "Testsson, Erik",
              cardNo: 887766,
              clubEventorId: 0,
              clubName: "Test OK",
              birthYear: 1990,
              sex: "M",
            },
          },
        }),
      });
    });

    const dialog = page.getByTestId("registration-dialog");

    // Enter card number in the dialog's card input
    const cardInput = dialog.locator("input[placeholder='e.g. 500123']");
    await cardInput.fill("887766");
    await cardInput.press("Tab"); // Trigger lookup

    // Wait for auto-fill to populate the name field
    const nameInput = dialog.locator("input[placeholder='First Last']");
    await expect(nameInput).toHaveValue("Erik Testsson", { timeout: 5000 });

    // Suggestions dropdown should NOT be visible after auto-fill
    await page.waitForTimeout(500); // Allow debounced search to fire if it would
    await expect(dialog.getByTestId("name-suggestions")).not.toBeVisible();

    // Name input should NOT have focus — class selector should be next
    await expect(nameInput).not.toBeFocused();
  });
});

// ─── Duplicate card prevention on Registration page ─────────

test.describe("Registration: Duplicate Card Prevention", () => {
  test("should show warning when entering a card already assigned to a runner", async ({
    page,
  }) => {
    await openRegistrationDialog(page);

    const dialog = page.getByTestId("registration-dialog");

    // Enter card 501438 which belongs to Malin Johannesson in the seed data
    const cardInput = dialog.locator("input[placeholder='e.g. 500123']");
    await cardInput.fill("501438");
    await cardInput.press("Tab"); // Trigger lookup

    // Wait for the duplicate card warning to appear (async fetch + query)
    await expect(
      dialog.getByText(/already assigned/),
    ).toBeVisible({ timeout: 10000 });
  });

  test("should not show warning for an unassigned card number", async ({
    page,
  }) => {
    await openRegistrationDialog(page);

    const dialog = page.getByTestId("registration-dialog");
    const cardInput = dialog.locator("input[placeholder='e.g. 500123']");
    await cardInput.fill("999888");
    await cardInput.press("Tab"); // Trigger lookup

    // No warning should appear
    await page.waitForTimeout(1000);
    await expect(dialog.getByText(/already assigned/)).not.toBeVisible();
  });

  test("should register a runner with a unique card via API", async ({
    page,
  }) => {
    await openRegistrationDialog(page);

    const dialog = page.getByTestId("registration-dialog");

    // Enter card number
    const cardInput = dialog.locator("input[placeholder='e.g. 500123']");
    await cardInput.fill("999666");
    await cardInput.press("Tab");

    // Fill minimal registration form
    const nameInput = dialog.locator("input[placeholder='First Last']");
    await nameInput.click();
    await nameInput.fill("Test Unique");
    // Select a class using the SearchableSelect
    await dialog.getByTestId("reg-class").click();
    await page.waitForTimeout(300);
    await dialog.getByText("Öppen 1", { exact: true }).click();

    // Submit
    await dialog.getByTestId("reg-submit").click();

    // Dialog should close after successful registration
    await expect(page.getByTestId("registration-dialog")).not.toBeVisible({ timeout: 5000 });

    // Runner should appear in the list
    await expect(page.getByText("Test Unique")).toBeVisible({ timeout: 5000 });

    // Clean up: soft-delete the registered runner so it doesn't affect other test counts
    const deleted = await page.evaluate(async () => {
      const findResp = await fetch(`/trpc/runner.findByCard?input=${encodeURIComponent(JSON.stringify({ cardNo: 999666 }))}`);
      const findData = await findResp.json();
      const id = findData?.result?.data?.id;
      if (!id) return "not-found";
      // tRPC v10 single mutation: POST with Content-Type application/json
      const delResp = await fetch("/trpc/runner.delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      return delResp.ok ? "deleted" : `error-${delResp.status}`;
    });
    expect(deleted).toBe("deleted");
  });
});

// ─── Kiosk readout with server-side data ────────────────────

test.describe("Kiosk: Smart Readout", () => {
  test("should show readout screen with controls count for a known finished runner", async ({
    page,
  }) => {
    await goToKiosk(page);
    const nameId = getNameId(page);

    // Nilsson Collryd (cardNo=501061, status OK, has full punch data matching course)
    await sendKioskMessage(page, nameId, {
      type: "card-readout",
      card: {
        id: "smart-readout-1",
        cardNumber: 501061,
        cardType: "SI8",
        action: "readout",
        hasRaceData: true,
        runnerName: "Nilsson Collryd",
        className: "Öppen 1",
        clubName: "Test Club",
        status: "OK",
        runningTime: 12340,
      },
    });

    // Should show readout screen with runner info
    await expect(page.getByRole("heading", { name: "Nilsson Collryd" })).toBeVisible({ timeout: 5000 });
    await expect(page.getByText("Completed")).toBeVisible({ timeout: 8000 });

    // Server-side readout data should show controls count (from the real DB)
    await expect(page.getByText("Controls", { exact: true })).toBeVisible({ timeout: 8000 });
  });

  test("should show MP status and missing controls for mispunched runner", async ({
    page,
  }) => {
    await goToKiosk(page);
    const nameId = getNameId(page);

    // Bo-Göran Persson (500944) has status=3 (MP) — missing controls 39 and 77
    await sendKioskMessage(page, nameId, {
      type: "card-readout",
      card: {
        id: "smart-mp-1",
        cardNumber: 500944,
        cardType: "SI8",
        action: "readout",
        hasRaceData: true,
        runnerName: "Bo-Göran Persson",
        className: "Öppen 1",
        status: "MP",
        runningTime: 15000,
      },
    });

    await expect(page.getByText("Bo-Göran Persson")).toBeVisible({ timeout: 5000 });
    await expect(page.getByText("Missing Punch")).toBeVisible({ timeout: 8000 });

    // Server should return missing controls info
    await expect(page.getByText(/Missing controls/)).toBeVisible({ timeout: 8000 });
  });

  test("should show pre-start screen for registered runner with no result", async ({
    page,
  }) => {
    await goToKiosk(page);
    const nameId = getNameId(page);

    // Albin Bergman (2220164) has status=0, finishTime=0 in seed data
    await sendKioskMessage(page, nameId, {
      type: "card-readout",
      card: {
        id: "smart-prestart-1",
        cardNumber: 2220164,
        cardType: "SIAC",
        action: "pre-start",
        hasRaceData: false,
        runnerName: "Albin Bergman",
        className: "H21",
        clubName: "Test Club",
      },
    });

    await expect(page.getByText("Ready to Start")).toBeVisible({ timeout: 5000 });
    await expect(page.getByText("Albin Bergman")).toBeVisible();
  });

  test("should show readout for DNF runner", async ({ page }) => {
    await goToKiosk(page);
    const nameId = getNameId(page);

    // Magnus Johansson (501162) has status=4 (DNF) in seed data
    await sendKioskMessage(page, nameId, {
      type: "card-readout",
      card: {
        id: "smart-dnf-1",
        cardNumber: 501162,
        cardType: "SI8",
        action: "readout",
        hasRaceData: true,
        runnerName: "Magnus Johansson",
        className: "H21",
        status: "DNF",
        runningTime: 0,
      },
    });

    await expect(page.getByText("Magnus Johansson")).toBeVisible({ timeout: 5000 });
    await expect(page.getByText("Did Not Finish")).toBeVisible();
  });
});

// ─── Kiosk: Registration flow for unknown card ──────────────

test.describe("Kiosk: Registration Flow", () => {
  test("should enter registration-waiting for unknown card and complete via admin", async ({
    page,
  }) => {
    await goToKiosk(page);
    const nameId = getNameId(page);

    // Unknown card → registration
    await sendKioskMessage(page, nameId, {
      type: "card-readout",
      card: {
        id: "smart-reg-1",
        cardNumber: 888888,
        cardType: "SI8",
        action: "register",
        hasRaceData: false,
      },
    });

    await expect(page.getByText("Registration in progress")).toBeVisible({
      timeout: 5000,
    });
    await expect(page.getByText("888888")).toBeVisible();

    // Admin sends form state
    await sendKioskMessage(page, nameId, {
      type: "registration-state",
      form: {
        name: "Smart Kiosk Runner",
        clubName: "Test Club",
        className: "H21",
        courseName: "",
        cardNo: 888888,
        startTime: "11:00:00",
        sex: "M",
        birthYear: "2000",
        phone: "",
        paymentMode: "cash",
      },
      ready: true,
    });

    await expect(page.getByText("Smart Kiosk Runner")).toBeVisible({ timeout: 5000 });
    await expect(page.getByText("Cash")).toBeVisible();

    // Complete registration
    await sendKioskMessage(page, nameId, {
      type: "registration-complete",
      runner: {
        name: "Smart Kiosk Runner",
        className: "H21",
        clubName: "Test Club",
        startTime: "11:00:00",
        cardNo: 888888,
      },
    });

    await expect(page.getByText("Registration Complete!")).toBeVisible({
      timeout: 5000,
    });
    await expect(page.getByText("Smart Kiosk Runner")).toBeVisible();
  });
});

// ─── Kiosk: Re-scanning a registered card ───────────────────

test.describe("Kiosk: Re-scan Known Card", () => {
  test("should show pre-start (not registration) when re-scanning a known runner's card", async ({
    page,
  }) => {
    await goToKiosk(page);
    const nameId = getNameId(page);

    // Albin Bergman (card 2220164) is already registered with no finish time
    // Sending with action "pre-start" (as DeviceManager would after DB lookup)
    await sendKioskMessage(page, nameId, {
      type: "card-readout",
      card: {
        id: "rescan-1",
        cardNumber: 2220164,
        cardType: "SIAC",
        action: "pre-start",
        hasRaceData: false,
        runnerName: "Albin Bergman",
        className: "Öppen 1",
        clubName: "Test Club",
      },
    });

    // Should show pre-start screen, NOT registration-waiting
    await expect(page.getByText("Ready to Start")).toBeVisible({ timeout: 5000 });
    await expect(page.getByText("Albin Bergman")).toBeVisible();
    await expect(page.getByText("Registration in progress")).not.toBeVisible();
  });

  test("should NOT enter registration mode when kiosk receives readout for known card", async ({
    page,
  }) => {
    await goToKiosk(page);
    const nameId = getNameId(page);

    // First simulate an incorrect "register" action (as if DeviceManager's initial state)
    // then immediately correct it with "pre-start" (as DeviceManager does after DB lookup)
    await sendKioskMessage(page, nameId, {
      type: "card-readout",
      card: {
        id: "rescan-race-1",
        cardNumber: 2220164,
        cardType: "SIAC",
        action: "register",
        hasRaceData: false,
      },
    });

    // Give kiosk a moment to process the first message
    await page.waitForTimeout(200);

    // Now send the corrected message (simulating DeviceManager after DB lookup)
    await sendKioskMessage(page, nameId, {
      type: "card-readout",
      card: {
        id: "rescan-race-1",
        cardNumber: 2220164,
        cardType: "SIAC",
        action: "pre-start",
        hasRaceData: false,
        runnerName: "Albin Bergman",
        className: "Öppen 1",
        clubName: "Test Club",
      },
    });

    // Should show pre-start screen after correction
    await expect(page.getByText("Ready to Start")).toBeVisible({ timeout: 5000 });
    await expect(page.getByText("Albin Bergman")).toBeVisible();
  });
});

// ─── Stale punch detection via API ──────────────────────────

test.describe("Stale Punch Detection", () => {
  test("storeReadout rejects punches with foreign control codes", async ({ page }) => {
    await selectCompetition(page);

    // Call storeReadout via tRPC with foreign control codes (not in competition)
    const result = await page.evaluate(async () => {
      const resp = await fetch("/trpc/cardReadout.storeReadout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cardNo: 999777,
          punches: [
            { controlCode: 201, time: 36000 },
            { controlCode: 202, time: 36120 },
            { controlCode: 203, time: 36240 },
          ],
          startTime: 35900,
          finishTime: 36300,
          cardType: "SI8",
        }),
      });
      return resp.json();
    });

    // The server should flag punches as not relevant
    expect(result?.result?.data?.punchesRelevant).toBe(false);
  });

  test("storeReadout accepts punches matching competition controls", async ({ page }) => {
    await selectCompetition(page);

    // Use controls from the seed data competition (e.g. 67, 39, 78 from Bana 1)
    const result = await page.evaluate(async () => {
      const resp = await fetch("/trpc/cardReadout.storeReadout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cardNo: 999778,
          punches: [
            { controlCode: 67, time: 36000 },
            { controlCode: 39, time: 36120 },
            { controlCode: 78, time: 36240 },
          ],
          startTime: 35900,
          finishTime: 36300,
          cardType: "SI8",
        }),
      });
      return resp.json();
    });

    expect(result?.result?.data?.punchesRelevant).toBe(true);
  });

  test("kiosk shows pre-start for known runner with stale punch data", async ({ page }) => {
    await goToKiosk(page);
    const nameId = getNameId(page);

    // Albin Bergman (2220164) has no result in DB.
    // Send as "pre-start" — this simulates what DeviceManager would send
    // after detecting stale punches (DOW mismatch or foreign controls)
    await sendKioskMessage(page, nameId, {
      type: "card-readout",
      card: {
        id: "stale-test-1",
        cardNumber: 2220164,
        cardType: "SIAC",
        action: "pre-start", // DeviceManager routed here despite card having punches
        hasRaceData: false,  // Stale punches → not relevant
        runnerName: "Albin Bergman",
        className: "H21",
        clubName: "Test Club",
      },
    });

    // Should show pre-start, NOT readout/DNF
    await expect(page.getByText("Ready to Start")).toBeVisible({ timeout: 5000 });
    await expect(page.getByText("Albin Bergman")).toBeVisible();
  });
});
