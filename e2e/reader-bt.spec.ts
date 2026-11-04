import { test, expect, type Page } from "@playwright/test";
import { getMockWebBluetoothScript, type ReaderBtMockApi } from "./helpers/mock-webbluetooth";
import { getMockWebSerialScript } from "./helpers/mock-webserial";
import { connectMockSerialReader } from "./helpers/reader";
import { waitForTrpc } from "./helpers/trpc";

declare global {
  interface Window {
    __readerBtMock: ReaderBtMockApi;
    __readerBtLastRequest?: unknown;
    __readerBtForgotten?: boolean;
    __siMock: { insertCard(cardNumber: number, punches?: Array<{ controlCode: number; time: number }>): boolean };
  }
}

async function selectCompetition(page: Page) {
  await page.goto("/");
  await page.getByText("My example tävling").click();
  await expect(page.getByRole("link", { name: "Dashboard" })).toBeVisible({ timeout: 10000 });
}

/** Open the dialog from whichever pill is showing. */
async function openReaderDialog(page: Page) {
  const pill = page.getByTestId("reader-status").or(page.getByTestId("reader-menu"));
  await pill.click();
  await expect(page.getByTestId("reader-dialog")).toBeVisible();
}

async function connectMockReaderBt(page: Page) {
  await openReaderDialog(page);
  await page.getByTestId("connect-reader-bt").click();
  await expect(page.getByTestId("reader-status")).toBeVisible({ timeout: 5000 });
  await expect(page.getByTestId("reader-dialog")).toBeHidden();
}

const btRow = (page: Page) => page.getByTestId("reader-dialog").getByTestId("reader-row-ble");

test.beforeEach(async ({ page }) => {
  await page.addInitScript(getMockWebBluetoothScript());
  await page.addInitScript(getMockWebSerialScript());
});

