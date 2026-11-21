/**
 * SI readers in the browser: a USB station and a Bluetooth Reader BT, both
 * mocked (e2e/helpers/mock-webserial.ts, mock-webbluetooth.ts), so the shot
 * needs no hardware.
 */
import { expect, test, type Page } from "@playwright/test";
import { getMockWebBluetoothScript } from "../helpers/mock-webbluetooth";
import { getMockWebSerialScript } from "../helpers/mock-webserial";
import { EVENT, selectEvent, shot, showcaseGuards } from "./shot";

showcaseGuards();

async function openReaderDialog(page: Page) {
  await page.getByTestId("reader-status").or(page.getByTestId("reader-menu")).first().click();
  await expect(page.getByTestId("reader-dialog")).toBeVisible();
}

test("readers: USB station and Reader BT", async ({ page }) => {
  await page.addInitScript(getMockWebBluetoothScript());
  await page.addInitScript(getMockWebSerialScript());
  await selectEvent(page);
  await page.goto(`/${EVENT}/runners`); // no map behind the dialog's rounded corners
  await openReaderDialog(page);
  await page.getByTestId("connect-reader").click();
  await expect(page.getByTestId("reader-status")).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId("reader-dialog")).toBeHidden();
  await openReaderDialog(page);
  await page.getByTestId("connect-reader-bt").click();
  await expect(page.getByTestId("reader-dialog")).toBeHidden({ timeout: 10_000 });
  await openReaderDialog(page);
  const dialog = page.getByTestId("reader-dialog");
  await expect(dialog.getByTestId("reader-row-ble")).toContainText("Battery");
  await page.waitForTimeout(500);
  await shot(page, "readers", dialog);
});
