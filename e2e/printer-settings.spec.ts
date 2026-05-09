import { test, expect, type Page } from "@playwright/test";
import { getMockWebUsbScript } from "./helpers/mock-webusb";

declare global {
  interface Window {
    __usbMock: {
      setMode(m: "printer-class" | "virtual-com"): void;
      getMode(): "printer-class" | "virtual-com";
      getWrittenBytes(): number[][];
      getMemorySwitch(n: number): string;
      setMemorySwitch(n: number, bits: string): void;
      simulateUnplug(): void;
      simulatePlug(): void;
      reset(): void;
    };
  }
}

async function selectCompetition(page: Page) {
  await page.goto("/");
  await page.getByText("My example tävling").click();
  await expect(page.getByRole("link", { name: "Dashboard" })).toBeVisible({
    timeout: 10000,
  });
}

async function ensurePrinterConnected(page: Page) {
  // The mock's auto-connect path may or may not have fired by the time we
  // get here, so explicitly click Connect Printer if it's visible.
  const connectBtn = page.getByRole("button", { name: /Connect Printer/i });
  if (await connectBtn.isVisible().catch(() => false)) {
    await connectBtn.click();
    // Wait for it to disappear (replaced by the connected status indicator).
    await expect(connectBtn).not.toBeVisible({ timeout: 5000 });
  }
}

async function openPrinterSettings(page: Page) {
  await ensurePrinterConnected(page);
  await page.getByTestId("more-menu-button").click();
  await page.getByTestId("printer-settings-launcher").click();
  await expect(page.getByTestId("printer-settings-dialog")).toBeVisible();
}

test.describe("Printer Settings dialog", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(getMockWebUsbScript("printer-class"));
    // Clear any history left by previous tests in the same browser context.
    await page.addInitScript(() => {
      try {
        localStorage.removeItem("oxygen.printer-flash-history.v1");
      } catch {
        /* noop */
      }
    });
  });

  test("opens from More menu and shows printer identity", async ({ page }) => {
    await selectCompetition(page);
    await openPrinterSettings(page);

    await expect(page.getByText("0x1D90")).toBeVisible();
    await expect(page.getByText("0x2060")).toBeVisible();
    await expect(page.getByText("Thermal Printer")).toBeVisible();
  });

  test("shows current USB mode and offers to switch", async ({ page }) => {
    await selectCompetition(page);
    await openPrinterSettings(page);

    // The CT-S310II is in printer-class mode in this test, so the action
    // button should be "Switch to Virtual COM".
    await expect(page.getByTestId("printer-flash-button")).toHaveText(
      /Virtual COM/,
    );
  });

  test("flashes to Virtual COM, shows confirmation, and records the flash", async ({ page }) => {
    await selectCompetition(page);
    await openPrinterSettings(page);

    await page.getByTestId("printer-flash-button").click();
    await expect(page.getByTestId("printer-flash-confirm")).toBeVisible();
    await page.getByTestId("printer-flash-confirm-button").click();

    await expect(page.getByTestId("printer-flash-success")).toBeVisible();

    // Verify a GS ( E fn=3 command was sent for SW5 with bit 3 = '0'.
    const written = await page.evaluate(() => window.__usbMock.getWrittenBytes());
    const cmd = written.find(
      (b) =>
        b.length === 15 &&
        b[0] === 0x1d &&
        b[1] === 0x28 &&
        b[2] === 0x45 &&
        b[5] === 0x03 &&
        b[6] === 5,
    );
    expect(cmd, "expected a GS ( E fn=3 SW=5 command").toBeDefined();
    // bytes[7..14] are the bit chars; bit 3 lives at index 5 (= 8 - 3),
    // so cmd[7+5] = cmd[12] should be '0' (0x30) for virtual-com.
    expect(cmd![12]).toBe(0x30);

    // Flash history should now show a pending restore.
    const history = await page.evaluate(() =>
      JSON.parse(localStorage.getItem("oxygen.printer-flash-history.v1") || "{}"),
    );
    const records = Object.values(history) as Array<{ originalMode: string; currentMode: string }>;
    expect(records).toHaveLength(1);
    expect(records[0].originalMode).toBe("printer-class");
    expect(records[0].currentMode).toBe("virtual-com");
  });

  test("borrowed-equipment warning appears after a flash and can be dismissed", async ({ page }) => {
    await selectCompetition(page);
    await openPrinterSettings(page);

    // Flash → confirm → success.
    await page.getByTestId("printer-flash-button").click();
    await page.getByTestId("printer-flash-confirm-button").click();
    await expect(page.getByTestId("printer-flash-success")).toBeVisible();

    // Close and reopen so the borrowed warning is re-evaluated.
    await page.getByText(/I will power-cycle/).click();
    await page.evaluate(() => window.__usbMock.setMode("virtual-com"));
    await openPrinterSettings(page);

    await expect(page.getByTestId("printer-borrowed-warning")).toBeVisible();
    await expect(page.getByTestId("printer-borrowed-warning")).toContainText(
      "Restore it to Printer Class",
    );

    // Dismiss the record.
    await page.getByText("Forget this record").click();
    await expect(page.getByTestId("printer-borrowed-warning")).not.toBeVisible();
  });

  test("reads memory switches on demand, tolerating leading garbage in the IN buffer", async ({ page }) => {
    await selectCompetition(page);
    await openPrinterSettings(page);

    await page.getByTestId("printer-read-switches-button").click();

    // SW5 is highlighted and should display "00000100" — the value
    // matching our slip-from-exploration (MSW5-3 ON = Printer Class).
    // The mock injects 4 bytes of garbage (0x31 0x60 0x31 0x60) before
    // each response; the driver must skip past it and still find the
    // documented 0x37 0x21 header.
    const switches = page.getByTestId("printer-memory-switches");
    await expect(switches).toBeVisible();
    await expect(switches).toContainText("00000100");
  });

  test("triggers a self-test print", async ({ page }) => {
    await selectCompetition(page);
    await openPrinterSettings(page);

    await page.getByTestId("printer-self-test-button").click();

    const written = await page.evaluate(() => window.__usbMock.getWrittenBytes());
    // GS ( A 02 00 00 02 = 1d 28 41 02 00 00 02
    const found = written.some(
      (b) =>
        b.length === 7 &&
        b[0] === 0x1d &&
        b[1] === 0x28 &&
        b[2] === 0x41 &&
        b[3] === 0x02 &&
        b[4] === 0x00 &&
        b[5] === 0x00 &&
        b[6] === 0x02,
    );
    expect(found).toBe(true);
  });
});