test.describe("Reader BT (Web Bluetooth)", () => {
  test("dialog offers Bluetooth with help, and connects a Reader BT", async ({ page }) => {
    await selectCompetition(page);
    await openReaderDialog(page);
    const dialog = page.getByTestId("reader-dialog");
    await expect(dialog.getByTestId("connect-reader-bt")).toBeEnabled();
    await expect(dialog.getByTestId("connect-reader-bt")).toContainText("Bluetooth Reader BT");
    await dialog.getByTestId("reader-bt-help").locator("summary").click();
    await expect(dialog.getByTestId("reader-bt-help")).toContainText("Do not pair the reader");
    await page.getByTestId("reader-dialog-close").click();

    await connectMockReaderBt(page);
    expect(await page.evaluate(() => window.__readerBtMock.isConnected())).toBe(true);
    const request = await page.evaluate(() => window.__readerBtLastRequest);
    expect(request).toMatchObject({
      filters: [{ services: ["bd510001-6aec-4628-a146-f3e95bc49e62"] }, { namePrefix: "Reader BT" }],
    });

    await openReaderDialog(page);
    const row = btRow(page);
    await expect(row).toHaveCount(1);
    await expect(row).toContainText("Reader BT 500123");
    await expect(row).toContainText("Bluetooth");
    await expect(row).toContainText("SN 500123");
    await expect(row).toContainText("FW 2.1.0");
    await expect(row).toContainText("Battery 87 %");
    await expect(row.getByTestId("reader-status-chip")).toHaveText("Ready");
    await expect(row.getByTestId("reader-mode-warning")).toHaveCount(0);

    await page.evaluate(() => window.__readerBtMock.setBattery(64));
    await expect(row).toContainText("Battery 64 %");
  });

  test("a card on the Reader BT is read out, stored and acknowledged", async ({ page }) => {
    await selectCompetition(page);
    await connectMockReaderBt(page);

    const stored = waitForTrpc(page, "cardReadout.storeReadout");
    const resolved = waitForTrpc(page, "cardReadout.readout");
    await page.evaluate(() =>
      window.__readerBtMock.insertCard(8007046, [{ controlCode: 31, time: 36360 }], {
        ownerData: { firstName: "Bea", lastName: "Blåtand", club: "OK Ärla" },
      }),
    );
    const storeResp = await stored;
    await resolved;

    const body = JSON.parse(storeResp.request().postData() ?? "{}");
    const input = body["0"]?.json ?? body["0"] ?? body.json ?? body;
    expect(input.cardNo).toBe(8007046);
    expect(input.cardType).toBe("SIAC");
    expect(input.punches).toEqual([{ controlCode: 31, time: 363600 }]);
    expect(input.finishTime).toBe(387000);
    expect(input.batteryVoltage).toBe(3050); // mV, as the API and MeOS store it

    const notif = page.getByTestId("card-notification");
    await expect(notif).toBeVisible({ timeout: 5000 });
    await expect(notif).toContainText("8007046");
    await expect(notif).toContainText("Bea Blåtand");

    // Feedback OK (two beeps) goes back to the reader.
    expect(await page.evaluate(() => window.__readerBtMock.getFeedback())).toEqual([1]);
  });

  test("disconnect keeps the reader listed; Reconnect waits for a card; Forget drops it", async ({
    page,
  }) => {
    await selectCompetition(page);
    await connectMockReaderBt(page);

    await openReaderDialog(page);
    await btRow(page).getByTestId("disconnect-reader").click();
    await expect(btRow(page).getByTestId("reader-status-chip")).toHaveText("Not connected");
    await expect(btRow(page).getByTestId("reader-bt-state-hint")).toContainText("asleep");
    expect(await page.evaluate(() => window.__readerBtMock.isConnected())).toBe(false);

    await btRow(page).getByTestId("reconnect-reader").click();
    await expect(btRow(page).getByTestId("reader-bt-state-hint")).toContainText("Waiting for the reader");
    // Inserting a card wakes the reader; it advertises and Oxygen connects.
    await page.evaluate(() => window.__readerBtMock.insertCard(2220164, []));
    await expect(btRow(page).getByTestId("reader-status-chip")).toHaveText("Ready", { timeout: 5000 });

    await btRow(page).getByTestId("forget-reader").click();
    await expect(btRow(page)).toHaveCount(0);
    expect(await page.evaluate(() => window.__readerBtForgotten)).toBe(true);
    expect(await page.evaluate(() => localStorage.getItem("oxygen-reader-bt-devices"))).toBe("[]");
    expect(await page.evaluate(() => window.__readerBtMock.isConnected())).toBe(false);
  });

  test("recovers after the link drops", async ({ page }) => {
    await selectCompetition(page);
    await connectMockReaderBt(page);
    expect(await page.evaluate(() => window.__readerBtMock.connectCount())).toBe(1);

    await page.evaluate(() => window.__readerBtMock.simulateDisconnect());
    await openReaderDialog(page);
    await expect(btRow(page).getByTestId("reader-status-chip")).toHaveText("Connection lost");
    await expect(btRow(page).getByTestId("reader-bt-state-hint")).toContainText("Trying to reconnect");

    // The next card wakes the reader, which advertises; Oxygen reconnects.
    await page.evaluate(() => window.__readerBtMock.insertCard(2220164, []));
    await expect(btRow(page).getByTestId("reader-status-chip")).toHaveText("Ready", { timeout: 5000 });
    expect(await page.evaluate(() => window.__readerBtMock.connectCount())).toBe(2);
    await page.getByTestId("reader-dialog-close").click();

    // Card flow works on the new connection.
    const resolved = waitForTrpc(page, "cardReadout.readout");
    await page.evaluate(() => window.__readerBtMock.removeCard());
    await page.evaluate(() =>
      window.__readerBtMock.insertCard(2220165, [{ controlCode: 31, time: 36360 }]),
    );
    await resolved;
    await expect(page.getByTestId("card-notification")).toContainText("2220165", { timeout: 5000 });
  });

  test("a remembered Reader BT reconnects after a reload without the picker", async ({ page }) => {
    await selectCompetition(page);
    await connectMockReaderBt(page);
    expect(
      await page.evaluate(() => JSON.parse(localStorage.getItem("oxygen-reader-bt-devices") ?? "[]")),
    ).toMatchObject([{ id: "mock-reader-bt-500123", name: "Reader BT 500123" }]);

    await page.reload();
    await expect(page.getByRole("link", { name: "Dashboard" })).toBeVisible({ timeout: 10000 });
    await page.evaluate(() => (window.__readerBtLastRequest = undefined));
    await openReaderDialog(page);
    await expect(btRow(page).getByTestId("reader-bt-state-hint")).toContainText("Waiting for the reader");

    await page.evaluate(() => window.__readerBtMock.insertCard(2220164, []));
    await expect(btRow(page).getByTestId("reader-status-chip")).toHaveText("Ready", { timeout: 5000 });
    expect(await page.evaluate(() => window.__readerBtLastRequest)).toBeUndefined();
  });

  test("USB station and Reader BT at once both feed Recent Cards", async ({ page }) => {
    await selectCompetition(page);
    await connectMockSerialReader(page, 5000);
    await connectMockReaderBt(page);
    await expect(page.getByTestId("reader-status")).toContainText("2 readers");

    await openReaderDialog(page);
    await expect(page.getByTestId("reader-dialog").getByTestId("reader-row-serial")).toHaveCount(1);
    await expect(btRow(page)).toHaveCount(1);
    await page.getByTestId("reader-dialog-close").click();

    const first = waitForTrpc(page, "cardReadout.readout");
    await page.evaluate(() => window.__siMock.insertCard(501438, [{ controlCode: 31, time: 36360 }]));
    await first;
    const second = waitForTrpc(page, "cardReadout.readout");
    await page.evaluate(() =>
      window.__readerBtMock.insertCard(2220164, [{ controlCode: 32, time: 36420 }]),
    );
    await second;

    await page.getByTestId("recent-cards-button").click();
    const panel = page.getByTestId("recent-cards-panel");
    await expect(panel).toContainText("501438");
    await expect(panel).toContainText("2220164");
  });
});
