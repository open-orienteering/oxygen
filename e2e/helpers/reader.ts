import { expect, type Page } from "@playwright/test";

/**
 * Connect the mocked USB SI station (see mock-webserial.ts) through the
 * reader connection dialog: open it from the header pill (or the kiosk's
 * reader button), pick "USB station", and wait for the live indicator.
 * The dialog closes itself after a successful connect.
 */
export async function connectMockSerialReader(page: Page, timeout = 5000): Promise<void> {
  await page.getByTestId("reader-menu").click();
  await expect(page.getByTestId("reader-dialog")).toBeVisible();
  await page.getByTestId("connect-reader").click();
  await expect(page.getByTestId("reader-status")).toBeVisible({ timeout });
  await expect(page.getByTestId("reader-dialog")).toBeHidden();
}
