/**
 * Results page standings (package 13: RES-11, CRS-042).
 *
 * - Two runners on the same time share 1st; the next is 3rd.
 * - A no-timing class shows the "Unofficial" badge and no places.
 * - The "in forest" filter finds a runner with a radio punch and no finish
 *   (resultList used to return no `hasPunches` / `hasStarted`).
 *
 * Fixtures are created in the itest event through the API; statuses and
 * times are written straight to Postgres like `reseed()` does, so the
 * spec does not depend on the readout path. The seed is restored after.
 */

import { test, expect, type Page } from "@playwright/test";
import { Client } from "pg";
import { E2E_DATABASE_URL, reseed } from "./helpers/reseed";

const HEADERS = { "x-competition-id": "itest" };
const ZERO = 324_000; // itest ZeroTime 09:00:00
const T10 = 360_000;
const min = (m: number, s = 0) => (m * 60 + s) * 10;
const stamp = Date.now();
const TIE_CLASS = `E2E Tie ${stamp}`;
const NT_CLASS = `E2E Mini ${stamp}`;
const OUT_CARD = 7_700_000 + (stamp % 10_000);

async function post(page: Page, path: string, data: unknown) {
  const res = await page.request.post(`/trpc/${path}`, { headers: HEADERS, data });
  expect(res.ok(), `${path}: ${await res.text()}`).toBe(true);
  return (await res.json()).result.data;
}

async function sql(text: string, params: unknown[]) {
  const client = new Client({ connectionString: E2E_DATABASE_URL });
  await client.connect();
  try {
    await client.query("SET search_path TO oxygen, public");
    await client.query(text, params);
  } finally {
    await client.end();
  }
}

async function setResult(name: string, status: string, finishAbs: number) {
  await sql(
    `UPDATE runners SET status = $2::oxygen.runner_status, start_time = $3, finish_time = $4
       WHERE name = $1 AND event_id = (SELECT id FROM events WHERE name_id = 'itest')`,
    [name, status, T10 - ZERO, finishAbs - ZERO],
  );
}

test.describe("Results standings", () => {
  test.afterAll(reseed);

  test.beforeAll(async ({ browser }) => {
    const page = await browser.newPage({ baseURL: test.info().project.use.baseURL });
    try {
      const tie = (await post(page, "class.create", { name: TIE_CLASS })).id as number;
      const nt = (await post(page, "class.create", { name: NT_CLASS, noTiming: true })).id as number;
      for (const n of ["Ada", "Bo", "Carl"]) {
        await post(page, "runner.create", { name: `${n} ${stamp}`, classId: tie, startTime: T10 });
      }
      await post(page, "runner.create", { name: `Ida ${stamp}`, classId: nt, startTime: T10 });
      await post(page, "runner.create", { name: `Out ${stamp}`, classId: tie, startTime: T10, cardNo: OUT_CARD });
      await setResult(`Ada ${stamp}`, "ok", T10 + min(45, 12));
      await setResult(`Bo ${stamp}`, "ok", T10 + min(45, 12));
      await setResult(`Carl ${stamp}`, "ok", T10 + min(50));
      await setResult(`Ida ${stamp}`, "no_timing", T10 + min(30));
      await sql(
        `INSERT INTO punches (event_id, card_no, control_code, time, source)
           VALUES ((SELECT id FROM events WHERE name_id = 'itest'), $1, 31, $2, 'online_input')`,
        [OUT_CARD, T10 + min(5) - ZERO],
      );
    } finally {
      await page.close();
    }
  });

  const classBlock = (page: Page, name: string) =>
    page.locator("div.mb-8", { has: page.locator("h3", { hasText: name }) });
  const placeOf = (page: Page, cls: string, runner: string) =>
    classBlock(page, cls).locator("tr", { hasText: runner }).locator("td").first();

  test("tied runners share a place and the next runner is 3rd", async ({ page }) => {
    await page.goto("/itest/results");
    await expect(classBlock(page, TIE_CLASS)).toBeVisible({ timeout: 10000 });
    await expect(placeOf(page, TIE_CLASS, `Ada ${stamp}`)).toHaveText("1");
    await expect(placeOf(page, TIE_CLASS, `Bo ${stamp}`)).toHaveText("1");
    await expect(placeOf(page, TIE_CLASS, `Carl ${stamp}`)).toHaveText("3");
  });

  test("a no-timing class is marked Unofficial and unplaced", async ({ page }) => {
    await page.goto("/itest/results");
    const block = classBlock(page, NT_CLASS);
    await expect(block).toBeVisible({ timeout: 10000 });
    await expect(block.getByText("Unofficial")).toBeVisible();
    await expect(placeOf(page, NT_CLASS, `Ida ${stamp}`)).toHaveText("-");
    await expect(block.locator("tr", { hasText: `Ida ${stamp}` })).toContainText("30:00");
  });

  test("the in-forest filter finds a runner with a radio punch and no finish", async ({ page }) => {
    await page.goto("/itest/results?q=status:in-forest");
    await expect(page.getByText(`Out ${stamp}`)).toBeVisible({ timeout: 10000 });
    await expect(page.getByText(`Ada ${stamp}`)).toHaveCount(0);
  });
});
