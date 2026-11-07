/**
 * Red exit: a run that matches another variant (slice F, row F6c; user
 * answer 3, 2026-11-07; docs/registration-and-readout.md §4f).
 *
 * A runner pre-set on variant A runs B's fork. The mock SI reader reads
 * B's punches: the kiosk shows MP and points to the desk; the readout-station
 * page and the Runners page show "Punches match variant B"; the official's
 * Accept variant B makes the run OK on B, and the start list shows B.
 *
 * Uses an SI8 card number (2000000+): SI5/SI6 cards carry no punch data
 * through the WebSerial parser.
 */

import { test, expect, type Page } from "@playwright/test";
import { getMockWebSerialScript } from "./helpers/mock-webserial";
import { waitForTrpc } from "./helpers/trpc";
import { openKioskTab } from "./helpers/kiosk";

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

const headers = { "x-competition-id": "itest" };

async function selectCompetition(page: Page) {
  await page.goto("/");
  await page.getByText("My example tävling").click();
  await expect(page.getByRole("link", { name: "Dashboard" })).toBeVisible({ timeout: 10000 });
}

test("a run of another variant is MP on the kiosk and accepted at the desk (F6c)", async ({ context, page }) => {
  const post = async (path: string, data: unknown) => {
    const res = await page.request.post(`/trpc/${path}`, { headers, data });
    expect(res.ok(), `${path}: ${await res.text()}`).toBe(true);
    return (await res.json()).result.data;
  };
  const get = async (path: string, input: unknown) => {
    const res = await page.request.get(`/trpc/${path}?input=${encodeURIComponent(JSON.stringify(input))}`, { headers });
    expect(res.ok(), `${path}: ${await res.text()}`).toBe(true);
    return (await res.json()).result.data;
  };

  // A butterfly: 176 → (A 177 | B 178) → 179.
  const stamp = Date.now();
  const controls: number[] = [];
  for (const [i, code] of [176, 177, 178, 179].entries()) {
    controls.push((await post("control.create", { codes: String(code), xpos: 20 + i * 10, ypos: 30 })).id as number);
  }
  const root = (await post("course.create", { name: `E2E Red exit ${stamp}` })).id as number;
  await post("course.setStructure", {
    courseId: root,
    structure: {
      version: 1,
      id: "fork",
      orderMode: "ordered",
      items: [
        { siteId: controls[0] },
        {
          kind: "variation",
          id: "g",
          alternatives: [
            { label: "A", items: [{ siteId: controls[1] }] },
            { label: "B", items: [{ siteId: controls[2] }] },
          ],
        },
        { siteId: controls[3] },
      ],
    },
  });
  const variants = (await get("course.variantList", { courseId: root })) as Array<{ variantKey: string; courseId: number }>;
  const variantA = variants.find((v) => v.variantKey === "A")!.courseId;
  const classId = (await post("class.create", { name: `E2E RX ${stamp}`, courseId: root })).id as number;
  const name = `Rita Wrongmap ${stamp}`;
  const cardNo = 2900001;
  const runnerId = (await post("runner.create", { name, classId, cardNo, startTime: 360000, courseId: variantA }))
    .id as number;

  try {
    // The read station: mock reader on the admin page, kiosk in a second tab.
    const adminPage = await context.newPage();
    await adminPage.addInitScript(getMockWebSerialScript());
    await selectCompetition(adminPage);
    const kioskPage = await openKioskTab(context, "itest");
    await adminPage.getByTestId("connect-reader").click();
    await expect(adminPage.getByTestId("reader-status")).toBeVisible({ timeout: 5000 });

    const readoutPromise = waitForTrpc(adminPage, "cardReadout.readout");
    const applyPromise = waitForTrpc(adminPage, "cardReadout.applyResult");
    // B's fork (seconds since midnight).
    await adminPage.evaluate(
      ({ cardNo }) => {
        window.__siMock.insertCard(cardNo, [
          { controlCode: 176, time: 36600 },
          { controlCode: 178, time: 36720 },
          { controlCode: 179, time: 36840 },
        ]);
      },
      { cardNo },
    );
    await readoutPromise;

    // The runner's screen: MP, and the pointer to the desk — no accept there.
    await expect(kioskPage.getByText(name)).toBeVisible({ timeout: 10000 });
    await expect(kioskPage.getByText("Missing Punch")).toBeVisible();
    await expect(kioskPage.getByTestId("kiosk-see-official")).toBeVisible();
    await expect(kioskPage.getByTestId("readout-accept-variant")).toHaveCount(0);
    await applyPromise;
    expect((await get("runner.getById", { id: runnerId })).status).toBe(3); // MissingPunch

    // The readout-station page names the variant.
    await page.goto(`/itest/card-readout?card=${cardNo}`);
    const stationBanner = page.getByTestId("readout-other-variant");
    await expect(stationBanner).toBeVisible({ timeout: 15000 });
    await expect(stationBanner).toContainText("variant B");

    // The Runners page's expanded row: the banner above the punch table; Accept.
    await page.goto(`/itest/runners?q=${encodeURIComponent(name)}`);
    await page.getByRole("cell", { name }).click();
    const banner = page.getByTestId("readout-other-variant");
    await expect(banner).toBeVisible({ timeout: 15000 });
    await expect(banner).toContainText(`E2E Red exit ${stamp} B`);
    const accepted = waitForTrpc(page, "cardReadout.acceptVariant");
    await banner.getByTestId("readout-accept-variant").click();
    await accepted;
    await expect(banner).toHaveCount(0, { timeout: 10000 });

    const after = await get("runner.getById", { id: runnerId });
    expect(after.status).toBe(1); // OK
    expect(after.variantKey).toBe("B");

    await page.goto("/itest/startlist");
    await expect(
      page.getByRole("row").filter({ hasText: name }).getByTestId("start-list-variant"),
    ).toHaveText("B", { timeout: 15000 });
  } finally {
    await post("runner.delete", { id: runnerId });
    await post("class.delete", { id: classId });
    await post("course.delete", { id: root });
    for (const id of controls) await post("control.delete", { id });
  }
});
