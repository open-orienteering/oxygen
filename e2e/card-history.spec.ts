/**
 * E2E test for the readout-history section in the Cards page detail panel.
 *
 * Regression test: cardReadout.readoutHistory used to return only
 * {id, cardType, voltageMv, readAt, stationId}, so the punch / battery /
 * owner / metadata fields the section renders were never present and the
 * expanded view always showed "No punch data".
 */

import { test, expect } from "@playwright/test";
import { API_BASE } from "./helpers/api-base";

const COMPETITION_NAME = "My example tävling";
const COMP_HEADERS = { "x-competition-id": "itest" };
const CARD_NO = 2988820;

test.describe("Cards page — readout history", () => {
  test.beforeAll(async ({ request }) => {
    const resp = await request.post(`${API_BASE}/trpc/cardReadout.storeReadout`, {
      headers: COMP_HEADERS,
      data: {
        cardNo: CARD_NO,
        cardType: "SI Card 10",
        punches: [
          { controlCode: 31, time: 366000 }, // 10:10:00
          { controlCode: 32, time: 367200 }, // 10:12:00
        ],
        batteryVoltage: 2870, // mV
        ownerData: { firstName: "Karin", lastName: "Karta" },
        metadata: { clearCount: 42 },
      },
    });
    expect(resp.ok()).toBeTruthy();
  });

  test("shows punches, battery, owner and metadata for a stored readout", async ({ page }) => {
    await page.goto("/");
    await page.getByText(COMPETITION_NAME).click();
    await expect(page.getByRole("link", { name: "Dashboard" })).toBeVisible({
      timeout: 10000,
    });
    const nameId = new URL(page.url()).pathname.split("/").filter(Boolean)[0];
    await page.goto(`/${nameId}/cards`);

    // Open the detail panel for our card
    await page.getByText(String(CARD_NO)).first().click();

    const history = page.getByTestId("readout-history");
    await expect(history).toBeVisible({ timeout: 10000 });

    // Summary row: punch count, owner, battery volts
    const row = history.getByTestId("readout-history-row").first();
    await expect(row).toContainText("2 punches");
    await expect(row).toContainText("Owner: Karin Karta");
    await expect(row).toContainText("2.87V");

    // Expanded view: punch codes with absolute HH:MM:SS times + metadata
    await row.getByRole("button").click();
    const punchTable = history.getByTestId("readout-history-punches");
    await expect(punchTable).toBeVisible();
    await expect(punchTable).toContainText("31");
    await expect(punchTable).toContainText("10:10:00");
    await expect(punchTable).toContainText("32");
    await expect(punchTable).toContainText("10:12:00");
    await expect(row).toContainText("Clears: 42");
  });
});
